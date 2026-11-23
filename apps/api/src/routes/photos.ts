import type { FastifyInstance } from "fastify";
import {
  CreatePhotoFlagRequest,
  CreatePhotoRequest,
  ExportPhotosRequest,
  PhotoIdsRequest,
  FlagParams,
  JobParams,
  OrgParams,
  PHOTO_MAX_UPLOAD_BYTES,
  PhotoContentQuery,
  PhotoParams,
  PhotoSearchQuery,
  ResolvePhotoFlagRequest,
  UpdatePhotoRequest,
  type DeletedPhoto,
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
import { purgeDeletedPhoto, removeFiles } from "../lib/purge.js";
import type { RouteDeps } from "./index.js";

interface PhotoRow {
  id: string;
  job_id: string;
  job_number: string;
  site_name: string | null;
  stage: Photo["stage"];
  caption: string | null;
  is_flagged: boolean;
  flagged_at: Date | null;
  captured_at: Date;
  stored_at: Date | null;
  upload_status: Photo["uploadStatus"];
  uploaded_by: string;
  uploaded_by_membership_id: string;
  open_flags: number;
  latitude: number | null;
  longitude: number | null;
  width_px: number | null;
  height_px: number | null;
  has_preview: boolean;
}

const PHOTO_SELECT = `SELECT p.id, p.job_id, j.job_number, j.site_name, p.stage, p.caption, p.is_flagged, p.flagged_at, p.captured_at, p.stored_at, p.upload_status,
                             u.display_name AS uploaded_by, p.uploaded_by_membership_id, p.latitude, p.longitude, p.width_px, p.height_px,
                             (p.preview_storage_key IS NOT NULL) AS has_preview,
                             (SELECT count(*)::int FROM photo_flags f WHERE f.organization_id = p.organization_id AND f.photo_id = p.id AND f.status = 'open') AS open_flags
                        FROM photos p
                        JOIN jobs j ON j.organization_id = p.organization_id AND j.id = p.job_id
                        JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.id = p.uploaded_by_membership_id
                        JOIN users u ON u.id = m.user_id`;

/** Everyone may delete their own photos; photos.delete_any lets owners/managers delete any photo they can see. */
const mayDelete = (ctx: OrgContext, uploadedBy: string) =>
  (uploadedBy === ctx.membershipId && ctx.has("photos.upload")) || ctx.has("photos.delete_any");

const toPhoto = (r: PhotoRow, ctx: OrgContext): Photo => ({
  id: r.id,
  jobId: r.job_id,
  jobNumber: r.job_number,
  siteName: r.site_name,
  stage: r.stage,
  note: r.caption,
  flagged: r.is_flagged,
  flaggedAt: r.flagged_at?.toISOString() ?? null,
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
  canDelete: mayDelete(ctx, r.uploaded_by_membership_id),
});

/** Loads a photo the caller is allowed to see (via its job), or throws 404. */
async function loadVisiblePhoto(tx: Tx, ctx: OrgContext, photoId: string, includeDeleted = false) {
  const { rows } = await tx.query<{
    job_id: string; uploaded_by_membership_id: string; upload_status: string; content_type: string;
    storage_key: string | null; preview_storage_key: string | null; original_sha256: string | null;
  }>(
    `SELECT job_id, uploaded_by_membership_id, upload_status, content_type, storage_key, preview_storage_key, original_sha256
       FROM photos WHERE id = $1 AND ($2::boolean OR deleted_at IS NULL)`,
    [photoId, includeDeleted],
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
      return { items: rows.map((r) => toPhoto(r, ctx)) };
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
      if (q.flagged !== undefined) add("p.is_flagged = ?", q.flagged);
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
      return { items: rows.map((r) => ({ ...toPhoto(r, ctx), distanceM: r.distance_m === null ? null : Math.round(r.distance_m) })) };
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
                             client_ref, latitude, longitude, location_accuracy_m, is_flagged, flagged_at, flagged_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::boolean,
                 CASE WHEN $12::boolean THEN now() END, CASE WHEN $12::boolean THEN $7::uuid END)
         ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, jobId, body.contentType, body.stage, body.note ?? null, body.capturedAt, ctx.membershipId,
         body.clientRef, body.latitude ?? null, body.longitude ?? null, body.locationAccuracyM ?? null, body.flagged],
      );
      if (created) await recordAudit(tx, ctx, "photo.recorded", "photo", id, { jobId, hasLocation: body.latitude !== undefined });
      const { rows } = await tx.query<PhotoRow>(`${PHOTO_SELECT} WHERE p.id = $1`, [id]);
      return { photo: toPhoto(rows[0]!, ctx), created };
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
    // The original is write-once: if a file is already there (an earlier attempt that died before the record was
    // updated, or the same upload arriving twice at once), it is kept only if it is byte-for-byte this file.
    // So a stored original is never replaced, and the record's checksum always matches the stored file.
    if (!(await storage.putIfAbsent(originalKey, bytes, declared))) {
      const existing = await storage.get(originalKey);
      if (!existing || sha256(existing) !== processed.originalSha256) {
        throw new HttpError("conflict", "This photo already has a different file.");
      }
    }
    if (processed.preview && previewKey) await storage.put(previewKey, processed.preview.data, "image/jpeg");

    return inOrg(db, req, orgId, async (tx, ctx) => {
      const { rowCount } = await tx.query(
        `UPDATE photos SET upload_status = 'stored', storage_key = $2, preview_storage_key = $3, original_sha256 = $4,
                           size_bytes = $5, width_px = $6, height_px = $7, stored_at = now()
          WHERE id = $1 AND upload_status = 'pending' AND uploaded_by_membership_id = $8`,
        [photoId, originalKey, previewKey, processed.originalSha256, bytes.length,
         processed.preview?.width ?? null, processed.preview?.height ?? null, ctx.membershipId],
      );
      if (!rowCount) {
        // Another copy of this same upload finished first (for example the phone retried while the first try was
        // still on its way). Same file: that's a success, not an error. Anything else: refuse.
        const { rows: now } = await tx.query<{ upload_status: string; original_sha256: string | null }>(
          "SELECT upload_status, original_sha256 FROM photos WHERE id = $1",
          [photoId],
        );
        if (now[0]?.upload_status === "stored" && now[0].original_sha256 === processed.originalSha256) {
          return { id: photoId, uploadStatus: "stored", duplicate: true };
        }
        throw new HttpError("conflict", "This photo was already uploaded.");
      }
      await recordAudit(tx, ctx, "photo.stored", "photo", photoId, { bytes: bytes.length });
      return { id: photoId, uploadStatus: "stored", duplicate: false };
    });
  });

  // ------------------------------------------------------------ authenticated download
  app.get("/v1/orgs/:orgId/photos/:photoId/content", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const { variant } = parse(PhotoContentQuery, req.query);
    const file = await inOrg(db, req, orgId, async (tx, ctx) => {
      // People who can restore photos may also view deleted ones (to decide what to restore).
      const p = await loadVisiblePhoto(tx, ctx, photoId, ctx.has("photos.delete_any"));
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

  // ------------------------------------------------------------ flag / note / category
  app.patch("/v1/orgs/:orgId/photos/:photoId", async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const body = parse(UpdatePhotoRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const p = await loadVisiblePhoto(tx, ctx, photoId);
      // The photographer may edit their own photos; managers (photo_flags.manage) may edit any photo they can see.
      const own = p.uploaded_by_membership_id === ctx.membershipId && ctx.has("photos.upload");
      if (!own && !ctx.has("photo_flags.manage")) throw new HttpError("forbidden");
      // Fixed SQL with COALESCE: a field left out of the request keeps its current value.
      await tx.query(
        `UPDATE photos SET
           is_flagged = COALESCE($2::boolean, is_flagged),
           flagged_at = CASE WHEN $2::boolean IS NULL THEN flagged_at WHEN $2::boolean THEN COALESCE(flagged_at, now()) END,
           flagged_by_membership_id = CASE WHEN $2::boolean IS NULL THEN flagged_by_membership_id
                                           WHEN $2::boolean THEN COALESCE(flagged_by_membership_id, $3::uuid) END,
           caption = CASE WHEN $4::boolean THEN NULLIF($5::text, '') ELSE caption END,
           stage = COALESCE($6::text, stage)
         WHERE id = $1`,
        [photoId, body.flagged ?? null, ctx.membershipId, body.note !== undefined, body.note ?? null, body.stage ?? null],
      );
      const action = body.flagged === true ? "photo.flagged" : body.flagged === false ? "photo.unflagged" : "photo.updated";
      await recordAudit(tx, ctx, action, "photo", photoId, { fields: Object.keys(body) });
      const { rows } = await tx.query<PhotoRow>(`${PHOTO_SELECT} WHERE p.id = $1`, [photoId]);
      return toPhoto(rows[0]!, ctx);
    });
  });

  // ------------------------------------------------------------ delete / restore (soft delete; files are kept)
  app.delete("/v1/orgs/:orgId/photos/:photoId", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    await inOrg(db, req, orgId, async (tx, ctx) => {
      const p = await loadVisiblePhoto(tx, ctx, photoId);
      if (!mayDelete(ctx, p.uploaded_by_membership_id)) throw new HttpError("forbidden");
      await tx.query(`UPDATE photos SET deleted_at = now(), deleted_by_membership_id = $2 WHERE id = $1 AND deleted_at IS NULL`, [photoId, ctx.membershipId]);
      await recordAudit(tx, ctx, "photo.deleted", "photo", photoId, { jobId: p.job_id });
    });
    return reply.status(204).send();
  });

  app.post("/v1/orgs/:orgId/photos/:photoId/restore", async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.delete_any");
      const { rows: found } = await tx.query<{ job_id: string }>(`SELECT job_id FROM photos WHERE id = $1 AND deleted_at IS NOT NULL`, [photoId]);
      if (!found[0]) throw notFound();
      await assertJobAccess(tx, ctx, found[0].job_id);
      await tx.query(`UPDATE photos SET deleted_at = NULL, deleted_by_membership_id = NULL WHERE id = $1`, [photoId]);
      await recordAudit(tx, ctx, "photo.restored", "photo", photoId, { jobId: found[0].job_id });
      const { rows } = await tx.query<PhotoRow>(`${PHOTO_SELECT} WHERE p.id = $1`, [photoId]);
      return toPhoto(rows[0]!, ctx);
    });
  });

  app.get("/v1/orgs/:orgId/jobs/:jobId/photos/deleted", async (req) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.delete_any");
      await assertJobAccess(tx, ctx, jobId);
      const { rows } = await tx.query<PhotoRow & { deleted_at: Date; deleted_by: string; purge_after: Date }>(
        `SELECT x.*, p2.deleted_at, du.display_name AS deleted_by,
                p2.deleted_at + make_interval(days => o.deleted_photo_retention_days) AS purge_after
           FROM (${PHOTO_SELECT} WHERE p.job_id = $1 AND p.deleted_at IS NOT NULL) x
           JOIN photos p2 ON p2.id = x.id
           JOIN organizations o ON o.id = p2.organization_id
           JOIN organization_memberships dm ON dm.organization_id = p2.organization_id AND dm.id = p2.deleted_by_membership_id
           JOIN users du ON du.id = dm.user_id
          ORDER BY p2.deleted_at DESC LIMIT 500`,
        [jobId],
      );
      const items: DeletedPhoto[] = rows.map((r) => ({
        ...toPhoto(r, ctx),
        deletedAt: r.deleted_at.toISOString(),
        deletedBy: r.deleted_by,
        purgeAfter: r.purge_after.toISOString(),
      }));
      return { items };
    });
  });

  // ------------------------------------------------------------ delete forever (only from Recently Deleted; cannot be undone)
  app.post("/v1/orgs/:orgId/photos/purge", async (req, reply) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(PhotoIdsRequest, req.body);
    const keys = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.purge");
      const ids = [...new Set(body.photoIds)];
      // All or nothing: every photo must be in Recently Deleted on a job this person can see.
      for (const id of ids) {
        const { rows } = await tx.query<{ job_id: string }>("SELECT job_id FROM photos WHERE id = $1 AND deleted_at IS NOT NULL", [id]);
        if (!rows[0]) throw notFound();
        await assertJobAccess(tx, ctx, rows[0].job_id);
      }
      const all: string[] = [];
      for (const id of ids) {
        const res = await purgeDeletedPhoto(tx, id);
        if (!res) throw notFound();
        await recordAudit(tx, ctx, "photo.purged", "photo", id, { jobId: res.jobId, trigger: "manual" });
        all.push(...res.keys);
      }
      return all;
    });
    // Files are removed only after the database change has committed.
    await removeFiles(storage, keys, req.log);
    return reply.status(204).send();
  });

  // ------------------------------------------------------------ export (photos leaving the app are always audited)
  app.post("/v1/orgs/:orgId/photos/exports", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(ExportPhotosRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.export");
      const ids = [...new Set(body.photoIds)];
      for (const id of ids) {
        await loadVisiblePhoto(tx, ctx, id);
        await recordAudit(tx, ctx, "photo.exported", "photo", id, { channel: body.channel });
      }
      return { recorded: ids.length };
    });
  });

  // ------------------------------------------------------------ review flags (manager review queue; UI deferred)
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
      const { rows } = await tx.query<{ id: string; status: string; photo_id: string }>("SELECT id, status, photo_id FROM photo_flags WHERE id = $1", [flagId]);
      if (!rows[0]) throw notFound();
      // Only flags on photos (and jobs) this person can see. A custom role may manage flags but see only assigned jobs.
      await loadVisiblePhoto(tx, ctx, rows[0].photo_id);
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
      const vis = jobVisibilitySql(ctx); // only flags on photos of jobs this person can see
      const { rows } = await tx.query<{ id: string; photo_id: string; job_number: string; reason: string; created_at: Date }>(
        `SELECT f.id, f.photo_id, j.job_number, f.reason, f.created_at
           FROM photo_flags f
           JOIN photos p ON p.organization_id = f.organization_id AND p.id = f.photo_id
           JOIN jobs j ON j.organization_id = p.organization_id AND j.id = p.job_id
          WHERE f.status = 'open' AND p.deleted_at IS NULL AND j.deleted_at IS NULL AND (${vis.where})
          ORDER BY f.created_at`,
        [ctx.membershipId],
      );
      return { items: rows.map((r) => ({ id: r.id, photoId: r.photo_id, jobNumber: r.job_number, reason: r.reason, createdAt: r.created_at.toISOString() })) };
    });
  });
}
