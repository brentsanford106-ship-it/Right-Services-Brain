import type { FastifyInstance } from "fastify";
import {
  CreatePhotoFlagRequest,
  CreatePhotoRequest,
  FlagParams,
  JobParams,
  OrgParams,
  PHOTO_MAX_UPLOAD_BYTES,
  PhotoContentQuery,
  PhotoParams,
  PhotoSearchQuery,
  ResolvePhotoFlagRequest,
  type Photo,
} from "@rsb/contracts";
import { inOrg } from "../lib/context.js";
import type { OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess, jobVisibilitySql } from "../lib/access.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import { HttpError, notFound } from "../lib/errors.js";
import { processUpload, sha256 } from "../lib/image.js";
import { photoKey } from "../storage/types.js";
import type { RouteDeps } from "./index.js";

interface PhotoRow {
  id: string;
  job_id: string;
  job_number: string;
  site_name: string | null;
  stage: Photo["stage"];
  caption: string | null;
  captured_at: Date;
  stored_at: Date | null;
  upload_status: Photo["uploadStatus"];
  uploaded_by: string;
  open_flags: number;
  latitude: number | null;
  longitude: number | null;
  width_px: number | null;
  height_px: number | null;
  has_preview: boolean;
}

const PHOTO_SELECT = `SELECT p.id, p.job_id, j.job_number, j.site_name, p.stage, p.caption, p.captured_at, p.stored_at, p.upload_status,
                             u.display_name AS uploaded_by, p.latitude, p.longitude, p.width_px, p.height_px,
                             (p.preview_storage_key IS NOT NULL) AS has_preview,
                             (SELECT count(*)::int FROM photo_flags f WHERE f.organization_id = p.organization_id AND f.photo_id = p.id AND f.status = 'open') AS open_flags
                        FROM photos p
                        JOIN jobs j ON j.organization_id = p.organization_id AND j.id = p.job_id
                        JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.id = p.uploaded_by_membership_id
                        JOIN users u ON u.id = m.user_id`;

const toPhoto = (r: PhotoRow): Photo => ({
  id: r.id,
  jobId: r.job_id,
  jobNumber: r.job_number,
  siteName: r.site_name,
  stage: r.stage,
  caption: r.caption,
  capturedAt: r.captured_at.toISOString(),
  storedAt: r.stored_at?.toISOString() ?? null,
  uploadStatus: r.upload_status,
  uploadedBy: r.uploaded_by,
  openFlags: r.open_flags,
  latitude: r.latitude,
  longitude: r.longitude,
  widthPx: r.width_px,
  heightPx: r.height_px,
  hasPreview: r.has_preview,
});

/** Loads a photo the caller is allowed to see (via its job), or throws 404. */
async function loadVisiblePhoto(tx: Tx, ctx: OrgContext, photoId: string) {
  const { rows } = await tx.query<{
    job_id: string; uploaded_by_membership_id: string; upload_status: string; content_type: string;
    storage_key: string | null; preview_storage_key: string | null; original_sha256: string | null;
  }>(
    `SELECT job_id, uploaded_by_membership_id, upload_status, content_type, storage_key, preview_storage_key, original_sha256
       FROM photos WHERE id = $1 AND deleted_at IS NULL`,
    [photoId],
  );
  const row = rows[0];
  if (!row) throw notFound();
  await assertJobAccess(tx, ctx, row.job_id);
  return row;
}

export async function photoRoutes(app: FastifyInstance, { db, storage }: RouteDeps): Promise<void> {
  // Raw image bodies for the content upload route only. JSON routes keep the small global body limit.
  for (const type of ["image/jpeg", "image/png", "image/heic"]) {
    app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: PHOTO_MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
  }

  // ------------------------------------------------------------ list per job ("folder")
  app.get("/v1/orgs/:orgId/jobs/:jobId/photos", async (req) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await assertJobAccess(tx, ctx, jobId);
      const { rows } = await tx.query<PhotoRow>(
        `${PHOTO_SELECT} WHERE p.job_id = $1 AND p.deleted_at IS NULL ORDER BY p.captured_at`,
        [jobId],
      );
      return { items: rows.map(toPhoto) };
    });
  });

  // ------------------------------------------------------------ search / recall
  app.get("/v1/orgs/:orgId/photos", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const q = parse(PhotoSearchQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const vis = jobVisibilitySql(ctx); // only photos on jobs the caller can see
      const where: string[] = ["p.deleted_at IS NULL", `(${vis.where})`];
      const params: unknown[] = [ctx.membershipId];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replaceAll("?", `$${params.length}`));
      };
      if (q.jobNumber) add("j.job_number = ?", q.jobNumber);
      if (q.site) add("(j.site_name ILIKE ? OR j.site_address ILIKE ?)", `%${q.site.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      if (q.stage) add("p.stage = ?", q.stage);
      if (q.from) add("p.captured_at >= ?::date", q.from);
      if (q.to) add("p.captured_at < (?::date + 1)", q.to);
      let distanceSql = "NULL::double precision";
      if (q.lat !== undefined && q.lng !== undefined) {
        params.push(q.lat, q.lng, q.radiusM);
        const [la, lo, r] = [params.length - 2, params.length - 1, params.length];
        // Great-circle (haversine) distance in metres, computed in SQL. Coarse bounding box first for speed.
        distanceSql = `(2 * 6371000 * asin(sqrt(power(sin(radians(p.latitude - $${la}) / 2), 2)
                         + cos(radians($${la})) * cos(radians(p.latitude)) * power(sin(radians(p.longitude - $${lo}) / 2), 2))))`;
        where.push(`p.latitude BETWEEN $${la} - ($${r} / 111000.0) AND $${la} + ($${r} / 111000.0)`);
        where.push(`${distanceSql} <= $${r}`);
      }
      params.push(q.limit);
      const { rows } = await tx.query<PhotoRow & { distance_m: number | null }>(
        `${PHOTO_SELECT.replace("SELECT p.id,", `SELECT ${distanceSql} AS distance_m, p.id,`)}
          WHERE ${where.join(" AND ")}
          ORDER BY p.captured_at DESC LIMIT $${params.length}`,
        params,
      );
      return { items: rows.map((r) => ({ ...toPhoto(r), distanceM: r.distance_m === null ? null : Math.round(r.distance_m) })) };
    });
  });

  // ------------------------------------------------------------ step 1: record the photo
  app.post("/v1/orgs/:orgId/jobs/:jobId/photos", async (req, reply) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    const body = parse(CreatePhotoRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.upload");
      await assertJobAccess(tx, ctx, jobId);
      if (new Date(body.capturedAt).getTime() > Date.now() + 5 * 60_000) {
        throw new HttpError("validation_failed", undefined, [{ path: "capturedAt", issue: "cannot be in the future" }]);
      }
      const { id, created } = await insertIdempotent(
        tx, "photos", body.clientRef, ctx.membershipId,
        `INSERT INTO photos (organization_id, job_id, content_type, stage, caption, captured_at, uploaded_by_membership_id,
                             client_ref, latitude, longitude, location_accuracy_m)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, jobId, body.contentType, body.stage, body.caption ?? null, body.capturedAt, ctx.membershipId,
         body.clientRef, body.latitude ?? null, body.longitude ?? null, body.locationAccuracyM ?? null],
      );
      if (created) await recordAudit(tx, ctx, "photo.recorded", "photo", id, { jobId, hasLocation: body.latitude !== undefined });
      const { rows } = await tx.query<PhotoRow>(`${PHOTO_SELECT} WHERE p.id = $1`, [id]);
      return { photo: toPhoto(rows[0]!), created };
    });
    return reply.status(result.created ? 201 : 200).send(result.photo);
  });

  // ------------------------------------------------------------ step 2: upload the image bytes
  app.put("/v1/orgs/:orgId/photos/:photoId/content", async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError("validation_failed", "Send the image as the request body with Content-Type image/jpeg, image/png or image/heic.");
    }
    const bytes = req.body;
    const declared = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();

    // Authorize BEFORE doing any expensive image work.
    const photo = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.upload");
      const p = await loadVisiblePhoto(tx, ctx, photoId);
      if (p.uploaded_by_membership_id !== ctx.membershipId) throw new HttpError("forbidden", "Only the person who took this photo can upload its file.");
      if (p.content_type !== declared) throw new HttpError("validation_failed", "Content-Type does not match the photo record.");
      return p;
    });

    // Retry after an interrupted or lost response: the same bytes are accepted again; different bytes are rejected.
    if (photo.upload_status === "stored") {
      if (photo.original_sha256 === sha256(bytes)) return { id: photoId, uploadStatus: "stored", duplicate: true };
      throw new HttpError("conflict", "This photo already has a different file.");
    }

    const processed = await processUpload(bytes, declared);
    const originalKey = photoKey(orgId, photoId) + "/original";
    const previewKey = processed.preview ? photoKey(orgId, photoId) + "/preview" : null;
    // Files are written first, then the record is marked stored in one transaction.
    // If the process dies in between, the photo simply stays "pending" and the phone retries.
    await storage.put(originalKey, bytes, declared);
    if (processed.preview && previewKey) await storage.put(previewKey, processed.preview.data, "image/jpeg");

    return inOrg(db, req, orgId, async (tx, ctx) => {
      const { rowCount } = await tx.query(
        `UPDATE photos SET upload_status = 'stored', storage_key = $2, preview_storage_key = $3, original_sha256 = $4,
                           size_bytes = $5, width_px = $6, height_px = $7, stored_at = now()
          WHERE id = $1 AND upload_status = 'pending' AND uploaded_by_membership_id = $8`,
        [photoId, originalKey, previewKey, processed.originalSha256, bytes.length,
         processed.preview?.width ?? null, processed.preview?.height ?? null, ctx.membershipId],
      );
      if (!rowCount) throw new HttpError("conflict", "This photo was already uploaded.");
      await recordAudit(tx, ctx, "photo.stored", "photo", photoId, { bytes: bytes.length });
      return { id: photoId, uploadStatus: "stored", duplicate: false };
    });
  });

  // ------------------------------------------------------------ authenticated download
  app.get("/v1/orgs/:orgId/photos/:photoId/content", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const { variant } = parse(PhotoContentQuery, req.query);
    const file = await inOrg(db, req, orgId, async (tx, ctx) => {
      const p = await loadVisiblePhoto(tx, ctx, photoId);
      if (variant === "original") {
        ctx.require("photos.read_original");
        await recordAudit(tx, ctx, "photo.original_downloaded", "photo", photoId);
      }
      const key = variant === "original" ? p.storage_key : p.preview_storage_key;
      if (!key) throw notFound();
      return { key, contentType: variant === "original" ? p.content_type : "image/jpeg" };
    });
    const data = await storage.get(file.key);
    if (!data) throw notFound();
    return reply
      .header("content-type", file.contentType)
      .header("content-disposition", `inline; filename="${photoId}${file.contentType === "image/png" ? ".png" : file.contentType === "image/heic" ? ".heic" : ".jpg"}"`)
      .header("cache-control", "private, no-store")
      .header("cross-origin-resource-policy", "same-site")
      .send(data);
  });

  // ------------------------------------------------------------ flags
  app.post("/v1/orgs/:orgId/photos/:photoId/flags", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const body = parse(CreatePhotoFlagRequest, req.body);
    const flag = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_flags.create");
      await loadVisiblePhoto(tx, ctx, photoId);
      const { rows: f } = await tx.query<{ id: string }>(
        `INSERT INTO photo_flags (organization_id, photo_id, flagged_by_membership_id, reason)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [ctx.orgId, photoId, ctx.membershipId, body.reason],
      );
      await recordAudit(tx, ctx, "photo_flag.created", "photo_flag", f[0]!.id, { photoId });
      return { id: f[0]!.id, photoId, status: "open" as const };
    });
    return reply.status(201).send(flag);
  });

  app.post("/v1/orgs/:orgId/photo-flags/:flagId/resolve", async (req) => {
    const { orgId, flagId } = parse(FlagParams, req.params);
    const body = parse(ResolvePhotoFlagRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_flags.manage");
      const { rows } = await tx.query<{ id: string; status: string }>("SELECT id, status FROM photo_flags WHERE id = $1", [flagId]);
      if (!rows[0]) throw notFound();
      if (rows[0].status !== "open") throw new HttpError("conflict", "This flag is already resolved.");
      await tx.query(
        `UPDATE photo_flags SET status = 'resolved', resolved_by_membership_id = $2, resolution_note = $3, resolved_at = now()
          WHERE id = $1`,
        [flagId, ctx.membershipId, body.resolutionNote ?? null],
      );
      await recordAudit(tx, ctx, "photo_flag.resolved", "photo_flag", flagId);
      return { id: flagId, status: "resolved" as const };
    });
  });

  app.get("/v1/orgs/:orgId/photo-flags", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_flags.manage");
      const { rows } = await tx.query<{ id: string; photo_id: string; job_number: string; reason: string; created_at: Date }>(
        `SELECT f.id, f.photo_id, j.job_number, f.reason, f.created_at
           FROM photo_flags f
           JOIN photos p ON p.organization_id = f.organization_id AND p.id = f.photo_id
           JOIN jobs j ON j.organization_id = p.organization_id AND j.id = p.job_id
          WHERE f.status = 'open' ORDER BY f.created_at`,
      );
      return { items: rows.map((r) => ({ id: r.id, photoId: r.photo_id, jobNumber: r.job_number, reason: r.reason, createdAt: r.created_at.toISOString() })) };
    });
  });
}
