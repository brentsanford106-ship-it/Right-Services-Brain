import { ApiError, NetworkError } from "./api";
import type { PhotoQueue } from "./queue";
import type { Vault } from "./vault";

/**
 * Comments written on the phone wait here (encrypted, in the same offline store as photos) until they reach the
 * server. That works with no signal, and also for a photo that hasn't uploaded yet: the comment waits for its photo.
 * Each comment carries a phone-made id (sent as clientRef), so sending it twice only saves it once.
 *
 * New comments and replies work offline. Editing and deleting need a connection (so nobody edits a stale copy).
 */

export const COMMENT_MAX = 2000;

export interface PendingComment {
  /** Phone-made id, also the clientRef on the server. */
  localId: string;
  orgId: string;
  jobId: string;
  /** The photo's server id, or null while the photo itself is still waiting to upload. */
  photoServerId: string | null;
  /** The photo's id on this phone, for photos taken here. */
  photoLocalId: string | null;
  /** Reply to this server comment ... */
  parentId: string | null;
  /** ... or to a comment that is itself still waiting on this phone. */
  parentLocalId: string | null;
  body: string;
  mentionIds: string[];
  /** The mark on the photo this comment is about (missing on comments saved by older app versions). */
  markupId?: string | null;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** Sending again won't help (e.g. the photo was deleted). The person chooses Retry or Discard. */
  needsAttention: boolean;
}

export interface CommentApi {
  createComment(orgId: string, photoId: string, body: { clientRef: string; body: string; parentId?: string | null; mentionIds: string[]; markupId?: string | null }): Promise<{ id: string }>;
}

const name = (id: string) => `pc-${id}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function friendly(e: ApiError): string {
  if (e.status === 404) return "The photo is no longer available to you.";
  if (e.status === 403) return "Your account isn't allowed to comment. Ask a manager to check your access.";
  if (e.status === 400) return `The server didn't accept this comment: ${e.message}`;
  if (e.status === 409) return "This comment's id was already used.";
  return e.message;
}

export class CommentOutbox {
  private items = new Map<string, PendingComment>();
  private chain: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(
    private readonly vault: Vault,
    private readonly queue: PhotoQueue,
    private readonly opts: { now?: () => number; uuid: () => string; random?: () => number },
  ) {
    // Signing in as someone else must never throw away their unsent comments.
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
        if (!n.startsWith("pc-")) continue;
        const c = await this.vault.getJson<PendingComment>(n);
        if (c) this.items.set(c.localId, c);
      }
      this.emit();
    });
  }

  all(): PendingComment[] {
    return [...this.items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.localId.localeCompare(b.localId));
  }

  /** Waiting comments on one photo (by its server id or its id on this phone). */
  forPhoto(photo: { serverId: string | null; localId: string | null }): PendingComment[] {
    return this.all().filter((c) =>
      (photo.serverId !== null && c.photoServerId === photo.serverId) || (photo.localId !== null && c.photoLocalId === photo.localId));
  }

  counts(): { waiting: number; needsAttention: number } {
    const all = this.all();
    return { waiting: all.filter((c) => !c.needsAttention).length, needsAttention: all.filter((c) => c.needsAttention).length };
  }

  async add(input: {
    orgId: string; jobId: string; photoServerId: string | null; photoLocalId: string | null;
    parentId?: string | null; parentLocalId?: string | null; body: string; mentionIds?: string[]; markupId?: string | null;
  }): Promise<PendingComment> {
    const body = input.body.trim();
    if (!body) throw new Error("Write something first.");
    if (body.length > COMMENT_MAX) throw new Error(`Comments can be up to ${COMMENT_MAX} characters.`);
    if (!input.photoServerId && !input.photoLocalId) throw new Error("Which photo is this comment on?");
    const localId = this.opts.uuid();
    if (!UUID.test(localId)) throw new Error("uuid() must return a lowercase UUID");
    const c: PendingComment = {
      localId, orgId: input.orgId, jobId: input.jobId, photoServerId: input.photoServerId, photoLocalId: input.photoLocalId,
      parentId: input.parentId ?? null, parentLocalId: input.parentLocalId ?? null, body,
      mentionIds: [...new Set(input.mentionIds ?? [])].slice(0, 20), markupId: input.markupId ?? null, createdAt: new Date(this.now()).toISOString(),
      attempts: 0, nextAttemptAt: 0, lastError: null, needsAttention: false,
    };
    return this.exclusive(async () => {
      await this.vault.putJson(name(localId), c);
      this.items.set(localId, c);
      this.emit();
      return c;
    });
  }

  private async save(c: PendingComment): Promise<void> {
    await this.exclusive(async () => {
      if (!this.items.has(c.localId)) return;
      await this.vault.putJson(name(c.localId), c);
      this.items.set(c.localId, c);
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

  /** The person chose to try a comment that needs attention again. */
  async retry(localId: string): Promise<void> {
    const c = this.items.get(localId);
    if (c) await this.save({ ...c, needsAttention: false, attempts: 0, nextAttemptAt: 0, lastError: null });
  }

  /** The person chose to throw away an unsent comment (and any replies to it waiting on this phone). Never automatic. */
  async discard(localId: string): Promise<void> {
    for (const r of this.all().filter((x) => x.parentLocalId === localId)) await this.drop(r.localId);
    await this.drop(localId);
  }

  /**
   * Sends waiting comments, oldest first. Returns "offline" or "sign_in_required" if it had to stop.
   * A comment waits (without counting as a failure) while its photo or the comment it replies to isn't on the server yet.
   */
  async flush(api: CommentApi, force = false): Promise<{ sent: number; stoppedBecause: "offline" | "sign_in_required" | null }> {
    let sent = 0;
    // A reply sorted before its parent is picked up on the next round, once the parent has been sent.
    for (let round = 0; round < 3; round++) {
      const before = sent;
      const r = await this.flushRound(api, force, (n) => (sent += n));
      if (r) return { sent, stoppedBecause: r };
      if (sent === before) break;
    }
    return { sent, stoppedBecause: null };
  }

  private async flushRound(api: CommentApi, force: boolean, count: (n: number) => void): Promise<"offline" | "sign_in_required" | null> {
    for (const item of this.all()) {
      const c = this.items.get(item.localId);
      if (!c || c.needsAttention || (!force && c.nextAttemptAt > this.now())) continue;
      const photoId = c.photoServerId ?? (c.photoLocalId ? this.queue.get(c.photoLocalId)?.serverId ?? null : null);
      if (!photoId) {
        if (c.photoLocalId && !this.queue.get(c.photoLocalId)) {
          await this.save({ ...c, needsAttention: true, lastError: "The photo this comment is on is no longer on this phone." });
        }
        continue; // the photo hasn't reached the server yet
      }
      const parentId = c.parentId;
      if (!parentId && c.parentLocalId) {
        // Replies to a comment that is itself waiting go after it (it then gives them its server id).
        if (!this.items.has(c.parentLocalId)) await this.save({ ...c, needsAttention: true, lastError: "The comment this replies to was not sent." });
        continue;
      }
      try {
        const res = await api.createComment(c.orgId, photoId, { clientRef: c.localId, body: c.body, parentId, mentionIds: c.mentionIds, ...(c.markupId ? { markupId: c.markupId } : {}) });
        // Waiting replies to this comment now know its server id (saved first, so a restart can't lose the link).
        for (const r of this.all().filter((x) => x.parentLocalId === c.localId)) await this.save({ ...r, parentId: res.id, parentLocalId: null });
        await this.drop(c.localId);
        count(1);
      } catch (e) {
        if (e instanceof NetworkError) {
          await this.save({ ...c, photoServerId: photoId, attempts: c.attempts + 1, nextAttemptAt: this.now() + 15_000, lastError: e.message });
          return "offline";
        }
        if (e instanceof ApiError) {
          if (e.status === 401) return "sign_in_required";
          if (e.status === 408 || e.status === 429 || e.status >= 500) {
            const delay = Math.min(30 * 60_000, 15_000 * 2 ** c.attempts) * (0.75 + (this.opts.random ?? Math.random)() * 0.5);
            await this.save({ ...c, photoServerId: photoId, attempts: c.attempts + 1, nextAttemptAt: this.now() + Math.round(delay), lastError: "Server busy. Will retry." });
            continue;
          }
          await this.save({ ...c, photoServerId: photoId, attempts: c.attempts + 1, needsAttention: true, lastError: friendly(e) });
          continue;
        }
        const msg = e instanceof Error ? e.message : "Unexpected error.";
        await this.save({ ...c, attempts: c.attempts + 1, needsAttention: true, lastError: msg });
      }
    }
    return null;
  }
}
