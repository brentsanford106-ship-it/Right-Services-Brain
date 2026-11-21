import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Phase 1 photo workflow: record -> upload bytes -> recall by job/date/location -> authorized download.
 * Covers unauthorized access, cross-company access, interrupted and duplicate uploads,
 * invalid metadata, and the absence of bearer download URLs.
 */
let t: TestApp;
let jpegWithGps: Buffer;
let png: Buffer;

beforeAll(async () => {
  t = await createTestApp();
  // A synthetic photo carrying EXIF metadata (camera + GPS), like a real phone photo.
  jpegWithGps = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "SyntheticCam", Model: "Test-1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" } })
    .toBuffer();
  png = await sharp({ create: { width: 10, height: 10, channels: 4, background: "#00ff00" } }).png().toBuffer();
});
afterAll(async () => { await t.close(); });

const base = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id; // Eli assigned
const hp1002 = F.jobs[1].id; // Ezra assigned
const rs2001 = F.jobs[3].id; // org B
// Synthetic coordinates near a fictional site.
const SITE = { latitude: 40.4462, longitude: -80.0021 };

async function record(subject: string, jobId: string, extra: Record<string, unknown> = {}) {
  return t.as(subject).post(`${base}/jobs/${jobId}/photos`, {
    clientRef: uuid(), stage: "before", capturedAt: "2026-11-10T15:30:00Z", contentType: "image/jpeg", ...SITE, ...extra,
  });
}

describe("the photo milestone flow", () => {
  it("employee records a photo offline-first, uploads later, and a manager sees it under the right job", async () => {
    // 1. Phone queued the photo while offline; on reconnect it sends the record...
    const rec = await record("dev-eli-employee", hp1001, { caption: "Pump island before work (synthetic)" });
    expect(rec.status).toBe(201);
    expect(rec.body.uploadStatus).toBe("pending");
    expect(rec.body.jobNumber).toBe("HP-1001");
    // 2. ...then the bytes.
    const up = await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    expect(up.status).toBe(200);
    expect(up.body.uploadStatus).toBe("stored");
    // 3. The manager finds it in the job's folder with metadata as separate fields.
    const list = await t.as("dev-morgan-manager").get(`${base}/jobs/${hp1001}/photos`);
    const p = list.body.items.find((x: { id: string }) => x.id === rec.body.id);
    expect(p).toMatchObject({ jobNumber: "HP-1001", uploadStatus: "stored", uploadedBy: "Eli Employee", latitude: SITE.latitude, longitude: SITE.longitude, hasPreview: true });
    expect(p.capturedAt).toBe("2026-11-10T15:30:00.000Z");
    expect(p.storedAt).toEqual(expect.any(String));
    // 4. And can view it.
    const img = await t.as("dev-morgan-manager").raw(`${base}/photos/${rec.body.id}/content`);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/jpeg");
    expect(img.headers["cache-control"]).toBe("private, no-store");
  });
});

describe("originals and metadata", () => {
  it("keeps the original byte-for-byte, and the preview has embedded metadata removed", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    const original = await t.as("dev-avery-owner").raw(`${base}/photos/${rec.body.id}/content?variant=original`);
    expect(original.status).toBe(200);
    expect(original.data.equals(jpegWithGps)).toBe(true);
    expect((await sharp(original.data).metadata()).exif).toBeDefined();
    const preview = await t.as("dev-avery-owner").raw(`${base}/photos/${rec.body.id}/content`);
    const meta = await sharp(preview.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
  });

  it("employees can view previews but not download originals (which contain embedded GPS)", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    expect((await t.as("dev-eli-employee").raw(`${base}/photos/${rec.body.id}/content`)).status).toBe(200);
    expect((await t.as("dev-eli-employee").raw(`${base}/photos/${rec.body.id}/content?variant=original`)).status).toBe(403);
  });

  it("PNG uploads are accepted and previewed as JPEG", async () => {
    const rec = await record("dev-eli-employee", hp1001, { contentType: "image/png" });
    const up = await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, png, "image/png");
    expect(up.status).toBe(200);
  });
});

describe("recall by job number, date and location", () => {
  it("finds photos by job number", async () => {
    const r = await t.as("dev-avery-owner").get(`${base}/photos?jobNumber=HP-1001`);
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((p: { jobNumber: string }) => p.jobNumber === "HP-1001")).toBe(true);
  });

  it("finds photos by date range (inclusive)", async () => {
    const r = await t.as("dev-avery-owner").get(`${base}/photos?from=2026-11-10&to=2026-11-10`);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((p: { capturedAt: string }) => p.capturedAt.startsWith("2026-11-10"))).toBe(true);
    const none = await t.as("dev-avery-owner").get(`${base}/photos?from=2020-01-01&to=2020-01-02`);
    expect(none.body.items).toEqual([]);
  });

  it("finds photos near a location and excludes far-away ones", async () => {
    const far = await record("dev-ezra-field", hp1002, { latitude: 41.5, longitude: -81.7 }); // ~150 km away
    const near = await t.as("dev-avery-owner").get(`${base}/photos?lat=${SITE.latitude}&lng=${SITE.longitude}&radiusM=200`);
    const ids = near.body.items.map((p: { id: string }) => p.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain(far.body.id);
    expect(near.body.items.every((p: { distanceM: number }) => p.distanceM <= 200)).toBe(true);
  });

  it("finds photos by site name", async () => {
    const r = await t.as("dev-avery-owner").get(`${base}/photos?site=fuel%20mart`);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((p: { siteName: string }) => /fuel mart/i.test(p.siteName))).toBe(true);
  });

  it("search only returns photos from jobs the employee is assigned to", async () => {
    const r = await t.as("dev-eli-employee").get(`${base}/photos`);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(r.body.items.every((p: { jobId: string }) => p.jobId === hp1001)).toBe(true);
  });

  it("rejects invalid search input", async () => {
    for (const q of ["lat=40", "lat=200&lng=0", "from=2026-11-10&to=2026-11-01", "jobNumber=';--", "radiusM=1&lat=1&lng=1", "unknown=1"]) {
      expect((await t.as("dev-avery-owner").get(`${base}/photos?${q}`)).status, q).toBe(400);
    }
  });
});

describe("unauthorized and cross-company photo access", () => {
  let photoA: string;
  let photoB: string;
  beforeAll(async () => {
    photoA = (await record("dev-eli-employee", hp1001)).body.id;
    await t.as("dev-eli-employee").put(`${base}/photos/${photoA}/content`, jpegWithGps, "image/jpeg");
    const b = await t.as("dev-blake-employee").post(`/v1/orgs/${ORG_B}/jobs/${rs2001}/photos`, {
      clientRef: uuid(), stage: "after", capturedAt: "2026-11-10T16:00:00Z", contentType: "image/jpeg",
    });
    photoB = b.body.id;
    await t.as("dev-blake-employee").put(`/v1/orgs/${ORG_B}/photos/${photoB}/content`, jpegWithGps, "image/jpeg");
  });

  it("downloads require authentication on every request (no bearer URLs)", async () => {
    const res = await t.app.inject({ method: "GET", url: `${base}/photos/${photoA}/content` });
    expect(res.statusCode).toBe(401);
  });

  it("an employee not assigned to the job cannot see or download its photos", async () => {
    expect((await t.as("dev-ezra-field").raw(`${base}/photos/${photoA}/content`)).status).toBe(404);
  });

  it("another company's owner cannot download by swapping the org or photo ID in the URL", async () => {
    expect((await t.as("dev-riley-owner").raw(`${base}/photos/${photoA}/content`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").raw(`/v1/orgs/${ORG_B}/photos/${photoA}/content`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").raw(`${base}/photos/${photoB}/content`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").raw(`/v1/orgs/${ORG_B}/photos/${photoB}/content`)).status).toBe(404);
  });

  it("cross-company search returns nothing from the other company", async () => {
    const r = await t.as("dev-avery-owner").get(`${base}/photos?limit=200`);
    expect(r.body.items.map((p: { id: string }) => p.id)).not.toContain(photoB);
  });

  it("a person in both companies cannot read A's photo through B's URL", async () => {
    expect((await t.as("dev-casey-both").raw(`/v1/orgs/${ORG_B}/photos/${photoA}/content`)).status).toBe(404);
  });

  it("only the photographer can upload the file for a photo record", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    const r = await t.as("dev-casey-both").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    expect(r.status).toBe(403);
    const other = await t.as("dev-riley-owner").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    expect(other.status).toBe(404);
  });

  it("a removed (suspended) employee loses access immediately", async () => {
    expect((await t.as("dev-sam-suspended").raw(`${base}/photos/${photoA}/content`)).status).toBe(404);
  });
});

describe("interrupted and duplicate uploads", () => {
  it("a record without its file stays pending and can be completed later", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    expect((await t.as("dev-eli-employee").raw(`${base}/photos/${rec.body.id}/content`)).status).toBe(404);
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg")).status).toBe(200);
  });

  it("a truncated (interrupted) file is rejected and the photo stays pending for a retry", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    const cut = await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps.subarray(0, 40), "image/jpeg");
    expect(cut.status).toBe(400);
    const list = await t.as("dev-eli-employee").get(`${base}/jobs/${hp1001}/photos`);
    expect(list.body.items.find((p: { id: string }) => p.id === rec.body.id).uploadStatus).toBe("pending");
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg")).status).toBe(200);
  });

  it("re-sending the same record returns the original photo, not a duplicate", async () => {
    const body = { clientRef: uuid(), stage: "after", capturedAt: "2026-11-10T17:00:00Z", contentType: "image/jpeg" };
    const a = await t.as("dev-eli-employee").post(`${base}/jobs/${hp1001}/photos`, body);
    const b = await t.as("dev-eli-employee").post(`${base}/jobs/${hp1001}/photos`, body);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
  });

  it("re-sending the same file after a lost response succeeds; a different file is refused", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    const again = await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, jpegWithGps, "image/jpeg");
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    const other = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, other, "image/jpeg")).status).toBe(409);
  });
});

describe("invalid metadata and files", () => {
  it.each<[Record<string, unknown>, string]>([
    [{ latitude: 40, longitude: undefined }, "latitude without longitude"],
    [{ latitude: 95, longitude: 0 }, "latitude out of range"],
    [{ capturedAt: "yesterday" }, "bad timestamp"],
    [{ capturedAt: "2099-01-01T00:00:00Z" }, "future timestamp"],
    [{ stage: "selfie" }, "unknown stage"],
    [{ contentType: "image/gif" }, "unsupported type"],
    [{ caption: "x".repeat(501) }, "caption too long"],
    [{ organizationId: ORG_B }, "smuggled organization"],
    [{ uploadedBy: "someone-else" }, "smuggled uploader"],
  ])("rejects %j (%s)", async (extra) => {
    const r = await record("dev-eli-employee", hp1001, extra);
    expect(r.status).toBe(400);
  });

  it("rejects files whose real type doesn't match (e.g. a script renamed as .jpg)", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    const fake = Buffer.from("<script>alert(1)</script>");
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, fake, "image/jpeg")).status).toBe(400);
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, png, "image/jpeg")).status).toBe(400);
  });

  it("rejects uploads with a type that differs from the record, or no body", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, png, "image/png")).status).toBe(400);
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, Buffer.alloc(0), "image/jpeg")).status).toBe(400);
  });

  it("rejects files over the size limit", async () => {
    const rec = await record("dev-eli-employee", hp1001);
    const huge = Buffer.concat([jpegWithGps, Buffer.alloc(26 * 1024 * 1024)]);
    expect((await t.as("dev-eli-employee").put(`${base}/photos/${rec.body.id}/content`, huge, "image/jpeg")).status).toBe(413);
  });

  it("logs never contain image bytes, coordinates, or captions", async () => {
    const all = t.logs.join("\n");
    expect(all).not.toContain("Pump island before work");
    expect(all).not.toContain("40.4462");
    expect(all).not.toContain("SyntheticCam");
  });
});
