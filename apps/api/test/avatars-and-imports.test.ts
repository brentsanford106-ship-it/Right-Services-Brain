import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { adminClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/** Profile pictures and photos added from the phone's library (JB, 2026-11-23). */
let t: TestApp;
let selfie: Buffer;
let jpeg: Buffer;

beforeAll(async () => {
  t = await createTestApp();
  selfie = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 220, g: 180, b: 150 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "SyntheticCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" } })
    .toBuffer();
  jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#336699" } }).jpeg().toBuffer();
});
afterAll(async () => { await t.close(); });

const A = `/v1/orgs/${ORG_A}`;
const B = `/v1/orgs/${ORG_B}`;
const hp1001 = F.jobs[0].id;
const EZRA = "00000000-0000-4b00-8000-00000000a004";
const MORGAN = "00000000-0000-4b00-8000-00000000a002";

describe("profile pictures", () => {
  it("a person sets their own picture; it is shrunk, cleaned of metadata, and shown on their photos", async () => {
    const put = await t.as("dev-ezra-field").put(`${A}/me/avatar`, selfie, "image/jpeg");
    expect(put.status).toBe(200);
    expect(put.body.avatarAt).toEqual(expect.any(String));
    const me = await t.as("dev-ezra-field").get(A);
    expect(me.body).toMatchObject({ displayName: "Ezra Field", avatarAt: put.body.avatarAt });

    const img = await t.as("dev-avery-owner").raw(`${A}/members/${EZRA}/avatar`);
    expect(img.status).toBe(200);
    expect(img.headers["cache-control"]).toBe("private, no-store");
    const meta = await sharp(img.data).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
    expect(meta.exif).toBeUndefined();

    // Ezra's photos now say when his picture changed, so screens show it instead of initials.
    const hp1002 = F.jobs[1].id; // Ezra is assigned
    const rec = await t.as("dev-ezra-field").post(`${A}/jobs/${hp1002}/photos`, { clientRef: uuid(), stage: "before", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg" });
    expect(rec.body.photographerAvatarAt).toBe(put.body.avatarAt);
  });

  it("nobody can see another company's pictures, and you can only change your own", async () => {
    await t.as("dev-ezra-field").put(`${A}/me/avatar`, selfie, "image/jpeg");
    expect((await t.as("dev-riley-owner").raw(`${A}/members/${EZRA}/avatar`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").raw(`${B}/members/${EZRA}/avatar`)).status).toBe(404);
    // An employee can't remove someone else's picture...
    expect((await t.as("dev-eli-employee").del(`${A}/members/${EZRA}/avatar`)).status).toBe(403);
    // ...and another company's owner can't either.
    expect((await t.as("dev-riley-owner").del(`${B}/members/${EZRA}/avatar`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").raw(`${A}/members/${EZRA}/avatar`)).status).toBe(200);
  });

  it("an owner can take down someone's picture, the file is deleted, and it is audited", async () => {
    await t.as("dev-ezra-field").put(`${A}/me/avatar`, selfie, "image/jpeg");
    expect((await t.as("dev-avery-owner").del(`${A}/members/${EZRA}/avatar`)).status).toBe(204);
    expect((await t.as("dev-avery-owner").raw(`${A}/members/${EZRA}/avatar`)).status).toBe(404);
    expect(await t.storage.get(`org/${ORG_A}/avatars/${EZRA}`)).toBeNull();
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE action = 'avatar.removed' AND target_id = $1", [EZRA]);
      expect(rows.some((r) => r.metadata?.byManager === true)).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it("people can remove their own picture", async () => {
    await t.as("dev-morgan-manager").put(`${A}/me/avatar`, selfie, "image/jpeg");
    expect((await t.as("dev-morgan-manager").del(`${A}/me/avatar`)).status).toBe(204);
    expect((await t.as("dev-morgan-manager").get(A)).body.avatarAt).toBeNull();
    expect((await t.as("dev-avery-owner").raw(`${A}/members/${MORGAN}/avatar`)).status).toBe(404);
  });

  it("rejects files that aren't real pictures", async () => {
    expect((await t.as("dev-eli-employee").put(`${A}/me/avatar`, Buffer.from("not an image"), "image/jpeg")).status).toBe(400);
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
    expect((await t.as("dev-eli-employee").put(`${A}/me/avatar`, png, "image/jpeg")).status).toBe(400);
    expect((await t.as("dev-eli-employee").put(`${A}/me/avatar`, png, "image/png")).status).toBe(200);
  });
});

describe("photos added from the phone's library", () => {
  const imported = (extra: Record<string, unknown> = {}) => ({
    clientRef: uuid(), stage: "before", capturedAt: "2025-06-01T12:00:00Z", contentType: "image/jpeg", captureSource: "imported", ...extra,
  });

  it("are marked Imported, with who took them unknown and the uploader recorded", async () => {
    const rec = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, imported());
    expect(rec.status).toBe(201);
    expect(rec.body).toMatchObject({ captureSource: "imported", photographerId: null, photographer: null, uploadedBy: "Eli Employee", takenByMe: false, uploadedByMe: true, capturedAtKnown: true });
    expect((await t.as("dev-eli-employee").put(`${A}/photos/${rec.body.id}/content`, jpeg, "image/jpeg")).status).toBe(200);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT metadata FROM audit_events WHERE action = 'photo.recorded' AND target_id = $1", [rec.body.id]);
      expect(rows[0].metadata.source).toBe("imported");
    } finally {
      await admin.end();
    }
  });

  it("can say the date taken isn't known; in-app photos can't", async () => {
    const rec = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, imported({ capturedAt: new Date().toISOString(), capturedAtKnown: false }));
    expect(rec.body.capturedAtKnown).toBe(false);
    const bad = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, imported({ captureSource: "in_app_camera", capturedAtKnown: false }));
    expect(bad.status).toBe(400);
    // The phone can't claim a website upload either.
    expect((await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, imported({ captureSource: "web_upload" }))).status).toBe(400);
  });

  it("need the 'Add photos from the photo library' permission, which an owner can switch off", async () => {
    const admin = await adminClient();
    try {
      await admin.query("DELETE FROM role_permissions WHERE organization_id = $1 AND permission_key = 'photos.import' AND role_id IN (SELECT id FROM roles WHERE organization_id = $1 AND key = 'employee')", [ORG_A]);
      expect((await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, imported())).status).toBe(403);
      // Taking photos in the app still works.
      expect((await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, imported({ captureSource: "in_app_camera" }))).status).toBe(201);
    } finally {
      await admin.query(
        "INSERT INTO role_permissions (organization_id, role_id, permission_key) SELECT organization_id, id, 'photos.import' FROM roles WHERE organization_id = $1 AND key = 'employee' ON CONFLICT DO NOTHING",
        [ORG_A],
      );
      await admin.end();
    }
  });

  it("every default role starts with the permission", async () => {
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.organization_id = $1 AND rp.permission_key = 'photos.import' ORDER BY 1", [ORG_A]);
      expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(["employee", "manager", "owner"]));
    } finally {
      await admin.end();
    }
  });
});
