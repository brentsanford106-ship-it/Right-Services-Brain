import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Final Phase 1 photo requirements: flags, notes, Before/During/After, job search and edit,
 * photo-centric dashboard, and Phase 2 modules switched off by default.
 */
let t: TestApp;
let jpeg: Buffer;

beforeAll(async () => {
  t = await createTestApp();
  jpeg = await sharp({ create: { width: 32, height: 24, channels: 3, background: "#336699" } }).jpeg().toBuffer();
});
afterAll(async () => { await t.close(); });

const base = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id; // Eli assigned
const hp1002 = F.jobs[1].id; // Ezra assigned

async function shoot(subject: string, jobId: string, extra: Record<string, unknown> = {}) {
  const rec = await t.as(subject).post(`${base}/jobs/${jobId}/photos`, {
    clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg", ...extra,
  });
  expect(rec.status).toBe(201);
  return rec.body as { id: string; flagged: boolean; note: string | null; stage: string; flaggedAt: string | null };
}

describe("flags and notes", () => {
  it("a photo can be created already flagged with a note (flagged in the camera while offline)", async () => {
    const p = await shoot("dev-eli-employee", hp1001, { flagged: true, note: "Cracked curb (synthetic)", stage: "before" });
    expect(p).toMatchObject({ flagged: true, note: "Cracked curb (synthetic)", stage: "before" });
    expect(p.flaggedAt).toEqual(expect.any(String));
  });

  it("the photographer can flag, unflag, edit the note and change the stage", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    const eli = t.as("dev-eli-employee");
    let r = await eli.patch(`${base}/photos/${p.id}`, { flagged: true });
    expect(r.status).toBe(200);
    expect(r.body.flagged).toBe(true);
    r = await eli.patch(`${base}/photos/${p.id}`, { note: "Needs a second look" });
    expect(r.body).toMatchObject({ flagged: true, note: "Needs a second look" });
    r = await eli.patch(`${base}/photos/${p.id}`, { stage: "after" });
    expect(r.body.stage).toBe("after");
    r = await eli.patch(`${base}/photos/${p.id}`, { flagged: false, note: null });
    expect(r.body).toMatchObject({ flagged: false, note: null, flaggedAt: null, stage: "after" });
  });

  it("replaying the same change (offline queue retry) is harmless", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    const eli = t.as("dev-eli-employee");
    const first = await eli.patch(`${base}/photos/${p.id}`, { flagged: true, note: "same" });
    const second = await eli.patch(`${base}/photos/${p.id}`, { flagged: true, note: "same" });
    expect(second.status).toBe(200);
    expect(second.body.flaggedAt).toBe(first.body.flaggedAt);
  });

  it("a manager can flag any photo in the company; changes persist and show in the gallery", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    const r = await t.as("dev-morgan-manager").patch(`${base}/photos/${p.id}`, { flagged: true, note: "Manager review" });
    expect(r.status).toBe(200);
    const list = await t.as("dev-morgan-manager").get(`${base}/jobs/${hp1001}/photos`);
    expect(list.body.items.find((x: { id: string }) => x.id === p.id)).toMatchObject({ flagged: true, note: "Manager review" });
  });

  it("another employee cannot change someone else's photo", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    // Ezra is not assigned to HP-1001, so the photo is invisible to him: 404, not 403.
    expect((await t.as("dev-ezra-field").patch(`${base}/photos/${p.id}`, { flagged: true })).status).toBe(404);
  });

  it("a different company cannot change the photo, even with its exact id", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    expect((await t.as("dev-riley-owner").patch(`/v1/orgs/${ORG_B}/photos/${p.id}`, { flagged: true })).status).toBe(404);
    expect((await t.as("dev-riley-owner").patch(`${base}/photos/${p.id}`, { flagged: true })).status).toBe(404);
  });

  it.each<[unknown, string]>([
    [{}, "empty change"],
    [{ note: "x".repeat(2001) }, "note too long"],
    [{ stage: "issue" }, "stage outside Before/During/After"],
    [{ flagged: "yes" }, "non-boolean flag"],
    [{ uploadedBy: "x" }, "unknown field"],
  ])("rejects %j (%s)", async (body) => {
    const p = await shoot("dev-eli-employee", hp1001);
    expect((await t.as("dev-eli-employee").patch(`${base}/photos/${p.id}`, body)).status).toBe(400);
  });

  it("filters by flagged and by stage", async () => {
    const flagged = await shoot("dev-eli-employee", hp1001, { flagged: true, stage: "after" });
    const plain = await shoot("dev-eli-employee", hp1001, { stage: "after" });
    const m = t.as("dev-morgan-manager");
    const f = await m.get(`${base}/photos?jobNumber=HP-1001&flagged=true`);
    const ids = f.body.items.map((x: { id: string }) => x.id);
    expect(ids).toContain(flagged.id);
    expect(ids).not.toContain(plain.id);
    expect(f.body.items.every((x: { flagged: boolean }) => x.flagged)).toBe(true);
    const a = await m.get(`${base}/photos?jobNumber=HP-1001&stage=after`);
    expect(a.body.items.every((x: { stage: string }) => x.stage === "after")).toBe(true);
  });

  it("flag and note changes are recorded in the audit log without the note text", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    await t.as("dev-eli-employee").patch(`${base}/photos/${p.id}`, { flagged: true, note: "SECRET-NOTE-TEXT" });
    const audit = await t.as("dev-avery-owner").get(`${base}/audit-events?limit=100`);
    const ev = audit.body.items.find((e: { targetId: string; action: string }) => e.targetId === p.id && e.action === "photo.flagged");
    expect(ev).toBeTruthy();
    expect(JSON.stringify(audit.body)).not.toContain("SECRET-NOTE-TEXT");
  });
});

describe("dashboard", () => {
  it("counts flagged photos and photos still waiting for their file", async () => {
    const before = (await t.as("dev-morgan-manager").get(`${base}/dashboard`)).body;
    const p = await shoot("dev-eli-employee", hp1001, { flagged: true });
    let d = (await t.as("dev-morgan-manager").get(`${base}/dashboard`)).body;
    expect(d.flaggedPhotos).toBe(before.flaggedPhotos + 1);
    expect(d.photosAwaitingUpload).toBe(before.photosAwaitingUpload + 1);
    await t.as("dev-eli-employee").put(`${base}/photos/${p.id}/content`, jpeg, "image/jpeg");
    d = (await t.as("dev-morgan-manager").get(`${base}/dashboard`)).body;
    expect(d.photosAwaitingUpload).toBe(before.photosAwaitingUpload);
  });
});

describe("jobs: search and edit", () => {
  it("finds jobs by job number, job name, or site name", async () => {
    const m = t.as("dev-morgan-manager");
    const byNumber = await m.get(`${base}/jobs?q=hp-1002`);
    expect(byNumber.body.items.map((j: { jobNumber: string }) => j.jobNumber)).toEqual(["HP-1002"]);
    const title = F.jobs[0].title.split(" ")[0]!;
    const byTitle = await m.get(`${base}/jobs?q=${encodeURIComponent(title)}`);
    expect(byTitle.body.items.map((j: { jobNumber: string }) => j.jobNumber)).toContain("HP-1001");
  });

  it("treats % and _ in a search literally", async () => {
    const r = await t.as("dev-morgan-manager").get(`${base}/jobs?q=%25`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });

  it("search never returns another company's jobs or jobs the employee is not assigned to", async () => {
    // Org B also has a job numbered HP-1001.
    const m = await t.as("dev-morgan-manager").get(`${base}/jobs?q=HP-1001`);
    expect(m.body.items).toHaveLength(1);
    const eli = await t.as("dev-eli-employee").get(`${base}/jobs?q=HP-100`);
    expect(eli.body.items.map((j: { jobNumber: string }) => j.jobNumber)).toEqual(["HP-1001"]);
  });

  it("a manager can create and edit a job; an employee cannot edit", async () => {
    const m = t.as("dev-morgan-manager");
    const c = await m.post(`${base}/jobs`, { jobNumber: `T-${Date.now() % 100000}`, title: "Canopy repair (synthetic)" });
    expect(c.status).toBe(201);
    const e = await m.patch(`${base}/jobs/${c.body.id}`, { title: "Canopy repair, phase 2 (synthetic)", siteName: "Station 9 (synthetic)" });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ title: "Canopy repair, phase 2 (synthetic)", siteName: "Station 9 (synthetic)" });
    expect((await t.as("dev-eli-employee").patch(`${base}/jobs/${hp1001}`, { title: "nope" })).status).toBe(403);
  });

  it("another company cannot edit the job", async () => {
    expect((await t.as("dev-riley-owner").patch(`/v1/orgs/${ORG_B}/jobs/${hp1002}`, { title: "x" })).status).toBe(404);
    expect((await t.as("dev-riley-owner").patch(`${base}/jobs/${hp1002}`, { title: "x" })).status).toBe(404);
  });
});

describe("Phase 2 modules are off by default", () => {
  it("receipts, vehicles and member admin return 404 unless explicitly enabled", async () => {
    const off = await createTestApp({ PHASE2_FEATURES: "false" });
    try {
      for (const path of ["receipts", "vehicles", "members", "audit-events"]) {
        expect((await off.as("dev-avery-owner").get(`${base}/${path}`)).status).toBe(404);
      }
      expect((await off.as("dev-avery-owner").get(`${base}/jobs`)).status).toBe(200);
      expect((await off.as("dev-avery-owner").get(`${base}/dashboard`)).status).toBe(200);
    } finally {
      await off.close();
    }
  });
});
