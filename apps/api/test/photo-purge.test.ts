import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";
import { purgeExpiredPhotos } from "../src/lib/purge.js";

/** "Delete forever" from Recently Deleted, the per-company keep-time setting, and the scheduled clean-up. */
let t: TestApp;
let jpeg: Buffer;
const A = `/v1/orgs/${ORG_A}`;
const B = `/v1/orgs/${ORG_B}`;
const hp1001 = F.jobs[0].id; // Eli assigned
const rs2001 = F.jobs[3].id; // Blake assigned (company B)

beforeAll(async () => {
  t = await createTestApp();
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#996633" } }).jpeg().toBuffer();
});
afterAll(async () => {
  const admin = await adminClient();
  await admin.query("UPDATE organizations SET deleted_photo_retention_days = 30");
  await admin.end();
  await t.close();
});

/** Takes a photo with its image uploaded, then deletes it (moves it to Recently Deleted). */
async function deletedPhoto(subject: string, org: string, jobId: string): Promise<string> {
  const who = t.as(subject);
  const rec = await who.post(`${org}/jobs/${jobId}/photos`, { clientRef: uuid(), stage: "after", capturedAt: "2026-11-15T10:00:00Z", contentType: "image/jpeg" });
  expect(rec.status).toBe(201);
  expect((await who.put(`${org}/photos/${rec.body.id}/content`, jpeg, "image/jpeg")).status).toBe(200);
  expect((await who.del(`${org}/photos/${rec.body.id}`)).status).toBe(204);
  return rec.body.id as string;
}

async function keysOf(photoId: string): Promise<string[]> {
  const admin = await adminClient();
  try {
    const { rows } = await admin.query("SELECT storage_key, preview_storage_key FROM photos WHERE id = $1", [photoId]);
    return rows[0] ? [rows[0].storage_key, rows[0].preview_storage_key].filter(Boolean) : [];
  } finally {
    await admin.end();
  }
}

async function exists(photoId: string): Promise<boolean> {
  const admin = await adminClient();
  try {
    return (await admin.query("SELECT 1 FROM photos WHERE id = $1", [photoId])).rows.length > 0;
  } finally {
    await admin.end();
  }
}

async function audits(action: string, photoId: string) {
  const admin = await adminClient();
  try {
    const { rows } = await admin.query("SELECT actor_membership_id, request_id, metadata FROM audit_events WHERE action = $1 AND target_id = $2", [action, photoId]);
    return rows as { actor_membership_id: string | null; request_id: string; metadata: Record<string, unknown> }[];
  } finally {
    await admin.end();
  }
}

describe("Delete forever", () => {
  it("only people with photos.purge (owners by default) can do it", async () => {
    const id = await deletedPhoto("dev-eli-employee", A, hp1001);
    expect((await t.as("dev-eli-employee").post(`${A}/photos/purge`, { photoIds: [id] })).status).toBe(403);
    expect((await t.as("dev-morgan-manager").post(`${A}/photos/purge`, { photoIds: [id] })).status).toBe(403);
    expect(await exists(id)).toBe(true);
  });

  it("removes the photo, its flags and its files for good; the audit log keeps the record", async () => {
    const id = await deletedPhoto("dev-eli-employee", A, hp1001);
    // A review flag on the photo must not block removal.
    expect((await t.as("dev-avery-owner").post(`${A}/photos/${id}/restore`)).status).toBe(200);
    expect((await t.as("dev-eli-employee").post(`${A}/photos/${id}/flags`, { reason: "check this" })).status).toBe(201);
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${id}`)).status).toBe(204);

    const keys = await keysOf(id);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(await t.storage.get(k)).not.toBeNull();

    const r = await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [id] });
    expect(r.status).toBe(204);
    expect(await exists(id)).toBe(false);
    for (const k of keys) expect(await t.storage.get(k)).toBeNull();
    expect((await t.as("dev-avery-owner").raw(`${A}/photos/${id}/content`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").post(`${A}/photos/${id}/restore`)).status).toBe(404);
    const deleted = await t.as("dev-avery-owner").get(`${A}/jobs/${hp1001}/photos/deleted`);
    expect(deleted.body.items.some((p: { id: string }) => p.id === id)).toBe(false);

    const a = await audits("photo.purged", id);
    expect(a).toHaveLength(1);
    expect(a[0]!.actor_membership_id).toBe("00000000-0000-4b00-8000-00000000a001");
    expect(a[0]!.metadata).toMatchObject({ jobId: hp1001, trigger: "manual" });
  });

  it("refuses photos that aren't in Recently Deleted (all or nothing)", async () => {
    const gone = await deletedPhoto("dev-eli-employee", A, hp1001);
    const live = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, { clientRef: uuid(), stage: "before", capturedAt: "2026-11-15T10:00:00Z", contentType: "image/jpeg" });
    const r = await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [gone, live.body.id] });
    expect(r.status).toBe(404);
    expect(await exists(gone)).toBe(true);
    expect(await exists(live.body.id)).toBe(true);
  });

  it("can't reach another company's photos", async () => {
    const theirs = await deletedPhoto("dev-blake-employee", B, rs2001);
    expect((await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [theirs] })).status).toBe(404);
    expect((await t.as("dev-avery-owner").post(`${B}/photos/purge`, { photoIds: [theirs] })).status).toBe(404);
    expect(await exists(theirs)).toBe(true);
  });

  it("the database itself refuses: no DELETE right on photos, and the purge function only takes deleted photos in your company", async () => {
    const live = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, { clientRef: uuid(), stage: "before", capturedAt: "2026-11-15T10:00:00Z", contentType: "image/jpeg" });
    const theirs = await deletedPhoto("dev-blake-employee", B, rs2001);
    const c = await appRoleClient();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_A]);
      expect((await c.query("SELECT * FROM app.purge_deleted_photo($1)", [live.body.id])).rows).toHaveLength(0);
      expect((await c.query("SELECT * FROM app.purge_deleted_photo($1)", [theirs])).rows).toHaveLength(0);
      await expect(c.query("DELETE FROM photos WHERE id = $1", [live.body.id])).rejects.toThrow(/permission denied/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
    expect(await exists(live.body.id)).toBe(true);
    expect(await exists(theirs)).toBe(true);
  });
});

describe("how long Recently Deleted keeps photos", () => {
  it("everyone can read it; only owners (org.manage) can change it, to one of the offered values", async () => {
    const eli = await t.as("dev-eli-employee").get(`${A}/settings`);
    expect(eli.body).toEqual({ deletedPhotoRetentionDays: 30, canEdit: false });
    expect((await t.as("dev-eli-employee").patch(`${A}/settings`, { deletedPhotoRetentionDays: 7 })).status).toBe(403);
    expect((await t.as("dev-morgan-manager").patch(`${A}/settings`, { deletedPhotoRetentionDays: 7 })).status).toBe(403);
    expect((await t.as("dev-avery-owner").patch(`${A}/settings`, { deletedPhotoRetentionDays: 45 })).status).toBe(400);
    expect((await t.as("dev-avery-owner").patch(`${A}/settings`, { deletedPhotoRetentionDays: 7 })).body).toEqual({ deletedPhotoRetentionDays: 7, canEdit: true });
    // Company B is unaffected.
    expect((await t.as("dev-riley-owner").get(`${B}/settings`)).body.deletedPhotoRetentionDays).toBe(30);
    expect((await t.as("dev-riley-owner").patch(`${A}/settings`, { deletedPhotoRetentionDays: 90 })).status).toBe(404);

    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE action = 'org.settings_updated' AND organization_id = $1 ORDER BY occurred_at DESC LIMIT 1", [ORG_A]);
      expect(rows[0].metadata).toMatchObject({ from: 30, to: 7 });
    } finally {
      await admin.end();
    }
  });

  it("Recently Deleted shows when each photo will be removed", async () => {
    const id = await deletedPhoto("dev-eli-employee", A, hp1001);
    const list = await t.as("dev-avery-owner").get(`${A}/jobs/${hp1001}/photos/deleted`);
    const p = list.body.items.find((x: { id: string }) => x.id === id);
    const days = (Date.parse(p.purgeAfter) - Date.parse(p.deletedAt)) / 86_400_000;
    expect(days).toBe(7);
  });

  it("the scheduled clean-up removes only photos past their own company's keep time", async () => {
    // Company A keeps 7 days (set above); company B keeps 30.
    const oldA = await deletedPhoto("dev-eli-employee", A, hp1001);
    const newA = await deletedPhoto("dev-eli-employee", A, hp1001);
    const oldB = await deletedPhoto("dev-blake-employee", B, rs2001);
    const admin = await adminClient();
    try {
      await admin.query("UPDATE photos SET deleted_at = now() - interval '8 days' WHERE id = ANY($1::uuid[])", [[oldA, oldB]]);
      await admin.query("UPDATE photos SET deleted_at = now() - interval '3 days' WHERE id = $1", [newA]);
    } finally {
      await admin.end();
    }
    const keys = await keysOf(oldA);

    const n = await purgeExpiredPhotos(t.db, t.storage, t.app.log);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await exists(oldA)).toBe(false);
    expect(await exists(newA)).toBe(true);
    expect(await exists(oldB)).toBe(true);
    for (const k of keys) expect(await t.storage.get(k)).toBeNull();

    const a = await audits("photo.purged", oldA);
    expect(a).toHaveLength(1);
    expect(a[0]!.actor_membership_id).toBeNull();
    expect(a[0]!.request_id).toBe("scheduled-cleanup");
    expect(a[0]!.metadata).toMatchObject({ trigger: "retention", keepDays: 7 });

    // Running again does nothing more.
    await purgeExpiredPhotos(t.db, t.storage, t.app.log);
    expect(await exists(newA)).toBe(true);
  });
});
