import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Network from "expo-network";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import Constants from "expo-constants";
import { Image } from "expo-image";
import {
  ApiError,
  HttpClient,
  NetworkError,
  OwnerMismatchError,
  PhotoQueue,
  CommentOutbox,
  ActionOutbox,
  SyncEngine,
  Vault,
  type FetchLike,
  type SyncStatus,
} from "@rsb/photo-sync";
import { ExpoBlobStore, ExpoCipher, clearScratch, deleteQuietly, scratchDir } from "./platform";
import * as entra from "./entra";

/** What we remember between app launches (kept in the iOS Keychain). No passwords; the dev token is never stored. */
export interface Session {
  subject: string;
  displayName: string;
  orgId: string;
  orgName: string;
  permissions: string[];
  /** "entra" = real Microsoft sign-in. Missing or "dev" = the development sign-in (test people only). */
  mode?: "dev" | "entra";
  /** Real sign-in: when the person last signed in on Microsoft's page (ms since 1970). */
  signedInAt?: number;
  /** The company's rule: sign in again after this many days. */
  signInEveryDays?: number;
  /** This person's id in the company, and when their profile picture last changed (null = none). */
  membershipId?: string;
  avatarAt?: string | null;
}

type OrgCtx = { permissions: string[]; signInEveryDays?: number; membershipId?: string; avatarAt?: string | null };

type Who = { subject: string; displayName: string; mode: "dev" | "entra"; signedInAt?: number };
const DAY_MS = 24 * 3600_000;

export interface Job {
  id: string;
  jobNumber: string;
  title: string;
  status: string;
  siteName: string | null;
  siteAddress: string | null;
}

const SESSION_KEY = "rsb.session.v1";
const SERVER_KEY = "rsb.server.v1";
const OPTS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const SYNC_EVERY_MS = 60_000;
const KEEP_SYNCED_DETAILS_MS = 7 * 24 * 3600_000;

/**
 * During development the app is loaded from the PC that also runs the server, so use that PC's address
 * (port 4000) unless an address is set explicitly. You can still change it on the sign-in screen.
 */
function guessServer(): string {
  const host = Constants.expoConfig?.hostUri?.split(":")[0];
  if (host && /^[0-9.]+$/.test(host)) return `http://${host}:4000`;
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://192.168.1.10:4000";
}
export const DEFAULT_SERVER = guessServer();

const fetchLike: FetchLike = async (url, init) => {
  const res = await expoFetch(url, { method: init.method, headers: init.headers, body: init.body as string | undefined, signal: init.signal });
  return { status: res.status, ok: res.ok, text: () => res.text() };
};

/**
 * Sends the image with iOS's native uploader. "background" lets iOS finish a transfer that
 * is already under way if the app is put in the background. The file sent is a temporary
 * decrypted copy in the app's private cache, deleted as soon as the upload ends.
 */
async function putBytes(url: string, headers: Record<string, string>, bytes: Uint8Array) {
  const tmp = new File(scratchDir(), `up-${Crypto.randomUUID()}.jpg`);
  try {
    tmp.create();
    await tmp.write(bytes);
    const res = await tmp.upload(url, { httpMethod: "PUT", headers, mimeType: headers["content-type"], sessionType: "background" });
    return { status: res.status, ok: res.status >= 200 && res.status < 300, text: async () => res.body };
  } finally {
    deleteQuietly(tmp.uri);
  }
}

export interface PendingInvite {
  inviteId: string;
  organizationId: string;
  organizationName: string;
  roles: string[];
  invitedBy: string;
  expiresAt: string;
}
export interface SignInResult {
  orgs: { organizationId: string; organizationName: string }[];
  /** Companies that added this person; they join only by pressing Accept. */
  invites: PendingInvite[];
}
type MeBody = { user?: { displayName?: string }; memberships: { organizationId: string; organizationName: string }[]; invites?: PendingInvite[] };

interface Ctx {
  ready: boolean;
  /** The vault key or files could not be read. Shown as a blocking error; nothing is deleted automatically. */
  fatal: string | null;
  server: string;
  setServer(url: string): Promise<void>;
  session: Session | null;
  api: HttpClient;
  queue: PhotoQueue;
  /** Comments written on this phone, waiting to be sent (encrypted, like photos). */
  comments: CommentOutbox;
  /** Drawings and issue changes made with no signal. */
  actions: ActionOutbox;
  engine: SyncEngine;
  online: boolean;
  signIn(subject: string, displayName: string): Promise<SignInResult>;
  /** Real sign-in with Microsoft. Returns null if the person closed the sign-in page. */
  signInReal(): Promise<SignInResult | null>;
  /** Accept or decline a company's invite (after signing in, before choosing a company). Returns the updated lists. */
  respondToInvite(inviteId: string, accept: boolean): Promise<SignInResult>;
  /** Set when real sign-in has expired; the person must sign in again. Unsent photos are kept. */
  notice: string | null;
  chooseOrg(orgId: string, orgName: string): Promise<void>;
  signOut(): Promise<void>;
  syncNow(): void;
  can(permission: string): boolean;
  /** Re-reads this person's permissions from the server (an owner may have changed their roles). Quietly does nothing offline. */
  refreshPermissions(): Promise<void>;
  /** Current access token, for loading server images with an Authorization header. */
  token(): Promise<string | null>;
  /** Encrypted offline copy of lists fetched from the server (jobs, photo details), so screens work without signal. */
  cache: { get<T>(key: string): Promise<T | null>; put(key: string, value: unknown): Promise<void> };
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

/** Re-renders when the photo queue changes. */
export function useQueueVersion(): number {
  const { queue } = useApp();
  const ver = useRef(0);
  return useSyncExternalStore(
    (cb) => queue.subscribe(() => { ver.current++; cb(); }),
    () => ver.current,
  );
}

/** Re-renders when the waiting-comments list changes. */
export function useCommentsVersion(): number {
  const { comments } = useApp();
  const ver = useRef(0);
  return useSyncExternalStore(
    (cb) => comments.subscribe(() => { ver.current++; cb(); }),
    () => ver.current,
  );
}

/** Re-renders when the waiting drawings / issue changes list changes. */
export function useActionsVersion(): number {
  const { actions } = useApp();
  const ver = useRef(0);
  return useSyncExternalStore(
    (cb) => actions.subscribe(() => { ver.current++; cb(); }),
    () => ver.current,
  );
}

export function useSyncStatus(): SyncStatus {
  const { engine } = useApp();
  return useSyncExternalStore((cb) => engine.subscribe(cb), () => engine.getStatus());
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const [server, setServerState] = useState(DEFAULT_SERVER);
  const [session, setSession] = useState<Session | null>(null);
  const [online, setOnline] = useState(true);
  const serverRef = useRef(server);
  const sessionRef = useRef<Session | null>(null);
  const pendingSubject = useRef<Who | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const token = useRef<{ value: string; expiresAt: number; subject: string } | null>(null);
  const holder = useRef<{ queue: PhotoQueue; comments: CommentOutbox; actions: ActionOutbox; engine: SyncEngine; api: HttpClient; vault: Vault } | null>(null);

  const issueDevToken = useCallback(async (subject: string): Promise<string> => {
    let res;
    try {
      res = await fetchLike(`${serverRef.current}/dev/auth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject }),
      });
    } catch {
      throw new NetworkError();
    }
    const text = await res.text();
    if (!res.ok) {
      const err = text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }).error : undefined;
      throw new ApiError(res.status, err?.code ?? "error", err?.message ?? "Sign-in failed.");
    }
    const body = JSON.parse(text) as { accessToken: string; expiresIn: number };
    token.current = { value: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000, subject };
    return body.accessToken;
  }, []);

  // Real sign-in: a fresh access token comes from Microsoft using the refresh token in the Keychain.
  // DEVELOPMENT sign-in: a fresh 15-minute token is requested from the dev server whenever needed.
  const getToken = useCallback(async (): Promise<string | null> => {
    const subject = sessionRef.current?.subject ?? pendingSubject.current?.subject;
    const mode = sessionRef.current?.mode ?? pendingSubject.current?.mode ?? "dev";
    if (!subject) return null;
    const t = token.current;
    if (t && t.subject === subject && t.expiresAt - Date.now() > 60_000) return t.value;
    if (mode === "entra") {
      try {
        const r = await entra.refresh();
        if ("entra:" + r.subject !== subject) throw new entra.SignInExpired("Please sign in again.");
        // The company's "sign in again every N days" rule. Checked only here, right after Microsoft answered,
        // so it never applies while offline: taking photos without signal is never interrupted.
        const s = sessionRef.current;
        if (s?.signedInAt && s.signInEveryDays && Date.now() - s.signedInAt > s.signInEveryDays * DAY_MS) {
          await expireRef.current?.(`Your company asks everyone to sign in again every ${s.signInEveryDays === 1 ? "day" : `${s.signInEveryDays} days`}. Photos not yet sent are still on this phone.`);
          return null;
        }
        token.current = { value: r.accessToken, expiresAt: r.expiresAt, subject };
        return r.accessToken;
      } catch (e) {
        if (e instanceof entra.SignInExpired) {
          await expireRef.current?.();
          return null;
        }
        throw new NetworkError();
      }
    }
    try {
      return await issueDevToken(subject);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // The account was disabled or removed: lock this phone out, keeping photos that haven't been sent.
        await lockOutRef.current?.();
        return null;
      }
      throw e;
    }
  }, [issueDevToken]);

  const expireRef = useRef<((message?: string) => Promise<void>) | null>(null);
  const lockOutRef = useRef<(() => Promise<void>) | null>(null);

  if (!holder.current) {
    // Created synchronously so screens always have objects to use; the vault is opened in the effect below.
    const api = new HttpClient({ baseUrl: serverRef.current, getToken, fetch: fetchLike, putBytes });
    const vault = new Vault(new ExpoBlobStore(), { seal: async () => { throw new Error("not ready"); }, open: async () => { throw new Error("not ready"); } });
    const queue = new PhotoQueue(vault, { uuid: Crypto.randomUUID });
    const comments = new CommentOutbox(vault, queue, { uuid: Crypto.randomUUID });
    const actions = new ActionOutbox(vault, queue, { uuid: Crypto.randomUUID });
    holder.current = { api, vault, queue, comments, actions, engine: new SyncEngine(queue, api, { comments, actions }) };
  }

  const rebuild = useCallback((cipher: ExpoCipher, base: string) => {
    const api = new HttpClient({ baseUrl: base, getToken, fetch: fetchLike, putBytes });
    const vault = new Vault(new ExpoBlobStore(), cipher);
    const queue = new PhotoQueue(vault, { uuid: Crypto.randomUUID });
    const comments = new CommentOutbox(vault, queue, { uuid: Crypto.randomUUID });
    const actions = new ActionOutbox(vault, queue, { uuid: Crypto.randomUUID });
    holder.current = { api, vault, queue, comments, actions, engine: new SyncEngine(queue, api, { comments, actions }) };
    return holder.current;
  }, [getToken]);

  const [, force] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        clearScratch(); // unencrypted leftovers from a shot, upload or share interrupted by the app closing
        const savedServer = await SecureStore.getItemAsync(SERVER_KEY, OPTS);
        if (savedServer) {
          serverRef.current = savedServer;
          setServerState(savedServer);
        }
        const cipher = await ExpoCipher.load();
        const h = rebuild(cipher, serverRef.current);
        await h.queue.load();
        await h.comments.load();
        await h.actions.load();
        await h.queue.pruneSynced(KEEP_SYNCED_DETAILS_MS);
        const raw = await SecureStore.getItemAsync(SESSION_KEY, OPTS);
        if (raw) {
          const s = JSON.parse(raw) as Session;
          sessionRef.current = s;
          setSession(s);
        }
        force((n) => n + 1);
      } catch (e) {
        setFatal(e instanceof Error ? e.message : "The app's secure storage could not be opened.");
      } finally {
        setReady(true);
      }
    })();
  }, [rebuild]);

  const syncNow = useCallback((forceRun = true) => {
    if (!sessionRef.current || !holder.current) return;
    void holder.current.engine.run({ force: forceRun }).catch(() => undefined);
  }, []);

  // Sync triggers: connection comes back, app comes to the front, and a timer while the app is open.
  useEffect(() => {
    const net = Network.addNetworkStateListener((s) => {
      const up = s.isConnected === true && s.isInternetReachable !== false;
      setOnline(up);
      if (up) syncNow(true);
    });
    void Network.getNetworkStateAsync().then((s) => setOnline(s.isConnected === true && s.isInternetReachable !== false));
    const app = AppState.addEventListener("change", (st) => {
      if (st === "active") syncNow(true);
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") syncNow(false);
    }, SYNC_EVERY_MS);
    return () => {
      net.remove();
      app.remove();
      clearInterval(timer);
    };
  }, [syncNow]);

  useEffect(() => {
    if (session && ready) syncNow(true);
  }, [session, ready, syncNow]);

  const wipeAll = useCallback(async () => {
    await entra.forget().catch(() => undefined);
    await holder.current?.queue.wipe();
    await ExpoCipher.destroyKey(); // crypto-shred: even a missed file can no longer be decrypted
    clearScratch(); // and remove any unencrypted temporary copies
    // Company walls on a shared phone: forget photos shown from the server, so the next person can't see them.
    await Image.clearMemoryCache().catch(() => false);
    await Image.clearDiskCache().catch(() => false);
    await SecureStore.deleteItemAsync(SESSION_KEY, OPTS);
    token.current = null;
    sessionRef.current = null;
    pendingSubject.current = null;
    setSession(null);
    const cipher = await ExpoCipher.load(); // fresh key for the next person
    const h = rebuild(cipher, serverRef.current);
    await h.queue.load();
    await h.comments.load();
    await h.actions.load();
    force((n) => n + 1);
  }, [rebuild]);

  // Real sign-in ran out (for example after a long time without opening the app). Unlike signing out or
  // being removed, the person's unsent photos stay encrypted on the phone and upload after they sign in again.
  const expire = useCallback(async (message?: string) => {
    await entra.forget().catch(() => undefined);
    await SecureStore.deleteItemAsync(SESSION_KEY, OPTS);
    token.current = null;
    sessionRef.current = null;
    pendingSubject.current = null;
    setSession(null);
    setNotice(message ?? "Your sign-in has expired. Please sign in again. Photos not yet sent are still on this phone.");
  }, []);
  expireRef.current = expire;

  // Suspended or removed from the company (JB's decision 2026-11-23: never delete photos that haven't been sent).
  // Photos not yet sent stay on the phone, still encrypted, and upload if this person's access is turned back on and
  // they sign in again. Everything else from the company (saved lists, photos shown from the server) is removed now.
  // With nothing waiting to upload, it's a normal full sign-out.
  const lockOut = useCallback(async () => {
    const h = holder.current;
    const unsent = h?.queue.pending().length ?? 0;
    const unsentComments = h?.comments.all().length ?? 0;
    const unsentChanges = h?.actions.all().length ?? 0;
    if (!h || (unsent === 0 && unsentComments === 0 && unsentChanges === 0)) {
      await wipeAll();
      setNotice("Your access to this company was turned off. Ask an owner if this is a mistake.");
      return;
    }
    await entra.forget().catch(() => undefined);
    for (const name of await h.vault.list()) {
      if (name.startsWith("c-")) await h.vault.remove(name).catch(() => undefined); // saved company lists
    }
    await Image.clearMemoryCache().catch(() => false);
    await Image.clearDiskCache().catch(() => false);
    clearScratch();
    await SecureStore.deleteItemAsync(SESSION_KEY, OPTS);
    token.current = null;
    sessionRef.current = null;
    pendingSubject.current = null;
    setSession(null);
    const what = [
      unsent ? `${unsent} photo${unsent === 1 ? "" : "s"}` : null,
      unsentComments ? `${unsentComments} comment${unsentComments === 1 ? "" : "s"}` : null,
      unsentChanges ? `${unsentChanges} drawing or issue change${unsentChanges === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(" and ");
    const n = unsent + unsentComments + unsentChanges;
    setNotice(
      `Your access to this company was turned off. ${what} that ${n === 1 ? "hasn't" : "haven't"} been sent ${n === 1 ? "is" : "are"} kept locked on this phone. ` +
        "If an owner turns your access back on, sign in again and they will upload.",
    );
  }, [wipeAll]);
  lockOutRef.current = lockOut;

  const value = useMemo<Ctx>(() => {
    const h = holder.current!;
    return {
      ready,
      fatal,
      server,
      session,
      online,
      api: h.api,
      queue: h.queue,
      comments: h.comments,
      actions: h.actions,
      engine: h.engine,
      async setServer(url: string) {
        const clean = url.trim().replace(/\/+$/, "");
        if (!/^https?:\/\/[^\s/]+$/.test(clean)) throw new Error("Enter an address like http://192.168.1.20:4000");
        serverRef.current = clean;
        setServerState(clean);
        await SecureStore.setItemAsync(SERVER_KEY, clean, OPTS);
        const cipher = await ExpoCipher.load();
        const nh = rebuild(cipher, clean);
        await nh.queue.load();
        await nh.comments.load();
        await nh.actions.load();
        force((n) => n + 1);
      },
      async signIn(subject: string, displayName: string) {
        const q = holder.current!.queue;
        const owner = q.getOwner();
        if (owner && owner.subject !== subject && q.hasUnsent()) throw new OwnerMismatchError(owner);
        pendingSubject.current = { subject, displayName, mode: "dev" };
        token.current = null;
        await issueDevToken(subject);
        const me = await holder.current!.api.get<MeBody>("/v1/me");
        return { orgs: me.memberships, invites: me.invites ?? [] };
      },
      notice,
      async signInReal() {
        const r = await entra.signInInteractive();
        if (!r) return null;
        const subject = "entra:" + r.subject;
        const q = holder.current!.queue;
        const owner = q.getOwner();
        if (owner && owner.subject !== subject && q.hasUnsent()) {
          await entra.forget();
          throw new OwnerMismatchError(owner);
        }
        pendingSubject.current = { subject, displayName: r.name ?? "Me", mode: "entra", signedInAt: Date.now() };
        token.current = { value: r.accessToken, expiresAt: r.expiresAt, subject };
        setNotice(null);
        try {
          const me = await holder.current!.api.get<MeBody>("/v1/me");
          if (me.user?.displayName) pendingSubject.current.displayName = me.user.displayName;
          return { orgs: me.memberships, invites: me.invites ?? [] };
        } catch (e) {
          // Not added to a company (401): don't keep their Microsoft sign-in on this phone.
          if (e instanceof ApiError && e.status === 401) {
            await entra.forget();
            pendingSubject.current = null;
            token.current = null;
          }
          throw e;
        }
      },
      async respondToInvite(inviteId: string, accept: boolean) {
        await holder.current!.api.post(`/v1/invites/${inviteId}/${accept ? "accept" : "decline"}`, {});
        const me = await holder.current!.api.get<MeBody>("/v1/me");
        return { orgs: me.memberships, invites: me.invites ?? [] };
      },
      async chooseOrg(orgId: string, orgName: string) {
        const cur = sessionRef.current;
        const p: Who | null =
          pendingSubject.current ??
          (cur ? { subject: cur.subject, displayName: cur.displayName, mode: cur.mode ?? "dev", ...(cur.signedInAt ? { signedInAt: cur.signedInAt } : {}) } : null);
        if (!p) throw new Error("Sign in first.");
        const ctx = await holder.current!.api.get<OrgCtx>(`/v1/orgs/${orgId}`);
        await holder.current!.queue.claim({ subject: p.subject, displayName: p.displayName });
        // A fresh sign-in may come with access turned back on (for example after a suspension): try photos that were
        // refused before once more. Anything still refused simply goes back to "needs attention".
        for (const item of holder.current!.queue.all()) {
          if (item.needsAttention) await holder.current!.queue.retry(item.localId);
        }
        const s: Session = {
          subject: p.subject,
          displayName: p.displayName,
          orgId,
          orgName,
          permissions: ctx.permissions,
          mode: p.mode,
          ...(p.signedInAt ? { signedInAt: p.signedInAt } : {}),
          ...(ctx.signInEveryDays ? { signInEveryDays: ctx.signInEveryDays } : {}),
          ...(ctx.membershipId ? { membershipId: ctx.membershipId } : {}),
          avatarAt: ctx.avatarAt ?? null,
        };
        await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s), OPTS);
        sessionRef.current = s;
        pendingSubject.current = null;
        setSession(s);
      },
      signOut: wipeAll,
      syncNow: () => syncNow(true),
      can: (perm: string) => !!session?.permissions.includes(perm),
      async refreshPermissions() {
        const cur = sessionRef.current;
        if (!cur) return;
        try {
          const ctx = await holder.current!.api.get<OrgCtx>(`/v1/orgs/${cur.orgId}`);
          const next = [...ctx.permissions].sort();
          const every = ctx.signInEveryDays ?? cur.signInEveryDays;
          const avatarAt = ctx.avatarAt ?? null;
          const membershipId = ctx.membershipId ?? cur.membershipId;
          if (
            JSON.stringify(next) === JSON.stringify([...cur.permissions].sort()) && every === cur.signInEveryDays &&
            avatarAt === (cur.avatarAt ?? null) && membershipId === cur.membershipId
          ) return;
          const s: Session = { ...cur, permissions: next, ...(every ? { signInEveryDays: every } : {}), ...(membershipId ? { membershipId } : {}), avatarAt };
          await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s), OPTS);
          sessionRef.current = s;
          setSession(s);
        } catch (e) {
          // Removed from this company (404): wipe this phone's copy of company data. A 401 is NOT treated as
          // removal here, because it can also mean a passing sign-in problem, and a wipe loses unsent photos.
          // Only our own server's "not found" counts (it always carries a request id); a 404 page from Wi-Fi or Azure
          // in between must never wipe unsent photos.
          if (e instanceof ApiError && e.status === 404 && e.code === "not_found" && !!e.requestId && sessionRef.current) {
            await lockOutRef.current?.();
            return;
          }
          // Offline: keep what we have. The server still checks every action.
        }
      },
      token: () => getToken().catch(() => null),
      cache: {
        async get<T>(key: string) {
          if (!session) return null;
          try {
            return await holder.current!.vault.getJson<T>(`c-${session.orgId}-${key}`);
          } catch {
            return null;
          }
        },
        async put(key: string, value: unknown) {
          if (session) await holder.current!.vault.putJson(`c-${session.orgId}-${key}`, value);
        },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fatal, server, session, online, notice, rebuild, issueDevToken, wipeAll, syncNow, getToken, holder.current]);

  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
