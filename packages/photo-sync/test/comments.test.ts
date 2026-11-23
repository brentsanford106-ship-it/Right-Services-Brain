import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  CommentOutbox,
  NetworkError,
  OwnerMismatchError,
  PhotoQueue,
  SyncEngine,
  Vault,
  type CreatePhotoBody,
  type PhotoApi,
  type ServerPhoto,
} from "../src/index";
import { MemoryBlobStore, WebCryptoCipher } from "../src/testing";

const ORG = "0a000000-0000-4800-8000-000000000001";
const JOB = "00000000-0000-4c00-8000-000000000101";
const SERVER_PHOTO = "00000000-0000-4e00-8000-000000000001";
const enc = (s: string) => new TextEncoder().encode(s);

/** Just enough server for photos plus comments, with the real rules: clientRef makes a resend safe. */
class Server implements PhotoApi {
  offline = false;
  failWith: ApiError | null = null;
  photos = new Map<string, { id: string; clientRef: string }>();
  comments: { id: string; clientRef: string; photoId: string; parentId: string | null; body: string; mentionIds: string[] }[] = [];
  dropNextComment = false;
  private gate() {
    if (this.offline) throw new NetworkError();
  }
  async createPhoto(_o: string, jobId: string, b: CreatePhotoBody): Promise<ServerPhoto> {
    this.gate();
    let p = [...this.photos.values()].find((x) => x.clientRef === b.clientRef);
    if (!p) { p = { id: randomUUID(), clientRef: b.clientRef }; this.photos.set(p.id, p); }
    return { id: p.id, jobId, jobNumber: "HP-1001", stage: b.stage, note: null, flagged: false, capturedAt: b.capturedAt, uploadStatus: "pending" };
  }
  async uploadContent() { this.gate(); return { uploadStatus: "stored", duplicate: false }; }
  async updatePhoto(): Promise<ServerPhoto> { throw new Error("unused"); }
  async createComment(_o: string, photoId: string, b: { clientRef: string; body: string; parentId?: string | null; mentionIds: string[] }) {
    this.gate();
    if (this.failWith) throw this.failWith;
    let c = this.comments.find((x) => x.clientRef === b.clientRef);
    if (!c) { c = { id: randomUUID(), photoId, parentId: b.parentId ?? null, clientRef: b.clientRef, body: b.body, mentionIds: b.mentionIds }; this.comments.push(c); }
    if (this.dropNextComment) { this.dropNextComment = false; throw new NetworkError("connection dropped"); }
    return { id: c.id };
  }
}

let store: MemoryBlobStore;
let cipher: WebCryptoCipher;
let queue: PhotoQueue;
let outbox: CommentOutbox;
let server: Server;
let engine: SyncEngine;
let clock: number;

async function open() {
  const vault = new Vault(store, cipher);
  const q = new PhotoQueue(vault, { uuid: randomUUID, now: () => clock });
  const o = new CommentOutbox(vault, q, { uuid: randomUUID, now: () => clock, random: () => 0.5 });
  await q.load();
  await o.load();
  return { q, o };
}

beforeEach(async () => {
  clock = Date.parse("2026-11-23T15:00:00Z");
  store = new MemoryBlobStore();
  cipher = await WebCryptoCipher.create();
  ({ q: queue, o: outbox } = await open());
  await queue.claim({ subject: "dev-eli-employee", displayName: "Eli" });
  server = new Server();
  engine = new SyncEngine(queue, server, { now: () => clock, random: () => 0.5, comments: outbox });
});

const onServerPhoto = (body: string, extra: Partial<Parameters<CommentOutbox["add"]>[0]> = {}) =>
  outbox.add({ orgId: ORG, jobId: JOB, photoServerId: SERVER_PHOTO, photoLocalId: null, body, ...extra });

describe("comments written offline", () => {
  it("are kept encrypted on the phone, survive closing the app, and send once the signal is back", async () => {
    server.offline = true;
    await onServerPhoto("Strap is loose near the panel", { mentionIds: ["m1", "m1"] });
    expect((await engine.run()).stoppedBecause).toBe("offline");
    const raw = Buffer.concat([...store.files.values()].map((b) => Buffer.from(b))).toString("latin1");
    expect(raw).not.toContain("Strap is loose");
    // The app is closed and opened again.
    ({ q: queue, o: outbox } = await open());
    engine = new SyncEngine(queue, server, { now: () => clock, random: () => 0.5, comments: outbox });
    expect(outbox.counts()).toEqual({ waiting: 1, needsAttention: 0 });
    server.offline = false;
    clock += 60_000;
    await engine.run();
    expect(server.comments.map((c) => [c.photoId, c.body, c.mentionIds])).toEqual([[SERVER_PHOTO, "Strap is loose near the panel", ["m1"]]]);
    expect(outbox.all()).toEqual([]);
    expect([...store.files.keys()].filter((k) => k.startsWith("pc-"))).toEqual([]);
  });

  it("a lost answer doesn't make a second copy", async () => {
    await onServerPhoto("Done");
    server.dropNextComment = true;
    await engine.run();
    clock += 60_000;
    await engine.run();
    expect(server.comments).toHaveLength(1);
    expect(outbox.all()).toEqual([]);
  });

  it("a comment on a photo that hasn't uploaded yet waits for the photo, then goes in the same run", async () => {
    const photo = await queue.capture({ orgId: ORG, jobId: JOB, jobNumber: "HP-1001", stage: "during", capturedAt: new Date(clock).toISOString(), original: enc("JPEG"), thumbnail: enc("T") });
    server.offline = true;
    await outbox.add({ orgId: ORG, jobId: JOB, photoServerId: null, photoLocalId: photo.localId, body: "Before shot of the slab" });
    await engine.run();
    expect(server.comments).toHaveLength(0);
    server.offline = false;
    clock += 60_000;
    await engine.run();
    const serverPhoto = queue.get(photo.localId)!.serverId!;
    expect(server.comments.map((c) => c.photoId)).toEqual([serverPhoto]);
  });

  it("a reply to a comment that is still waiting goes after it and points at it, even across a restart", async () => {
    server.offline = true;
    const top = await onServerPhoto("Fix this");
    await onServerPhoto("Will do", { parentLocalId: top.localId });
    await engine.run();
    ({ q: queue, o: outbox } = await open());
    engine = new SyncEngine(queue, server, { now: () => clock, random: () => 0.5, comments: outbox });
    server.offline = false;
    clock += 60_000;
    await engine.run();
    expect(server.comments).toHaveLength(2);
    expect(server.comments[1]!.parentId).toBe(server.comments[0]!.id);
  });

  it("a comment the server refuses (photo deleted) is kept for the person to retry or discard, never dropped silently", async () => {
    const top = await onServerPhoto("On a photo that was deleted");
    await onServerPhoto("reply", { parentLocalId: top.localId });
    server.failWith = new ApiError(404, "not_found", "Not found.");
    await engine.run();
    expect(outbox.counts()).toEqual({ waiting: 1, needsAttention: 1 });
    expect(outbox.all().find((c) => c.needsAttention)!.lastError).toMatch(/no longer available/);
    server.failWith = null;
    await outbox.retry(top.localId);
    await engine.run();
    expect(server.comments).toHaveLength(2);
    // Discard removes the comment and its waiting replies.
    server.failWith = new ApiError(404, "not_found", "Not found.");
    const t2 = await onServerPhoto("again");
    await onServerPhoto("reply 2", { parentLocalId: t2.localId });
    await engine.run();
    await outbox.discard(t2.localId);
    expect(outbox.all()).toEqual([]);
  });

  it("someone else can't sign in on this phone while comments are waiting; signing out removes them", async () => {
    server.offline = true;
    await onServerPhoto("waiting");
    await expect(queue.claim({ subject: "dev-avery-owner", displayName: "Avery" })).rejects.toBeInstanceOf(OwnerMismatchError);
    await queue.wipe();
    expect(outbox.all()).toEqual([]);
    expect(store.files.size).toBe(0);
  });

  it("checks the wording before saving", async () => {
    await expect(onServerPhoto("   ")).rejects.toThrow(/Write something/);
    await expect(onServerPhoto("x".repeat(2001))).rejects.toThrow(/2000/);
  });
});
