import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { adminClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Who took each photo (JB's spec, part 3): photographer kept separate from uploader, shown to the office,
 * "Photos I took", names kept after someone leaves, attribution can't be changed, and small gallery thumbnails.
 */
let t: TestApp;
let bigJpeg: Buffer;

beforeAll(async () => {
  t = await createTestApp();
  bigJpeg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 30, g: 90, b: 160 } } }).jpeg().toBuffer();
});
afterAll(async () => { await t.close(); });

const A = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id; // Eli is assigned
const ELI = "00000000-0000-4b00-8000-00000000a003";
const SAM = "00000000-0000-4b00-8000-00000000a005"; // suspended employee
const MORGAN = "00000000-0000-4b00-8000-00000000a002";

async function photoBy(subject: string, upload = true) {
  const rec = await t.as(subject).post(`${A}/jobs/${hp1001}/photos`, {
    clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg",
  });
  expect(rec.status).toBe(201);
  if (upload) expect((await t.as(subject).put(`${A}/photos/${rec.body.id}/content`, bigJpeg, "image/jpeg")).status).toBe(200);
  return rec.body.id as string;
}

const find = async (subject: string, id: string) =>
  (await t.as(subject).get(`${A}/jobs/${hp1001}/photos`)).body.items.find((x: { id: string }) => x.id === id);

describe("who took each photo", () => {
  it("a photo from the in-app camera is credited to the person who took it, and the office sees who", async () => {
    const id = await photoBy("dev-eli-employee");
    const asManager = await find("dev-morgan-manager", id);
    expect(asManager).toMatchObject({
      photographerId: ELI, photographer: "Eli Employee", uploadedBy: "Eli Employee",
      captureSource: "in_app_camera", takenByMe: false, uploadedByMe: false,
    });
    const asEli = await find("dev-eli-employee", id);
    expect(asEli).toMatchObject({ takenByMe: true, uploadedByMe: true });
  });

  it("a person's name stays on their photos after they are suspended", async () => {
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO photos (organization_id, job_id, content_type, stage, captured_at, uploaded_by_membership_id)
         VALUES ($1, $2, 'image/jpeg', 'after', '2026-10-01T09:00:00Z', $3) RETURNING id`,
        [ORG_A, hp1001, SAM],
      );
      const p = await find("dev-avery-owner", rows[0]!.id);
      expect(p).toMatchObject({ photographerId: SAM, photographer: "Sam Suspended" });
    } finally {
      await admin.end();
    }
  });

  it("the database refuses an in-app photo credited to someone other than its uploader", async () => {
    const admin = await adminClient();
    try {
      await expect(
        admin.query(
          `INSERT INTO photos (organization_id, job_id, content_type, stage, captured_at, uploaded_by_membership_id, photographer_membership_id)
           VALUES ($1, $2, 'image/jpeg', 'after', now(), $3, $4)`,
          [ORG_A, hp1001, ELI, MORGAN],
        ),
      ).rejects.toThrow(/photos_in_app_photographer/);
      // An imported photo may have an unknown photographer, and the office sees "unknown" (null), not the uploader.
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO photos (organization_id, job_id, content_type, stage, captured_at, uploaded_by_membership_id, capture_source)
         VALUES ($1, $2, 'image/jpeg', 'before', now(), $3, 'imported') RETURNING id`,
        [ORG_A, hp1001, ELI],
      );
      const p = await find("dev-morgan-manager", rows[0]!.id);
      expect(p).toMatchObject({ photographerId: null, photographer: null, uploadedBy: "Eli Employee", captureSource: "imported", takenByMe: false });
    } finally {
      await admin.end();
    }
  });

  it("who took or uploaded a photo can never be changed afterwards, even by the database owner", async () => {
    const id = await photoBy("dev-eli-employee", false);
    const admin = await adminClient();
    try {
      await expect(admin.query("UPDATE photos SET photographer_membership_id = $2 WHERE id = $1", [id, MORGAN])).rejects.toThrow(/cannot be changed/);
      await expect(admin.query("UPDATE photos SET uploaded_by_membership_id = $2 WHERE id = $1", [id, MORGAN])).rejects.toThrow(/cannot be changed/);
      await expect(admin.query("UPDATE photos SET capture_source = 'imported' WHERE id = $1", [id])).rejects.toThrow(/cannot be changed/);
      // Ordinary edits still work.
      await admin.query("UPDATE photos SET caption = 'still editable' WHERE id = $1", [id]);
    } finally {
      await admin.end();
    }
  });

  it("the photo API never lets a phone choose who took a photo", async () => {
    const r = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, {
      clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg", photographerId: MORGAN,
    });
    expect(r.status).toBe(400);
  });
});

describe("gallery thumbnails", () => {
  it("serves a small thumbnail for grids, and the full preview for the photo screen", async () => {
    const id = await photoBy("dev-eli-employee");
    const thumb = await t.as("dev-morgan-manager").raw(`${A}/photos/${id}/content?variant=thumb`);
    expect(thumb.status).toBe(200);
    expect(thumb.headers["cache-control"]).toBe("private, no-store");
    const tm = await sharp(thumb.data).metadata();
    expect(Math.max(tm.width!, tm.height!)).toBeLessThanOrEqual(480);
    expect(tm.exif).toBeUndefined();
    const preview = await t.as("dev-morgan-manager").raw(`${A}/photos/${id}/content`);
    expect((await sharp(preview.data).metadata()).width).toBe(1600);
    expect(thumb.data.length).toBeLessThan(preview.data.length);
  });

  it("photos uploaded before thumbnails existed fall back to the preview", async () => {
    const id = await photoBy("dev-eli-employee");
    await t.storage.delete(`org/${ORG_A}/photos/${id}/thumb`);
    const r = await t.as("dev-morgan-manager").raw(`${A}/photos/${id}/content?variant=thumb`);
    expect(r.status).toBe(200);
    expect((await sharp(r.data).metadata()).width).toBe(1600);
  });

  it("thumbnails are behind the same walls as photos: other companies and unassigned employees get nothing", async () => {
    const id = await photoBy("dev-eli-employee");
    expect((await t.as("dev-riley-owner").raw(`${A}/photos/${id}/content?variant=thumb`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").raw(`/v1/orgs/${ORG_B}/photos/${id}/content?variant=thumb`)).status).toBe(404);
    expect((await t.as("dev-ezra-field").raw(`${A}/photos/${id}/content?variant=thumb`)).status).toBe(404);
  });

  it("deleting a photo forever also removes its thumbnail", async () => {
    const id = await photoBy("dev-eli-employee");
    const key = `org/${ORG_A}/photos/${id}/thumb`;
    expect(await t.storage.get(key)).not.toBeNull();
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${id}`)).status).toBeLessThan(300);
    expect((await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [id] })).status).toBeLessThan(300);
    expect(await t.storage.get(key)).toBeNull();
  });
});
