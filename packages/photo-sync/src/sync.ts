import { ApiError, NetworkError, type CreatePhotoBody, type PhotoApi, type ServerPhoto } from "./api";
import type { PhotoQueue, QueuedPhoto } from "./queue";

export type StopReason = "offline" | "sign_in_required" | null;

export interface SyncResult {
  /** Photos that became fully synced during this run. */
  completed: number;
  remaining: number;
  needsAttention: number;
  stoppedBecause: StopReason;
}

export interface SyncStatus {
  running: boolean;
  uploadingId: string | null;
  lastRunAt: number | null;
  lastStop: StopReason;
}

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 30 * 60_000;

/** Backoff with jitter: 15 s, 30 s, 1 min, 2 min ... capped at 30 min. */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const d = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(d * (0.75 + random() * 0.5));
}

function friendly(e: ApiError): string {
  if (e.status === 404) return "The job or photo is no longer available to you. Ask a manager to check the job.";
  if (e.status === 403) return "Your account isn't allowed to do this. Ask a manager to check your access.";
  if (e.status === 409) return "The server already has a different file for this photo.";
  if (e.status === 413) return "The photo file is too large to upload.";
  if (e.status === 400) return `The server rejected this photo's details: ${e.message}`;
  return e.message;
}

const matches = (p: QueuedPhoto, s: ServerPhoto) => p.flagged === s.flagged && (p.note ?? null) === (s.note ?? null) && p.stage === s.stage;

/**
 * Sends queued photos to the server, oldest first. Each photo goes through up to three
 * steps (record details, send the image, send later flag/note edits). Each step is safe
 * to repeat, so a dropped connection at any point only means the step is tried again.
 *
 * Runs only while the app is open (see docs: iOS does not let an app upload whenever it
 * wants in the background). The app calls `run()` after each photo, when it comes to the
 * foreground, when the connection returns, and on a timer.
 */
export class SyncEngine {
  private status: SyncStatus = { running: false, uploadingId: null, lastRunAt: null, lastStop: null };
  private current: Promise<SyncResult> | null = null;
  private again = false;
  private listeners = new Set<(s: SyncStatus) => void>();

  constructor(
    private readonly queue: PhotoQueue,
    private readonly api: PhotoApi,
    private readonly opts: { now?: () => number; random?: () => number; keepSyncedOriginals?: boolean } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...p };
    for (const l of this.listeners) l(this.status);
  }

  /** Starts a run, or joins the run in progress (and schedules one more pass after it). */
  run(opts: { force?: boolean } = {}): Promise<SyncResult> {
    if (this.current) {
      this.again = true;
      return this.current;
    }
    this.current = (async () => {
      let result: SyncResult;
      do {
        this.again = false;
        result = await this.pass(opts.force ?? false);
      } while (this.again && result.stoppedBecause === null);
      return result;
    })().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async pass(force: boolean): Promise<SyncResult> {
    this.set({ running: true, lastStop: null });
    let completed = 0;
    let stoppedBecause: StopReason = null;
    try {
      for (const item of this.queue.pending()) {
        if (item.needsAttention) continue;
        if (!force && item.nextAttemptAt > this.now()) continue;
        this.set({ uploadingId: item.localId });
        try {
          if (await this.syncOne(item.localId)) completed++;
        } catch (e) {
          if (e instanceof NetworkError) {
            await this.backoff(item.localId, e.message);
            stoppedBecause = "offline";
            break; // no point trying the rest without a connection
          }
          if (e instanceof ApiError) {
            if (e.status === 401) {
              stoppedBecause = "sign_in_required";
              break; // keep everything; the person signs in and sync continues
            }
            if (e.status === 408 || e.status === 429 || e.status >= 500) {
              await this.backoff(item.localId, `Server busy or unavailable (${e.status}). Will retry.`);
              continue;
            }
            await this.queue.update(item.localId, (p) => ({ ...p, needsAttention: true, lastError: friendly(e), attempts: p.attempts + 1 }));
            continue;
          }
          // Unexpected local problem (e.g. file could not be decrypted). Never delete; ask the person.
          const msg = e instanceof Error ? e.message : "Unexpected error.";
          await this.queue.update(item.localId, (p) => ({ ...p, needsAttention: true, lastError: msg, attempts: p.attempts + 1 }));
        }
      }
    } finally {
      this.set({ running: false, uploadingId: null, lastRunAt: this.now(), lastStop: stoppedBecause });
    }
    const c = this.queue.counts();
    return { completed, remaining: c.waiting, needsAttention: c.needsAttention, stoppedBecause };
  }

  private async backoff(localId: string, message: string): Promise<void> {
    await this.queue.update(localId, (p) => {
      const attempts = p.attempts + 1;
      return { ...p, attempts, lastError: message, nextAttemptAt: this.now() + retryDelayMs(attempts, this.opts.random) };
    });
  }

  /** Returns true if the photo became fully synced. */
  private async syncOne(localId: string): Promise<boolean> {
    let p: QueuedPhoto | null | undefined = this.queue.get(localId);
    if (!p) return false;

    // Step 1: the photo's details. Repeating this returns the same server record (clientRef).
    if (!p.recorded) {
      const sentVersion = p.editVersion;
      const body: CreatePhotoBody = {
        clientRef: p.localId,
        stage: p.stage,
        flagged: p.flagged,
        capturedAt: p.capturedAt,
        contentType: p.contentType,
        ...(p.note ? { note: p.note } : {}),
        ...(p.location
          ? {
              latitude: p.location.latitude,
              longitude: p.location.longitude,
              ...(p.location.accuracyM != null ? { locationAccuracyM: Math.max(0, Math.round(p.location.accuracyM)) } : {}),
            }
          : {}),
      };
      const server = await this.api.createPhoto(p.orgId, p.jobId, body);
      p = await this.queue.update(localId, (cur) => ({
        ...cur,
        serverId: server.id,
        recorded: true,
        // If the record already existed (a retry) or the person edited it meanwhile, send the current values next.
        dirty: cur.editVersion !== sentVersion || !matches(cur, server),
        stored: cur.stored || server.uploadStatus === "stored",
      }));
      if (!p) return false;
    }

    // Step 2: the image file. Same bytes again is accepted as a duplicate; different bytes are refused.
    if (!p.stored) {
      const bytes = await this.queue.readOriginal(localId);
      if (!bytes) throw new Error("The photo file is missing from this phone.");
      await this.api.uploadContent(p.orgId, p.serverId!, bytes, p.contentType);
      p = await this.queue.update(localId, (cur) => ({ ...cur, stored: true }));
      if (!p) return false;
    }

    // Step 3: later edits (flag, note, stage).
    if (p.dirty) {
      const sentVersion = p.editVersion;
      const server = await this.api.updatePhoto(p.orgId, p.serverId!, { flagged: p.flagged, note: p.note, stage: p.stage });
      p = await this.queue.update(localId, (cur) => ({ ...cur, dirty: cur.editVersion !== sentVersion || !matches(cur, server) }));
      if (!p) return false;
    }

    if (p.recorded && p.stored && !p.dirty) {
      await this.queue.update(localId, (cur) => ({ ...cur, attempts: 0, lastError: null, nextAttemptAt: 0, syncedAt: cur.syncedAt ?? new Date(this.now()).toISOString() }));
      if (p.originalOnDevice && !this.opts.keepSyncedOriginals) await this.queue.releaseOriginal(localId);
      return true;
    }
    return false;
  }
}
