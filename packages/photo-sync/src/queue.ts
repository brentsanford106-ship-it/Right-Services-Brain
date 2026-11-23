import { Vault } from "./vault";

export type Stage = "before" | "during" | "after";

/** What the person sees for each photo. */
export type SyncState = "waiting" | "uploading" | "synced" | "needs_attention";

export interface Location {
  latitude: number;
  longitude: number;
  accuracyM?: number | null;
}

/** One photo's details as kept on the phone (stored encrypted). */
export interface QueuedPhoto {
  /** Device-generated id. Also sent to the server as clientRef, which makes retries safe. */
  localId: string;
  orgId: string;
  jobId: string;
  jobNumber: string;
  stage: Stage;
  note: string | null;
  flagged: boolean;
  capturedAt: string;
  contentType: "image/jpeg";
  location: Location | null;
  widthPx: number | null;
  heightPx: number | null;
  byteLength: number;
  /** "imported" = added from the phone's photo library. Missing on photos saved by older app versions = in-app camera. */
  captureSource?: CaptureSource;
  /** Imported photos only: false when the file had no "date taken" (capturedAt is then when it was added). */
  capturedAtKnown?: boolean;
  /** Server id once the record exists on the server. */
  serverId: string | null;
  /** Step 1 done: the server has the photo's details. */
  recorded: boolean;
  /** Step 2 done: the server has the image file. */
  stored: boolean;
  /** Flag/note/stage changes that the server has not confirmed yet. */
  dirty: boolean;
  /** Bumped on every local edit, so an edit made during an upload is never lost. */
  editVersion: number;
  /** True for a photo that came from the server (e.g. someone else's), edited offline here. No local file. */
  remoteOnly: boolean;
  /** The full-resolution file is still on the phone. Removed only after the server confirms it has it. */
  originalOnDevice: boolean;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** Retrying automatically will not help (e.g. job no longer accessible). Needs the person to act. */
  needsAttention: boolean;
  syncedAt: string | null;
}

export type CaptureSource = "in_app_camera" | "imported";

export interface CaptureInput {
  orgId: string;
  jobId: string;
  jobNumber: string;
  stage: Stage;
  flagged?: boolean;
  note?: string | null;
  capturedAt: string;
  original: Uint8Array;
  thumbnail: Uint8Array;
  widthPx?: number | null;
  heightPx?: number | null;
  location?: Location | null;
  /** Default: taken with the app's camera. */
  captureSource?: CaptureSource;
  capturedAtKnown?: boolean;
}

export interface PhotoEdit {
  flagged?: boolean;
  note?: string | null;
  stage?: Stage;
}

export interface OwnerInfo {
  /** Stable id of the signed-in person (identity provider subject). */
  subject: string;
  displayName: string;
}

export const NOTE_MAX = 2000;
const recName = (id: string) => `r-${id}`;
export const originalName = (id: string) => `o-${id}`;
export const thumbName = (id: string) => `t-${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function syncStateOf(p: QueuedPhoto, uploadingId: string | null): SyncState {
  if (p.needsAttention) return "needs_attention";
  if (p.recorded && p.stored && !p.dirty) return "synced";
  if (uploadingId === p.localId) return "uploading";
  return "waiting";
}

export class OwnerMismatchError extends Error {
  constructor(public readonly owner: OwnerInfo) {
    super(`This phone has photos from ${owner.displayName} that have not uploaded yet.`);
    this.name = "OwnerMismatchError";
  }
}

/**
 * The offline photo queue. Each photo is stored as three encrypted files:
 * the original (o-), a small thumbnail (t-), and its details (r-). The details file is
 * written last, so a photo only "exists" once its image is safely on disk.
 */
export class PhotoQueue {
  private items = new Map<string, QueuedPhoto>();
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private owner: OwnerInfo | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly opts: { now?: () => number; uuid: () => string },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Serializes all writes so two edits can't interleave. */
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

  /** Loads the queue from disk. Removes leftovers of captures interrupted before their details were saved. */
  async load(): Promise<void> {
    return this.exclusive(async () => {
      this.items.clear();
      this.owner = await this.vault.getJson<OwnerInfo>("owner");
      const names = await this.vault.list();
      const ids = new Set<string>();
      for (const n of names) {
        if (!n.startsWith("r-")) continue;
        const rec = await this.vault.getJson<QueuedPhoto>(n);
        if (rec) {
          this.items.set(rec.localId, rec);
          ids.add(rec.localId);
        }
      }
      for (const n of names) {
        const m = /^[ot]-(.+)$/.exec(n);
        if (m && !ids.has(m[1]!)) await this.vault.remove(n); // capture never finished; the person never saw it as saved
      }
      this.emit();
    });
  }

  getOwner(): OwnerInfo | null {
    return this.owner;
  }

  /**
   * Binds the queue to the person signing in. If photos from someone else are still
   * waiting to upload, sign-in as a different person is refused instead of mixing them.
   */
  async claim(owner: OwnerInfo): Promise<void> {
    return this.exclusive(async () => {
      if (this.owner && this.owner.subject !== owner.subject) {
        const unsynced = [...this.items.values()].some((p) => !(p.recorded && p.stored && !p.dirty));
        if (unsynced) throw new OwnerMismatchError(this.owner);
        await this.vault.wipe();
        this.items.clear();
      }
      this.owner = owner;
      await this.vault.putJson("owner", owner);
      this.emit();
    });
  }

  all(): QueuedPhoto[] {
    return [...this.items.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.localId.localeCompare(b.localId));
  }

  forJob(jobId: string): QueuedPhoto[] {
    return this.all().filter((p) => p.jobId === jobId);
  }

  get(localId: string): QueuedPhoto | undefined {
    return this.items.get(localId);
  }

  findByServerId(serverId: string): QueuedPhoto | undefined {
    return [...this.items.values()].find((p) => p.serverId === serverId);
  }

  pending(): QueuedPhoto[] {
    return this.all().filter((p) => !(p.recorded && p.stored && !p.dirty));
  }

  counts(): { waiting: number; needsAttention: number; synced: number } {
    let waiting = 0, needsAttention = 0, synced = 0;
    for (const p of this.items.values()) {
      if (p.needsAttention) needsAttention++;
      else if (p.recorded && p.stored && !p.dirty) synced++;
      else waiting++;
    }
    return { waiting, needsAttention, synced };
  }

  /** Saves a new photo. Returns only after the encrypted image and details are on disk. */
  async capture(input: CaptureInput): Promise<QueuedPhoto> {
    if (!this.owner) throw new Error("Sign in before taking photos.");
    if (input.note && input.note.length > NOTE_MAX) throw new Error("Note is too long.");
    if (input.capturedAtKnown === false && input.captureSource !== "imported") throw new Error("Photos taken in the app always know when they were taken.");
    const localId = this.opts.uuid().toLowerCase();
    if (!UUID.test(localId)) throw new Error("uuid generator returned an invalid id");
    const rec: QueuedPhoto = {
      localId,
      orgId: input.orgId,
      jobId: input.jobId,
      jobNumber: input.jobNumber,
      stage: input.stage,
      note: input.note?.trim() ? input.note.trim() : null,
      flagged: input.flagged ?? false,
      capturedAt: input.capturedAt,
      contentType: "image/jpeg",
      location: input.location ?? null,
      widthPx: input.widthPx ?? null,
      heightPx: input.heightPx ?? null,
      byteLength: input.original.byteLength,
      captureSource: input.captureSource ?? "in_app_camera",
      capturedAtKnown: input.capturedAtKnown ?? true,
      serverId: null,
      recorded: false,
      stored: false,
      dirty: false,
      editVersion: 0,
      remoteOnly: false,
      originalOnDevice: true,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      needsAttention: false,
      syncedAt: null,
    };
    return this.exclusive(async () => {
      await this.vault.putBytes(originalName(localId), input.original);
      await this.vault.putBytes(thumbName(localId), input.thumbnail);
      await this.vault.putJson(recName(localId), rec);
      this.items.set(localId, rec);
      this.emit();
      return rec;
    });
  }

  /** Flag, unflag, edit note or stage. Works offline; the change is sent on the next sync. */
  async edit(localId: string, change: PhotoEdit): Promise<QueuedPhoto> {
    if (change.note && change.note.length > NOTE_MAX) throw new Error("Note is too long.");
    return this.exclusive(async () => {
      const cur = this.items.get(localId);
      if (!cur) throw new Error("photo not found");
      const next: QueuedPhoto = {
        ...cur,
        ...(change.flagged !== undefined ? { flagged: change.flagged } : {}),
        ...(change.note !== undefined ? { note: change.note?.trim() ? change.note.trim() : null } : {}),
        ...(change.stage !== undefined ? { stage: change.stage } : {}),
        dirty: cur.recorded ? true : cur.dirty, // before step 1, the edit simply rides along with the record
        editVersion: cur.editVersion + 1,
        nextAttemptAt: 0,
      };
      await this.vault.putJson(recName(localId), next);
      this.items.set(localId, next);
      this.emit();
      return next;
    });
  }

  /** Track an offline edit to a photo that already lives on the server (no local file). */
  async editRemote(
    remote: { serverId: string; orgId: string; jobId: string; jobNumber: string; stage: Stage; note: string | null; flagged: boolean; capturedAt: string },
    change: PhotoEdit,
  ): Promise<QueuedPhoto> {
    const existing = this.findByServerId(remote.serverId);
    if (existing) return this.edit(existing.localId, change);
    const localId = this.opts.uuid().toLowerCase();
    const rec: QueuedPhoto = {
      localId,
      orgId: remote.orgId,
      jobId: remote.jobId,
      jobNumber: remote.jobNumber,
      stage: change.stage ?? remote.stage,
      note: change.note !== undefined ? (change.note?.trim() ? change.note.trim() : null) : remote.note,
      flagged: change.flagged ?? remote.flagged,
      capturedAt: remote.capturedAt,
      contentType: "image/jpeg",
      location: null,
      widthPx: null,
      heightPx: null,
      byteLength: 0,
      serverId: remote.serverId,
      recorded: true,
      stored: true,
      dirty: true,
      editVersion: 1,
      remoteOnly: true,
      originalOnDevice: false,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
      needsAttention: false,
      syncedAt: null,
    };
    return this.exclusive(async () => {
      await this.vault.putJson(recName(localId), rec);
      this.items.set(localId, rec);
      this.emit();
      return rec;
    });
  }

  /**
   * Someone else (e.g. a manager) may have changed a photo on the server. If this phone has no
   * unsent change of its own for that photo, take the server's values.
   */
  async absorbServer(s: { id: string; flagged: boolean; note: string | null; stage: string }): Promise<void> {
    const cur = this.findByServerId(s.id);
    if (!cur || cur.dirty || !cur.recorded) return;
    if (s.stage !== "before" && s.stage !== "during" && s.stage !== "after") return;
    if (cur.flagged === s.flagged && cur.note === s.note && cur.stage === s.stage) return;
    await this.update(cur.localId, (p) => (p.dirty ? p : { ...p, flagged: s.flagged, note: s.note, stage: s.stage as Stage }));
  }

  /** Used by the sync engine. Applies `fn` to the latest copy of the record and saves it. */
  async update(localId: string, fn: (cur: QueuedPhoto) => QueuedPhoto): Promise<QueuedPhoto | null> {
    return this.exclusive(async () => {
      const cur = this.items.get(localId);
      if (!cur) return null;
      const next = fn(cur);
      await this.vault.putJson(recName(localId), next);
      this.items.set(localId, next);
      this.emit();
      return next;
    });
  }

  readOriginal(localId: string): Promise<Uint8Array | null> {
    return this.vault.getBytes(originalName(localId));
  }

  /** base64 image data for display. */
  imageBase64(localId: string, which: "thumbnail" | "original"): Promise<string | null> {
    return this.vault.getBase64(which === "thumbnail" ? thumbName(localId) : originalName(localId));
  }

  readThumbnail(localId: string): Promise<Uint8Array | null> {
    return this.vault.getBytes(thumbName(localId));
  }

  /** Deletes the local full-size file. Only called after the server confirmed it has the same bytes. */
  async releaseOriginal(localId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.vault.remove(originalName(localId));
    });
    await this.update(localId, (p) => ({ ...p, originalOnDevice: false }));
  }

  /** Person asked to try a "needs attention" photo again. */
  async retry(localId: string): Promise<void> {
    await this.update(localId, (p) => ({ ...p, needsAttention: false, attempts: 0, nextAttemptAt: 0, lastError: null }));
  }

  /** Person explicitly chose to throw away a photo that could not be uploaded. Never automatic. */
  async discard(localId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.vault.remove(originalName(localId));
      await this.vault.remove(thumbName(localId));
      await this.vault.remove(recName(localId));
      this.items.delete(localId);
      this.emit();
    });
  }

  /** Removes details of photos that finished uploading more than `maxAgeMs` ago (the server copy remains). */
  async pruneSynced(maxAgeMs: number): Promise<number> {
    const cutoff = this.now() - maxAgeMs;
    const old = [...this.items.values()].filter(
      (p) => p.recorded && p.stored && !p.dirty && !p.needsAttention && p.syncedAt && Date.parse(p.syncedAt) < cutoff,
    );
    for (const p of old) await this.discard(p.localId);
    return old.length;
  }

  /** Sign-out / account revoked: delete every local photo and the details. */
  async wipe(): Promise<void> {
    await this.exclusive(async () => {
      await this.vault.wipe();
      this.items.clear();
      this.owner = null;
      this.emit();
    });
  }
}
