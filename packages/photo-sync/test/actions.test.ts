import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ActionOutbox, ApiError, NetworkError, OwnerMismatchError, PhotoQueue, SyncEngine, Vault, actionPath, type PhotoApi, type ServerPhoto } from "../src/index";
import { MemoryBlobStore, WebCryptoCipher } from "../src/testing";

const ORG = "0a000000-0000-4800-8000-000000000001";
const JOB = "00000000-0000-4c00-8000-000000000101";
const PHOTO = "00000000-0000-4e00-8000-000000000001";
const ISSUE = "00000000-0000-4f00-8000-000000000001";

/** Just enough server: issue status with the real "what did you see" check, and clientRef makes a resend safe. */
class Server implements PhotoApi {
  offline = false;
  status = "open";
  seen = new Set<string>();
  calls: { path: string; body: Record<string, unknown> }[] = [];
  busyOnce = false;
  async createPhoto(): Promise<ServerPhoto> { throw new Error("unused"); }
  async uploadContent(): Promise<{ uploadStatus: string; duplicate: boolean }> { throw new Error("unused"); }
  async updatePhoto(): Promise<ServerPhoto> { throw new Error("unused"); }
  async post<T>(path: string, body: unknown): Promise<T> {
    if (this.offline) throw new NetworkError();
    if (this.busyOnce) { this.busyOnce = false; throw new ApiError(503, "unavailable", "busy"); }
    const b = body as Record<string, unknown>;
    this.calls.push({ path, body: b });
    const ref = String(b.clientRef ?? JSON.stringify(b));
    if (this.seen.has(ref)) return {} as T;
    if (path.endsWith("/actions")) {
      if (b.expectedStatus && b.expectedStatus !== this.status) throw new ApiError(409, "conflict", `This issue changed while you were away: it is now "${this.status}". Nothing was changed.`);
      this.status = b.action === "start" ? "in_progress" : b.action === "submit" ? "awaiting_review" : this.status;
    }
    this.seen.add(ref);
    return {} as T;
  }
}

let store: MemoryBlobStore;
let cipher: WebCryptoCipher;
let queue: PhotoQueue;
let outbox: ActionOutbox;
let server: Server;
let engine: SyncEngine;
let clock: number;

async function open() {
  const vault = new Vault(store, cipher);
  const q = new PhotoQueue(vault, { uuid: randomUUID, now: () => clock });
  const o = new ActionOutbox(vault, q, { uuid: randomUUID, now: () => clock, random: () => 0.5 });
  await q.load();
  await o.load();
  return { q, o };
}

beforeEach(async () => {
  clock = Date.parse("2026-11-23T15:00:00Z");
  store = new MemoryBlobStore();
  cipher = await WebCryptoCipher.create();
  ({ q: queue, o: outbox } = await open());
  await queue.claim({ subject: "dev-morgan-manager", displayName: "Morgan" });
  server = new Server();
  engine = new SyncEngine(queue, server, { now: () => clock, random: () => 0.5, actions: outbox });
});

const issueAction = (action: string, expectedStatus: string) =>
  outbox.add({ orgId: ORG, jobId: JOB, photoId: PHOTO, kind: "issue_action", issueId: ISSUE, label: action, body: { clientRef: randomUUID(), action, expectedStatus } });

describe("drawings and issue changes made with no signal", () => {
  it("are kept encrypted, survive closing the app, and send in order once the signal is back", async () => {
    server.offline = true;
    await outbox.add({ orgId: ORG, jobId: JOB, photoId: PHOTO, kind: "markup_changes", label: "Drawing", body: { add: [{ clientRef: randomUUID(), kind: "text", color: "red", size: 2, points: [[0.5, 0.5]], label: "Secret words" }], remove: [] } });
    await outbox.add({ orgId: ORG, jobId: JOB, photoId: PHOTO, kind: "issue_report", label: "Report", body: { clientRef: randomUUID(), title: "Missing bolt" } });
    await issueAction("start", "open");
    expect((await engine.run()).stoppedBecause).toBe("offline");
    const raw = Buffer.concat([...store.files.values()].map((b) => Buffer.from(b))).toString("latin1");
    expect(raw).not.toContain("Secret words");
    expect(raw).not.toContain("Missing bolt");
    ({ q: queue, o: outbox } = await open());
    engine = new SyncEngine(queue, server, { now: () => clock, random: () => 0.5, actions: outbox });
    expect(outbox.counts()).toEqual({ waiting: 3, needsAttention: 0 });
    server.offline = false;
    clock += 20_000;
    const r = await engine.run();
    expect(r.stoppedBecause).toBeNull();
    expect(server.calls.map((c) => c.path)).toEqual([
      `/v1/orgs/${ORG}/photos/${PHOTO}/markups/changes`,
      `/v1/orgs/${ORG}/photos/${PHOTO}/issues`,
      `/v1/orgs/${ORG}/photo-issues/${ISSUE}/actions`,
    ]);
    expect(server.status).toBe("in_progress");
    expect(outbox.all()).toEqual([]);
  });

  it("an issue that changed meanwhile isn't changed: the item waits with the server's reason, later ones for that issue wait too", async () => {
    server.status = "resolved"; // someone else approved it while this phone had no signal
    await issueAction("start", "open");
    await issueAction("submit", "in_progress");
    await outbox.add({ orgId: ORG, jobId: JOB, photoId: PHOTO, kind: "issue_report", label: "Other", body: { clientRef: randomUUID(), title: "Something else" } });
    await engine.run();
    expect(server.status).toBe("resolved");
    const [first, second] = outbox.all();
    expect(first!.needsAttention).toBe(true);
    expect(first!.lastError).toMatch(/changed while you were away/);
    expect(second!.needsAttention).toBe(false); // not sent: it would overtake the first
    expect(server.calls.filter((c) => c.path.endsWith("/actions"))).toHaveLength(1);
    expect(server.calls.some((c) => c.path.endsWith("/issues"))).toBe(true); // other things still go
    // The person looks, then throws the stale change away; the next one is then tried.
    server.status = "open";
    await outbox.discard(first!.localId);
    await engine.run({ force: true });
    expect(server.status).toBe("open"); // "submit" expected in_progress, so it is refused too
    expect(outbox.all()[0]!.needsAttention).toBe(true);
    await outbox.retry(outbox.all()[0]!.localId);
    expect(outbox.all()[0]!.needsAttention).toBe(false);
  });

  it("sending twice applies once; a busy server is retried later; unsent changes block another person signing in", async () => {
    const a = await issueAction("start", "open");
    server.busyOnce = true;
    await engine.run();
    expect(outbox.all()[0]!.lastError).toMatch(/busy/);
    await engine.run({ force: true });
    expect(outbox.all()).toEqual([]);
    expect(server.status).toBe("in_progress");
    // The same body again (a resend after a dropped answer) changes nothing.
    await server.post(actionPath(a), a.body);
    expect(server.status).toBe("in_progress");
    server.offline = true;
    await issueAction("submit", "in_progress");
    expect(queue.hasUnsent()).toBe(true);
    await expect(queue.claim({ subject: "dev-eli-employee", displayName: "Eli" })).rejects.toBeInstanceOf(OwnerMismatchError);
  });

  it("checks what it's given", async () => {
    await expect(outbox.add({ orgId: ORG, jobId: JOB, photoId: "nope", kind: "issue_report", label: "x", body: { clientRef: randomUUID() } })).rejects.toThrow(/photo/);
    await expect(outbox.add({ orgId: ORG, jobId: JOB, photoId: PHOTO, kind: "issue_action", label: "x", body: { clientRef: randomUUID() } })).rejects.toThrow(/issue/);
    await expect(outbox.add({ orgId: ORG, jobId: JOB, photoId: PHOTO, kind: "issue_report", label: "x", body: {} })).rejects.toThrow(/clientRef/);
  });
});
