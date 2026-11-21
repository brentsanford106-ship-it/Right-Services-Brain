import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/** Deleting (soft delete + restore) and exporting photos, with permission checks and audit records. */
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const base = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id; // Eli assigned
const hp1002 = F.jobs[1].id; // Ezra assigned

async function shoot(subject: string, jobId: string) {
  const rec = await t.as(subject).post(`${base}/jobs/${jobId}/photos`, {
    clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg",
  });
  expect(rec.status).toBe(201);
  return rec.body as { id: string; canDelete: boolean };
}

async function auditCount(action: string, photoId: string) {
  const admin = await adminClient();
  try {
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND target_id = $2", [action, photoId]);
    return rows[0].n as number;
  } finally {
    await admin.end();
  }
}

describe("deleting photos", () => {
  it("an employee can delete their own photo; it disappears from the gallery and search, and is audited", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    expect(p.canDelete).toBe(true);
    const eli = t.as("dev-eli-employee");
    expect((await eli.del(`${base}/photos/${p.id}`)).status).toBe(204);
    const gallery = await eli.get(`${base}/jobs/${hp1001}/photos`);
    expect(gallery.body.items.map((x: { id: string }) => x.id)).not.toContain(p.id);
    const search = await t.as("dev-avery-owner").get(`${base}/photos?jobNumber=HP-1001`);
    expect(search.body.items.map((x: { id: string }) => x.id)).not.toContain(p.id);
    expect((await eli.patch(`${base}/photos/${p.id}`, { flagged: true })).status).toBe(404);
    expect((await eli.raw(`${base}/photos/${p.id}/content`)).status).toBe(404);
    expect(await auditCount("photo.deleted", p.id)).toBe(1);
  });

  it("deleting twice (retry) is harmless the second time: 404, not an error page", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    expect((await t.as("dev-eli-employee").del(`${base}/photos/${p.id}`)).status).toBe(204);
    expect((await t.as("dev-eli-employee").del(`${base}/photos/${p.id}`)).status).toBe(404);
  });

  it("an employee cannot delete someone else's photo", async () => {
    const p = await shoot("dev-morgan-manager", hp1001);
    const asEli = await t.as("dev-eli-employee").get(`${base}/jobs/${hp1001}/photos`);
    expect(asEli.body.items.find((x: { id: string }) => x.id === p.id).canDelete).toBe(false);
    expect((await t.as("dev-eli-employee").del(`${base}/photos/${p.id}`)).status).toBe(403);
  });

  it("an owner or manager can delete anyone's photo, see it in Recently deleted, and restore it", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    const morgan = t.as("dev-morgan-manager");
    expect((await morgan.del(`${base}/photos/${p.id}`)).status).toBe(204);
    const deleted = await morgan.get(`${base}/jobs/${hp1001}/photos/deleted`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.items.find((x: { id: string }) => x.id === p.id)).toMatchObject({ deletedBy: expect.any(String), deletedAt: expect.any(String) });
    const restored = await t.as("dev-avery-owner").post(`${base}/photos/${p.id}/restore`);
    expect(restored.status).toBe(200);
    const gallery = await t.as("dev-eli-employee").get(`${base}/jobs/${hp1001}/photos`);
    expect(gallery.body.items.map((x: { id: string }) => x.id)).toContain(p.id);
    expect(await auditCount("photo.restored", p.id)).toBe(1);
  });

  it("employees cannot see Recently deleted or restore", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    await t.as("dev-eli-employee").del(`${base}/photos/${p.id}`);
    expect((await t.as("dev-eli-employee").get(`${base}/jobs/${hp1001}/photos/deleted`)).status).toBe(403);
    expect((await t.as("dev-eli-employee").post(`${base}/photos/${p.id}/restore`)).status).toBe(403);
  });

  it("an employee cannot delete a photo on a job they are not assigned to (it is invisible to them)", async () => {
    const p = await shoot("dev-ezra-field", hp1002);
    expect((await t.as("dev-eli-employee").del(`${base}/photos/${p.id}`)).status).toBe(404);
  });

  it("another company can never delete or restore the photo", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    expect((await t.as("dev-riley-owner").del(`/v1/orgs/${ORG_B}/photos/${p.id}`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").del(`${base}/photos/${p.id}`)).status).toBe(404);
    await t.as("dev-eli-employee").del(`${base}/photos/${p.id}`);
    expect((await t.as("dev-riley-owner").post(`/v1/orgs/${ORG_B}/photos/${p.id}/restore`)).status).toBe(404);
  });
});

describe("exporting photos (Messages, Mail, download)", () => {
  it("records one audit entry per photo with the channel", async () => {
    const a = await shoot("dev-eli-employee", hp1001);
    const b = await shoot("dev-eli-employee", hp1001);
    const r = await t.as("dev-eli-employee").post(`${base}/photos/exports`, { photoIds: [a.id, b.id, a.id], channel: "share_sheet" });
    expect(r.status).toBe(200);
    expect(r.body.recorded).toBe(2);
    expect(await auditCount("photo.exported", a.id)).toBe(1);
    expect(await auditCount("photo.exported", b.id)).toBe(1);
  });

  it("refuses photos the person cannot see, and records nothing", async () => {
    const mine = await shoot("dev-eli-employee", hp1001);
    const hidden = await shoot("dev-ezra-field", hp1002);
    const r = await t.as("dev-eli-employee").post(`${base}/photos/exports`, { photoIds: [mine.id, hidden.id], channel: "download" });
    expect(r.status).toBe(404);
    expect(await auditCount("photo.exported", mine.id)).toBe(0);
  });

  it("can be switched off for a role", async () => {
    const p = await shoot("dev-eli-employee", hp1001);
    const admin = await adminClient();
    try {
      await admin.query(
        "DELETE FROM role_permissions WHERE permission_key = 'photos.export' AND role_id IN (SELECT id FROM roles WHERE organization_id = $1 AND key = 'employee')",
        [ORG_A],
      );
      expect((await t.as("dev-eli-employee").post(`${base}/photos/exports`, { photoIds: [p.id], channel: "share_sheet" })).status).toBe(403);
    } finally {
      await admin.query(
        "INSERT INTO role_permissions (organization_id, role_id, permission_key) SELECT organization_id, id, 'photos.export' FROM roles WHERE organization_id = $1 AND key = 'employee' ON CONFLICT DO NOTHING",
        [ORG_A],
      );
      await admin.end();
    }
  });
});
