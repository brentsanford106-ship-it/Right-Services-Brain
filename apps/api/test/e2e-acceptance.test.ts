import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { HttpClient, PhotoQueue, SyncEngine, Vault, syncStateOf, type FetchLike } from "@rsb/photo-sync";
import { MemoryBlobStore, WebCryptoCipher } from "@rsb/photo-sync/testing";
import { adminClient, createTestApp, ORG_A, ORG_B, type TestApp } from "./helpers.js";

/**
 * Phase 1 acceptance flow, automated end to end over real HTTP against the real API and database:
 *
 *   Create Job -> Open Camera -> Take Multiple Photos -> Flag Latest -> Review Thumbnail -> Add Note
 *   -> Resume Camera -> Capture Offline -> Reconnect -> Synchronize -> View Photos on Web
 *
 * The "phone" is the same queue + sync engine code the iPhone app runs (encrypted store, retry rules),
 * with the iPhone's storage and crypto swapped for Node equivalents. Camera hardware, iOS permissions,
 * and the iPhone UI are NOT exercised here; that needs the real-iPhone test.
 */
let t: TestApp;
let base: string;
const ELI_MEMBERSHIP = "00000000-0000-4b00-8000-00000000a003";

beforeAll(async () => {
  t = await createTestApp({ PHASE2_FEATURES: "false" });
  await t.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = t.app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});
let createdJobId: string | null = null;
afterAll(async () => {
  // Other test files share this seeded database and expect Eli to be assigned only to HP-1001.
  if (createdJobId) {
    const c = await adminClient();
    await c.query("UPDATE job_assignments SET ended_at = now() WHERE job_id = $1", [createdJobId]);
    await c.end();
  }
  await t.close();
});

async function web(subject: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${await t.token(subject)}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function jpeg(seed: number): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: 64 + seed, height: 48, channels: 3, background: { r: (seed * 40) % 255, g: 90, b: 160 } } }).jpeg({ quality: 90 }).toBuffer();
  return new Uint8Array(buf);
}

describe("Phase 1 acceptance: field photo flow", () => {
  it("runs the whole flow and every flag, note, stage and sync state survives to the web view", async () => {
    // ---- 1. Create Job (manager, office)
    const jobNumber = `E2E-${Date.now() % 1_000_000}`;
    const job = await web("dev-morgan-manager", "POST", `/v1/orgs/${ORG_A}/jobs`, { jobNumber, title: "Canopy inspection (synthetic)", siteName: "Station 77 (synthetic)", status: "active" });
    expect(job.status).toBe(201);
    createdJobId = job.body.id;
    expect((await web("dev-morgan-manager", "POST", `/v1/orgs/${ORG_A}/jobs/${job.body.id}/assignments`, { membershipId: ELI_MEMBERSHIP })).status).toBe(201);

    // ---- The employee's phone
    let offline = false;
    const netFetch: FetchLike = async (url, init) => {
      if (offline) throw new TypeError("Network request failed");
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body as string | Uint8Array<ArrayBuffer> | undefined, signal: init.signal });
      return { status: res.status, ok: res.ok, text: () => res.text() };
    };
    const store = new MemoryBlobStore();
    const cipher = await WebCryptoCipher.create();
    const api = new HttpClient({ baseUrl: base, fetch: netFetch, getToken: () => t.token("dev-eli-employee") });
    let queue = new PhotoQueue(new Vault(store, cipher), { uuid: randomUUID });
    await queue.load();
    await queue.claim({ subject: "dev-eli-employee", displayName: "Eli Employee" });
    let engine = new SyncEngine(queue, api);

    // The job list the phone sees includes the new job.
    const jobs = await api.get<{ items: { id: string; jobNumber: string }[] }>(`/v1/orgs/${ORG_A}/jobs?q=${jobNumber}`);
    expect(jobs.items.map((j) => j.jobNumber)).toEqual([jobNumber]);

    // ---- 2-3. Open Camera, take multiple photos without confirming each one
    const site = { latitude: 40.4462, longitude: -80.0021, accuracyM: 6 };
    const originals: Uint8Array[] = [];
    const shoot = async (n: number, stage: "before" | "during" | "after", at: string) => {
      const original = await jpeg(n);
      originals[n] = original;
      return queue.capture({ orgId: ORG_A, jobId: job.body.id, jobNumber, stage, capturedAt: at, original, thumbnail: await jpeg(100 + n), location: site, widthPx: 64 + n, heightPx: 48 });
    };
    const p1 = await shoot(1, "before", "2026-11-20T14:00:00.000Z");
    const p2 = await shoot(2, "before", "2026-11-20T14:00:05.000Z");
    const p3 = await shoot(3, "during", "2026-11-20T14:10:00.000Z");
    await engine.run(); // the app syncs right after each photo when there is signal

    // ---- 4. Flag the latest photo from the camera
    await queue.edit(p3.localId, { flagged: true });

    // ---- 5-6. Tap the thumbnail, review, add a note
    expect(await queue.imageBase64(p3.localId, "thumbnail")).toMatch(/^\/9j\//); // JPEG thumbnail decrypts for display
    await queue.edit(p3.localId, { note: "Loose conduit strap above pump 4 (synthetic)" });
    await engine.run();
    expect(syncStateOf(queue.get(p3.localId)!, null)).toBe("synced");

    // ---- 7-8. Resume camera; signal drops; keep shooting
    offline = true;
    const p4 = await shoot(4, "after", "2026-11-20T15:30:00.000Z");
    const p5 = await shoot(5, "after", "2026-11-20T15:31:00.000Z");
    await queue.edit(p5.localId, { flagged: true, note: "Final condition, needs manager sign-off (synthetic)" });
    await queue.edit(p1.localId, { note: "Before: cracked lens cover (synthetic)" }); // edit an already-uploaded photo while offline
    const offlineRun = await engine.run({ force: true });
    expect(offlineRun.stoppedBecause).toBe("offline");
    for (const p of [p4, p5]) expect(syncStateOf(queue.get(p.localId)!, null)).toBe("waiting");

    // The phone is restarted while still offline: nothing is lost.
    queue = new PhotoQueue(new Vault(store, cipher), { uuid: randomUUID });
    await queue.load();
    engine = new SyncEngine(queue, api);
    expect(queue.pending().map((p) => p.localId).sort()).toEqual([p1.localId, p4.localId, p5.localId].sort());

    // ---- 9-10. Reconnect and synchronize
    offline = false;
    const sync = await engine.run({ force: true });
    expect(sync).toMatchObject({ remaining: 0, needsAttention: 0, stoppedBecause: null });
    expect(queue.pending()).toHaveLength(0);
    // Full-size copies are removed from the phone only after the server has them.
    for (const p of [p1, p2, p3, p4, p5]) expect(await queue.readOriginal(p.localId)).toBeNull();

    // ---- 11. View photos on the web (manager)
    const list = await web("dev-morgan-manager", "GET", `/v1/orgs/${ORG_A}/jobs/${job.body.id}/photos`);
    expect(list.status).toBe(200);
    const items = list.body.items as { id: string; stage: string; flagged: boolean; note: string | null; uploadStatus: string; capturedAt: string; jobNumber: string; latitude: number; uploadedBy: string; hasPreview: boolean }[];
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.capturedAt)).toEqual([...items.map((i) => i.capturedAt)].sort()); // chronological
    expect(items.map((i) => [i.stage, i.flagged, i.note])).toEqual([
      ["before", false, "Before: cracked lens cover (synthetic)"],
      ["before", false, null],
      ["during", true, "Loose conduit strap above pump 4 (synthetic)"],
      ["after", false, null],
      ["after", true, "Final condition, needs manager sign-off (synthetic)"],
    ]);
    for (const i of items) {
      expect(i).toMatchObject({ jobNumber, uploadStatus: "stored", uploadedBy: "Eli Employee", latitude: site.latitude, hasPreview: true });
    }

    // Filters used by the web gallery
    const flagged = await web("dev-morgan-manager", "GET", `/v1/orgs/${ORG_A}/photos?jobNumber=${jobNumber}&flagged=true`);
    expect(flagged.body.items).toHaveLength(2);
    const after = await web("dev-morgan-manager", "GET", `/v1/orgs/${ORG_A}/photos?jobNumber=${jobNumber}&stage=after`);
    expect(after.body.items).toHaveLength(2);
    const near = await web("dev-morgan-manager", "GET", `/v1/orgs/${ORG_A}/photos?lat=40.4463&lng=-80.0022&radiusM=100&from=2026-11-20&to=2026-11-20`);
    expect(near.body.items.filter((i: { jobNumber: string }) => i.jobNumber === jobNumber)).toHaveLength(5);

    // Images: viewable with sign-in, original preserved byte-for-byte, nothing without a token.
    const id5 = items[4]!.id;
    const preview = await fetch(`${base}/v1/orgs/${ORG_A}/photos/${id5}/content`, { headers: { authorization: `Bearer ${await t.token("dev-morgan-manager")}` } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/jpeg");
    const original = await fetch(`${base}/v1/orgs/${ORG_A}/photos/${id5}/content?variant=original`, { headers: { authorization: `Bearer ${await t.token("dev-morgan-manager")}` } });
    expect(Buffer.from(await original.arrayBuffer()).equals(Buffer.from(originals[5]!))).toBe(true);
    expect((await fetch(`${base}/v1/orgs/${ORG_A}/photos/${id5}/content`)).status).toBe(401);

    // Another company sees nothing, even with the exact ids.
    expect((await web("dev-riley-owner", "GET", `/v1/orgs/${ORG_A}/jobs/${job.body.id}/photos`)).status).toBe(404);
    expect((await web("dev-riley-owner", "GET", `/v1/orgs/${ORG_B}/photos?jobNumber=${jobNumber}`)).body.items).toHaveLength(0);

    // Dashboard reflects it.
    const dash = await web("dev-morgan-manager", "GET", `/v1/orgs/${ORG_A}/dashboard`);
    expect(dash.body.flaggedPhotos).toBeGreaterThanOrEqual(2);

    // A manager unflags on the web; the phone picks up the change when it next loads the gallery.
    expect((await web("dev-morgan-manager", "PATCH", `/v1/orgs/${ORG_A}/photos/${items[2]!.id}`, { flagged: false })).body.flagged).toBe(false);
    const phoneView = await api.get<{ items: { id: string; flagged: boolean; note: string | null; stage: string }[] }>(`/v1/orgs/${ORG_A}/jobs/${job.body.id}/photos`);
    for (const sp of phoneView.items) await queue.absorbServer(sp);
    expect(queue.get(p3.localId)!.flagged).toBe(false);
  });
});
