import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ApiError,
  NetworkError,
  OwnerMismatchError,
  PhotoQueue,
  SyncEngine,
  Vault,
  VaultLockedError,
  retryDelayMs,
  syncStateOf,
  toBase64,
  type CreatePhotoBody,
  type PhotoApi,
  type ServerPhoto,
} from "../src/index";
import { MemoryBlobStore, WebCryptoCipher } from "../src/testing";

const ORG = "0a000000-0000-4800-8000-000000000001";
const JOB = "00000000-0000-4c00-8000-000000000101";
const enc = (s: string) => new TextEncoder().encode(s);

/** A fake server with the same rules as the real one, plus switches to simulate trouble. */
class FakeServer implements PhotoApi {
  photos = new Map<string, ServerPhoto & { clientRef: string; bytes: Uint8Array | null }>();
  offline = false;
  /** Server does the work but the answer is lost on the way back. */
  dropNextResponse = false;
  failWith: ApiError | null = null;
  calls: string[] = [];

  private gate(name: string) {
    this.calls.push(name);
    if (this.offline) throw new NetworkError();
    if (this.failWith) throw this.failWith;
  }
  private maybeDrop() {
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new NetworkError("connection dropped");
    }
  }

  async createPhoto(_org: string, jobId: string, b: CreatePhotoBody): Promise<ServerPhoto> {
    this.gate("create");
    let p = [...this.photos.values()].find((x) => x.clientRef === b.clientRef);
    if (!p) {
      p = { id: randomUUID(), clientRef: b.clientRef, jobId, jobNumber: "HP-1001", stage: b.stage, note: b.note ?? null, flagged: b.flagged, capturedAt: b.capturedAt, uploadStatus: "pending", bytes: null };
      this.photos.set(p.id, p);
    }
    this.maybeDrop();
    return { ...p };
  }
  async uploadContent(_org: string, id: string, bytes: Uint8Array) {
    this.gate("upload");
    const p = this.photos.get(id)!;
    if (p.bytes && Buffer.compare(Buffer.from(p.bytes), Buffer.from(bytes)) !== 0) throw new ApiError(409, "conflict", "different");
    const duplicate = !!p.bytes;
    p.bytes = new Uint8Array(bytes);
    p.uploadStatus = "stored";
    this.maybeDrop();
    return { uploadStatus: "stored", duplicate };
  }
  async updatePhoto(_org: string, id: string, b: { flagged?: boolean; note?: string | null; stage?: ServerPhoto["stage"] }) {
    this.gate("update");
    const p = this.photos.get(id)!;
    if (b.flagged !== undefined) p.flagged = b.flagged;
    if (b.note !== undefined) p.note = b.note;
    if (b.stage !== undefined) p.stage = b.stage;
    this.maybeDrop();
    return { ...p };
  }
}

let store: MemoryBlobStore;
let cipher: WebCryptoCipher;
let queue: PhotoQueue;
let server: FakeServer;
let engine: SyncEngine;
let clock: number;

async function freshQueue() {
  const q = new PhotoQueue(new Vault(store, cipher), { uuid: randomUUID, now: () => clock });
  await q.load();
  return q;
}

beforeEach(async () => {
  clock = Date.parse("2026-11-20T15:00:00Z");
  store = new MemoryBlobStore();
  cipher = await WebCryptoCipher.create();
  queue = await freshQueue();
  await queue.claim({ subject: "dev-eli-employee", displayName: "Eli" });
  server = new FakeServer();
  engine = new SyncEngine(queue, server, { now: () => clock, random: () => 0.5 });
});

const shot = (n: number, extra: Partial<Parameters<PhotoQueue["capture"]>[0]> = {}) =>
  queue.capture({
    orgId: ORG, jobId: JOB, jobNumber: "HP-1001", stage: "during",
    capturedAt: new Date(clock + n * 1000).toISOString(),
    original: enc(`ORIGINAL-JPEG-BYTES-${n}`), thumbnail: enc(`THUMB-${n}`),
    location: { latitude: 40.4462, longitude: -80.0021, accuracyM: 8 },
    ...extra,
  });

describe("encrypted offline storage", () => {
  it("never writes image bytes, notes, job numbers or GPS to disk in readable form", async () => {
    await shot(1, { note: "Leaking valve (synthetic)", flagged: true });
    const all = Buffer.concat([...store.files.values()].map((b) => Buffer.from(b))).toString("latin1");
    for (const secret of ["ORIGINAL-JPEG-BYTES-1", "THUMB-1", "Leaking valve", "HP-1001", "40.4462", "dev-eli-employee"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("refuses to read a file that was altered or swapped for another photo's file", async () => {
    const a = await shot(1);
    const b = await shot(2);
    const nameA = `o-${a.localId}`;
    const nameB = `o-${b.localId}`;
    const tampered = new Uint8Array(store.files.get(nameA)!);
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    store.files.set(nameA, tampered);
    await expect(queue.readOriginal(a.localId)).rejects.toBeInstanceOf(VaultLockedError);
    store.files.set(nameA, store.files.get(nameB)!); // swap: valid ciphertext, wrong slot
    await expect(queue.readOriginal(a.localId)).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("cannot be read with a different key (e.g. after the key was destroyed on sign-out)", async () => {
    await shot(1);
    const other = new PhotoQueue(new Vault(store, await WebCryptoCipher.create()), { uuid: randomUUID });
    await expect(other.load()).rejects.toBeInstanceOf(VaultLockedError);
  });

  it("a wrong or missing key never deletes the encrypted photos (no silent loss)", async () => {
    await shot(1);
    await shot(2);
    const before = [...store.files.keys()].sort();
    const other = new PhotoQueue(new Vault(store, await WebCryptoCipher.create()), { uuid: randomUUID });
    await expect(other.load()).rejects.toBeInstanceOf(VaultLockedError);
    expect([...store.files.keys()].sort()).toEqual(before);
    // With the right key again, everything is still readable.
    const reopened = await freshQueue();
    expect(reopened.all()).toHaveLength(2);
  });

  it("a damaged photo-details file blocks loading instead of quietly dropping that photo", async () => {
    const a = await shot(1);
    await shot(2);
    const name = `r-${a.localId}`;
    const damaged = new Uint8Array(store.files.get(name)!);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    store.files.set(name, damaged);
    const count = store.files.size;
    await expect(freshQueue()).rejects.toBeInstanceOf(VaultLockedError);
    expect(store.files.size).toBe(count);
  });

  it("each save uses a fresh random nonce, so the same photo never produces the same file", async () => {
    const v = new Vault(store, cipher);
    await v.putBytes("x-a", enc("same bytes"));
    const first = new Uint8Array(store.files.get("x-a")!);
    await v.putBytes("x-a", enc("same bytes"));
    expect(Buffer.from(store.files.get("x-a")!).equals(Buffer.from(first))).toBe(false);
    expect(new TextDecoder().decode((await v.getBytes("x-a"))!)).toBe("same bytes");
  });

  it("survives an app restart: photos, flags and notes are all still there", async () => {
    const a = await shot(1);
    await queue.edit(a.localId, { flagged: true, note: "check this" });
    const reopened = await freshQueue();
    expect(reopened.get(a.localId)).toMatchObject({ flagged: true, note: "check this", jobNumber: "HP-1001" });
    expect(new TextDecoder().decode((await reopened.readOriginal(a.localId))!)).toBe("ORIGINAL-JPEG-BYTES-1");
  });

  it("cleans up a capture that was interrupted before its details were saved", async () => {
    await store.write("o-11111111-1111-4111-8111-111111111111", new Uint8Array(40));
    const reopened = await freshQueue();
    expect(reopened.all()).toHaveLength(0);
    expect(store.files.has("o-11111111-1111-4111-8111-111111111111")).toBe(false);
  });

  it("decrypts images to base64 for display without writing them to disk", async () => {
    const a = await shot(1);
    expect(await queue.imageBase64(a.localId, "thumbnail")).toBe(Buffer.from("THUMB-1").toString("base64"));
    for (const n of [0, 1, 2, 3, 4, 5]) {
      const b = new Uint8Array(n).map((_, i) => i * 37);
      expect(toBase64(b)).toBe(Buffer.from(b).toString("base64"));
    }
  });

  it("sign-out wipes everything", async () => {
    await shot(1);
    await queue.wipe();
    expect(store.files.size).toBe(0);
    expect(queue.all()).toHaveLength(0);
  });

  it("will not mix one person's unsent photos with another person's account", async () => {
    await shot(1);
    await expect(queue.claim({ subject: "dev-ezra-field", displayName: "Ezra" })).rejects.toBeInstanceOf(OwnerMismatchError);
    expect(queue.all()).toHaveLength(1);
  });
});

describe("sync", () => {
  it("uploads several photos in order, then removes the full-size local copy (thumbnail kept)", async () => {
    const a = await shot(1);
    const b = await shot(2, { flagged: true, note: "first note" });
    const r = await engine.run();
    expect(r).toMatchObject({ completed: 2, remaining: 0, needsAttention: 0, stoppedBecause: null });
    const onServer = [...server.photos.values()];
    expect(onServer.map((p) => new TextDecoder().decode(p.bytes!))).toEqual(["ORIGINAL-JPEG-BYTES-1", "ORIGINAL-JPEG-BYTES-2"]);
    expect(onServer[1]).toMatchObject({ flagged: true, note: "first note" });
    expect(await queue.readOriginal(a.localId)).toBeNull();
    expect(await queue.readThumbnail(b.localId)).not.toBeNull();
    expect(syncStateOf(queue.get(b.localId)!, null)).toBe("synced");
  });

  it("offline: nothing is lost, it waits, then uploads when the connection returns", async () => {
    server.offline = true;
    const a = await shot(1);
    await queue.edit(a.localId, { flagged: true });
    const r1 = await engine.run();
    expect(r1.stoppedBecause).toBe("offline");
    expect(queue.get(a.localId)).toMatchObject({ recorded: false, attempts: 1, needsAttention: false });
    expect(queue.get(a.localId)!.nextAttemptAt).toBeGreaterThan(clock);
    // Too early for the automatic retry...
    server.offline = false;
    expect((await engine.run()).completed).toBe(0);
    // ...but "connection is back" forces a try right away.
    const r2 = await engine.run({ force: true });
    expect(r2.completed).toBe(1);
    expect([...server.photos.values()][0]).toMatchObject({ flagged: true, uploadStatus: "stored" });
  });

  it("a dropped connection after the server saved the record does not create a duplicate", async () => {
    await shot(1);
    server.dropNextResponse = true;
    expect((await engine.run()).stoppedBecause).toBe("offline");
    await engine.run({ force: true });
    expect(server.photos.size).toBe(1);
    expect([...server.photos.values()][0]!.uploadStatus).toBe("stored");
  });

  it("a dropped connection during the file upload is retried and accepted as the same file", async () => {
    await shot(1);
    server.calls = [];
    const origUpload = server.uploadContent.bind(server);
    let first = true;
    server.uploadContent = async (...args) => {
      const res = await origUpload(...args);
      if (first) { first = false; throw new NetworkError("dropped after upload"); }
      return res;
    };
    await engine.run();
    const r = await engine.run({ force: true });
    expect(r.completed).toBe(1);
    expect(server.photos.size).toBe(1);
  });

  it("flag and note edits made while offline are sent after the photo is uploaded", async () => {
    const a = await shot(1);
    await engine.run();
    server.offline = true;
    await queue.edit(a.localId, { flagged: true, note: "Rust on bracket" });
    await queue.edit(a.localId, { stage: "after" });
    expect(syncStateOf(queue.get(a.localId)!, null)).toBe("waiting");
    await engine.run();
    server.offline = false;
    await engine.run({ force: true });
    expect([...server.photos.values()][0]).toMatchObject({ flagged: true, note: "Rust on bracket", stage: "after" });
    expect(syncStateOf(queue.get(a.localId)!, null)).toBe("synced");
  });

  it("an edit made while an upload is in progress is not lost", async () => {
    const a = await shot(1);
    const orig = server.createPhoto.bind(server);
    server.createPhoto = async (...args) => {
      const res = await orig(...args);
      await queue.edit(a.localId, { flagged: true }); // person taps the flag mid-upload
      return res;
    };
    await engine.run();
    await engine.run({ force: true });
    expect([...server.photos.values()][0]!.flagged).toBe(true);
    expect(queue.get(a.localId)!.dirty).toBe(false);
  });

  it("expired sign-in pauses sync without marking photos as failed", async () => {
    const a = await shot(1);
    server.failWith = new ApiError(401, "unauthenticated", "expired");
    expect((await engine.run()).stoppedBecause).toBe("sign_in_required");
    expect(queue.get(a.localId)).toMatchObject({ needsAttention: false, attempts: 0 });
    server.failWith = null;
    expect((await engine.run()).completed).toBe(1);
  });

  it("a photo the server refuses is kept and shown as needing attention, and can be retried", async () => {
    const a = await shot(1);
    const b = await shot(2);
    let n = 0;
    const orig = server.createPhoto.bind(server);
    server.createPhoto = async (...args) => {
      if (n++ === 0) throw new ApiError(404, "not_found", "Not found.");
      return orig(...args);
    };
    const r = await engine.run();
    expect(r).toMatchObject({ completed: 1, needsAttention: 1 });
    expect(syncStateOf(queue.get(a.localId)!, null)).toBe("needs_attention");
    expect(queue.get(a.localId)!.lastError).toMatch(/no longer available/);
    expect(await queue.readOriginal(a.localId)).not.toBeNull(); // never silently deleted
    expect(syncStateOf(queue.get(b.localId)!, null)).toBe("synced");
    await queue.retry(a.localId);
    expect((await engine.run()).completed).toBe(1);
  });

  it("server errors back off and retry automatically", async () => {
    const a = await shot(1);
    server.failWith = new ApiError(503, "unavailable", "busy");
    await engine.run();
    expect(queue.get(a.localId)).toMatchObject({ needsAttention: false, attempts: 1 });
    server.failWith = null;
    clock += 60_000;
    expect((await engine.run()).completed).toBe(1);
  });

  it("offline edit to a photo that only exists on the server is queued and sent", async () => {
    const remote = { serverId: randomUUID(), orgId: ORG, jobId: JOB, jobNumber: "HP-1001", stage: "before" as const, note: null, flagged: false, capturedAt: "2026-11-01T10:00:00Z" };
    server.photos.set(remote.serverId, { id: remote.serverId, clientRef: randomUUID(), jobId: JOB, jobNumber: "HP-1001", stage: "before", note: null, flagged: false, capturedAt: remote.capturedAt, uploadStatus: "stored", bytes: enc("x") });
    await queue.editRemote(remote, { flagged: true });
    await engine.run();
    expect(server.photos.get(remote.serverId)!.flagged).toBe(true);
  });

  it("concurrent run() calls share one pass and never upload twice", async () => {
    await shot(1);
    await Promise.all([engine.run(), engine.run(), engine.run()]);
    expect(server.calls.filter((c) => c === "upload")).toHaveLength(1);
  });

  it("backoff grows and is capped", () => {
    const half = () => 0.5;
    expect(retryDelayMs(1, half)).toBe(15_000);
    expect(retryDelayMs(3, half)).toBe(60_000);
    expect(retryDelayMs(30, half)).toBe(30 * 60_000);
  });

  it("explicit discard removes the photo; prune removes only old synced ones", async () => {
    const a = await shot(1);
    const b = await shot(2);
    await engine.run();
    clock += 8 * 24 * 3600_000;
    const c = await shot(3);
    expect(await queue.pruneSynced(7 * 24 * 3600_000)).toBe(2);
    expect(queue.get(a.localId)).toBeUndefined();
    expect(queue.get(b.localId)).toBeUndefined();
    expect(queue.get(c.localId)).toBeDefined();
    await queue.discard(c.localId);
    expect(store.files.size).toBe(1); // only the owner record
  });
});
