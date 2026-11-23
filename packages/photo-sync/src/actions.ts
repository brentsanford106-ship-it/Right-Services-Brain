import { ApiError, NetworkError } from "./api";
import type { PhotoQueue } from "./queue";
import type { Vault } from "./vault";

/**
 * Drawings and issue changes made with no signal wait here (encrypted, in the same offline store as photos)
 * until they reach the server, in the order they were made. Each carries its phone-made ids (clientRef), so
 * sending one twice only applies it once.
 *
 * Issue changes also carry the status the person saw. If the issue changed on the server in the meantime,
 * the server refuses it (nothing is changed) and the item waits here with the server's explanation, for the
 * person to look at and then Try again or Discard. Nothing is ever thrown away without the person choosing to.
 */

export type ActionKind = "markup_changes" | "issue_report" | "issue_action";

export interface PendingAction {
  /** Phone-made id of this waiting item (not sent). */
  localId: string;
  orgId: string;
  jobId: string;
  /** Server id of the photo (these changes are only made on photos that already reached the server). */
  photoId: string;
  kind: ActionKind;
  /** For issue_action: the issue. */
  issueId: string | null;
  /** What is sent, including its clientRef(s). */
  body: Record<string, unknown>;
  /** Shown to the person, e.g. "Approve fix" or "Drawing (2 marks)". */
  label: string;
  createdAt: string;
  /** Order made on this phone (several can share the same second). */
  seq: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** Sending again won't help as is. The person chooses Try again or Discard. */
  needsAttention: boolean;
}

export interface ActionApi {
  post(path: string, body: unknown): Promise<unknown>;
}

const PREFIX = "pa-";
const name = (id: string) => `${PREFIX}${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function actionPath(a: Pick<PendingAction, "orgId" | "photoId" | "kind" | "issueId">): string {
  const org = `/v1/orgs/${a.orgId}`;
  if (a.kind === "markup_changes") return `${org}/photos/${a.photoId}/markups/changes`;
  if (a.kind === "issue_report") return `${org}/photos/${a.photoId}/issues`;
  if (!a.issueId) throw new Error("issue_action needs an issue");
  return `${org}/photo-issues/${a.issueId}/actions`;
}

function friendly(e: ApiError, kind: ActionKind): string {
  if (e.status === 404) return "The photo or issue is no longer available to you.";
  if (e.status === 403) return e.message || "Your account isn't allowed to do this any more.";
  if (e.status === 409) return e.message; // e.g. "This issue changed while you were away: it is now …"
  if (e.status === 400) return `The server didn't accept this ${kind === "markup_changes" ? "drawing" : "change"}: ${e.message}`;
  return e.message;
}

export class ActionOutbox {
  private items = new Map<string, PendingAction>();
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly vault: Vault,
    queue: PhotoQueue,
    private readonly opts: { now?: () => number; uuid: () => string; random?: () => number },
  ) {
    // Signing in as someone else must never throw away their unsent changes.
    queue.addUnsentCheck(() => this.items.size > 0);
    queue.onWipe(() => {
      this.items.clear();
      this.emit();
    });
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  async load(): Promise<void> {
    return this.exclusive(async () => {
      this.items.clear();
      for (const n of await this.vault.list()) {
        if (!n.startsWith(PREFIX)) continue;
        const a = await this.vault.getJson<PendingAction>(n);
        if (a) this.items.set(a.localId, a);
      }
      this.emit();
    });
  }

  all(): PendingAction[] {
    return [...this.items.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.createdAt.localeCompare(b.createdAt));
  }

  forPhoto(photoId: string | null, kind?: ActionKind): PendingAction[] {
    return this.all().filter((a) => a.photoId === photoId && (!kind || a.kind === kind));
  }

  forIssue(issueId: string): PendingAction[] {
    return this.all().filter((a) => a.kind === "issue_action" && a.issueId === issueId);
  }

  counts(): { waiting: number; needsAttention: number } {
    const all = this.all();
    return { waiting: all.filter((a) => !a.needsAttention).length, needsAttention: all.filter((a) => a.needsAttention).length };
  }

  async add(input: { orgId: string; jobId: string; photoId: string; kind: ActionKind; issueId?: string | null; body: Record<string, unknown>; label: string }): Promise<PendingAction> {
    if (!UUID.test(input.photoId)) throw new Error("Which photo is this for?");
    if (input.kind === "issue_action" && !input.issueId) throw new Error("Which issue is this for?");
    if (input.kind !== "markup_changes" && typeof input.body.clientRef !== "string") throw new Error("A clientRef is needed so it is only applied once.");
    const localId = this.opts.uuid();
    if (!UUID.test(localId)) throw new Error("uuid() must return a lowercase UUID");
    const a: PendingAction = {
      localId, orgId: input.orgId, jobId: input.jobId, photoId: input.photoId, kind: input.kind, issueId: input.issueId ?? null,
      body: input.body, label: input.label, createdAt: new Date(this.now()).toISOString(),
      seq: Math.max(this.now(), ...[...this.items.values()].map((x) => (x.seq ?? 0) + 1)),
      attempts: 0, nextAttemptAt: 0, lastError: null, needsAttention: false,
    };
    return this.exclusive(async () => {
      await this.vault.putJson(name(localId), a);
      this.items.set(localId, a);
      this.emit();
      return a;
    });
  }

  private async save(a: PendingAction): Promise<void> {
    await this.exclusive(async () => {
      if (!this.items.has(a.localId)) return;
      await this.vault.putJson(name(a.localId), a);
      this.items.set(a.localId, a);
      this.emit();
    });
  }

  private async drop(localId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.vault.remove(name(localId));
      this.items.delete(localId);
      this.emit();
    });
  }

  async retry(localId: string): Promise<void> {
    const a = this.items.get(localId);
    if (a) await this.save({ ...a, needsAttention: false, attempts: 0, nextAttemptAt: 0, lastError: null });
  }

  /** The person chose to throw it away. Never automatic. */
  async discard(localId: string): Promise<void> {
    await this.drop(localId);
  }

  /**
   * Sends waiting items oldest first. Items for the same issue (or drawings on the same photo) never overtake each
   * other: once one of them is waiting or needs attention, the later ones wait too.
   */
  async flush(api: ActionApi, force = false): Promise<{ sent: number; stoppedBecause: "offline" | "sign_in_required" | null }> {
    let sent = 0;
    const blocked = new Set<string>();
    const lane = (a: PendingAction) => (a.kind === "issue_action" ? `i:${a.issueId}` : a.kind === "markup_changes" ? `m:${a.photoId}` : `r:${a.localId}`);
    for (const item of this.all()) {
      const a = this.items.get(item.localId);
      if (!a) continue;
      if (blocked.has(lane(a))) continue;
      if (a.needsAttention || (!force && a.nextAttemptAt > this.now())) {
        blocked.add(lane(a));
        continue;
      }
      try {
        await api.post(actionPath(a), a.body);
        await this.drop(a.localId);
        sent++;
      } catch (e) {
        blocked.add(lane(a));
        if (e instanceof NetworkError) {
          await this.save({ ...a, attempts: a.attempts + 1, nextAttemptAt: this.now() + 15_000, lastError: e.message });
          return { sent, stoppedBecause: "offline" };
        }
        if (e instanceof ApiError) {
          if (e.status === 401) return { sent, stoppedBecause: "sign_in_required" };
          if (e.status === 408 || e.status === 429 || e.status >= 500) {
            const delay = Math.min(30 * 60_000, 15_000 * 2 ** a.attempts) * (0.75 + (this.opts.random ?? Math.random)() * 0.5);
            await this.save({ ...a, attempts: a.attempts + 1, nextAttemptAt: this.now() + Math.round(delay), lastError: "Server busy. Will retry." });
            continue;
          }
          await this.save({ ...a, attempts: a.attempts + 1, needsAttention: true, lastError: friendly(e, a.kind) });
          continue;
        }
        await this.save({ ...a, attempts: a.attempts + 1, needsAttention: true, lastError: e instanceof Error ? e.message : "Unexpected error." });
      }
    }
    return { sent, stoppedBecause: null };
  }
}
