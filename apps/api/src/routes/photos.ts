import type { FastifyInstance } from "fastify";
import {
  CreatePhotoFlagRequest,
  CreatePhotoRequest,
  FlagParams,
  JobParams,
  PhotoParams,
  ResolvePhotoFlagRequest,
  type Photo,
} from "@rsb/contracts";
import { inOrg } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess } from "../lib/access.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import { HttpError, notFound } from "../lib/errors.js";
import type { RouteDeps } from "./index.js";

interface PhotoRow {
  id: string;
  job_id: string;
  stage: Photo["stage"];
  caption: string | null;
  captured_at: Date;
  upload_status: Photo["uploadStatus"];
  uploaded_by: string;
  open_flags: number;
}

const PHOTO_SELECT = `SELECT p.id, p.job_id, p.stage, p.caption, p.captured_at, p.upload_status, u.display_name AS uploaded_by,
                             (SELECT count(*)::int FROM photo_flags f WHERE f.organization_id = p.organization_id AND f.photo_id = p.id AND f.status = 'open') AS open_flags
                        FROM photos p
                        JOIN organization_memberships m ON m.organization_id = p.organization_id AND m.id = p.uploaded_by_membership_id
                        JOIN users u ON u.id = m.user_id`;

const toPhoto = (r: PhotoRow): Photo => ({
  id: r.id,
  jobId: r.job_id,
  stage: r.stage,
  caption: r.caption,
  capturedAt: r.captured_at.toISOString(),
  uploadStatus: r.upload_status,
  uploadedBy: r.uploaded_by,
  openFlags: r.open_flags,
});

export async function photoRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
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

  app.post("/v1/orgs/:orgId/jobs/:jobId/photos", async (req, reply) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    const body = parse(CreatePhotoRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photos.upload");
      await assertJobAccess(tx, ctx, jobId);
      const { id, created } = await insertIdempotent(
        tx, "photos", body.clientRef, ctx.membershipId,
        `INSERT INTO photos (organization_id, job_id, content_type, stage, caption, captured_at, uploaded_by_membership_id, client_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, jobId, body.contentType, body.stage, body.caption ?? null, body.capturedAt, ctx.membershipId, body.clientRef],
      );
      if (created) await recordAudit(tx, ctx, "photo.recorded", "photo", id, { jobId });
      const { rows } = await tx.query<PhotoRow>(`${PHOTO_SELECT} WHERE p.id = $1`, [id]);
      return { photo: toPhoto(rows[0]!), created };
    });
    return reply.status(result.created ? 201 : 200).send(result.photo);
  });

  app.post("/v1/orgs/:orgId/photos/:photoId/flags", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const body = parse(CreatePhotoFlagRequest, req.body);
    const flag = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_flags.create");
      const { rows } = await tx.query<{ job_id: string }>("SELECT job_id FROM photos WHERE id = $1 AND deleted_at IS NULL", [photoId]);
      if (!rows[0]) throw notFound();
      await assertJobAccess(tx, ctx, rows[0].job_id);
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
    const { orgId } = parse(PhotoParams.pick({ orgId: true }), req.params);
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
