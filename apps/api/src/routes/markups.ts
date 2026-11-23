import type { FastifyInstance } from "fastify";
import { MarkupChangesRequest, PhotoParams, type PhotoMarkup } from "@rsb/contracts";
import { inOrg, type OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import { HttpError } from "../lib/errors.js";
import { loadVisiblePhoto } from "./photos.js";
import type { RouteDeps } from "./index.js";

/**
 * Drawing on photos (step 3). Marks are shape data kept next to the photo; the photo file is never changed.
 * Owners and managers draw. A saved mark never changes: it can only be removed (and is still kept for the record).
 */

const MAX_MARKS_PER_PHOTO = 500;

interface MarkupRow {
  id: string;
  kind: PhotoMarkup["kind"];
  color: PhotoMarkup["color"];
  size: number;
  points: [number, number][];
  label: string | null;
  author_membership_id: string;
  author: string;
  created_at: Date;
}

const MARKUP_SELECT = `
  SELECT k.id, k.kind, k.color, k.size, k.points, k.label, k.author_membership_id, u.display_name AS author, k.created_at
    FROM photo_markups k
    JOIN organization_memberships m ON m.organization_id = k.organization_id AND m.id = k.author_membership_id
    JOIN users u ON u.id = m.user_id`;

const mayRemove = (ctx: OrgContext, authorId: string) =>
  (authorId === ctx.membershipId && ctx.has("photo_markups.create")) || ctx.has("photo_markups.manage");

const toMarkup = (r: MarkupRow, ctx: OrgContext): PhotoMarkup => ({
  id: r.id,
  kind: r.kind,
  color: r.color,
  size: r.size,
  points: r.points,
  label: r.label,
  authorId: r.author_membership_id,
  author: r.author,
  createdAt: r.created_at.toISOString(),
  mine: r.author_membership_id === ctx.membershipId,
  canRemove: mayRemove(ctx, r.author_membership_id),
});

async function listMarks(tx: Tx, ctx: OrgContext, photoId: string): Promise<PhotoMarkup[]> {
  const { rows } = await tx.query<MarkupRow>(`${MARKUP_SELECT} WHERE k.photo_id = $1 AND k.removed_at IS NULL ORDER BY k.created_at, k.id`, [photoId]);
  return rows.map((r) => toMarkup(r, ctx));
}

export async function markupRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  // A little more room than the default for long pen lines (2,000 points each).
  const bodyLimit = 2 * 1024 * 1024;

  app.get("/v1/orgs/:orgId/photos/:photoId/markups", async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await loadVisiblePhoto(tx, ctx, photoId, ctx.has("photos.delete_any"));
      return { items: await listMarks(tx, ctx, photoId) };
    });
  });

  // One Save from the drawing screen: new marks and removed marks, all or nothing.
  app.post("/v1/orgs/:orgId/photos/:photoId/markups/changes", { bodyLimit }, async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const body = parse(MarkupChangesRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_markups.create", "photo_markups.manage");
      await loadVisiblePhoto(tx, ctx, photoId);
      if (body.add.length) ctx.require("photo_markups.create");

      let removed = 0;
      let removedOthers = 0;
      for (const id of [...new Set(body.remove)]) {
        const { rows } = await tx.query<{ author_membership_id: string; removed_at: Date | null }>(
          "SELECT author_membership_id, removed_at FROM photo_markups WHERE id = $1 AND photo_id = $2",
          [id, photoId],
        );
        const m = rows[0];
        if (!m) throw new HttpError("validation_failed", "One of the marks to remove isn't on this photo.", [{ path: "remove", issue: "not found" }]);
        if (m.removed_at) continue; // already removed (for example, Save tapped twice)
        if (!mayRemove(ctx, m.author_membership_id)) throw new HttpError("forbidden", "You can only remove your own marks.");
        await tx.query("UPDATE photo_markups SET removed_at = now(), removed_by_membership_id = $2 WHERE id = $1 AND removed_at IS NULL", [id, ctx.membershipId]);
        removed++;
        if (m.author_membership_id !== ctx.membershipId) removedOthers++;
      }

      let added = 0;
      for (const s of body.add) {
        const { id, created } = await insertIdempotent(
          tx, "photo_markups", s.clientRef, ctx.membershipId,
          `INSERT INTO photo_markups (organization_id, photo_id, author_membership_id, kind, color, size, points, label, client_ref, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, clock_timestamp()) ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
          [ctx.orgId, photoId, ctx.membershipId, s.kind, s.color, s.size, JSON.stringify(s.points), s.label?.trim() || null, s.clientRef],
        );
        if (!created) {
          // A resend of a mark already saved: fine, as long as it's on this photo.
          const { rowCount } = await tx.query("SELECT 1 FROM photo_markups WHERE id = $1 AND photo_id = $2", [id, photoId]);
          if (!rowCount) throw new HttpError("conflict", "This mark's id has already been used.");
        } else added++;
      }

      const { rows: count } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM photo_markups WHERE photo_id = $1 AND removed_at IS NULL", [photoId]);
      if (count[0]!.n > MAX_MARKS_PER_PHOTO) throw new HttpError("validation_failed", `A photo can have up to ${MAX_MARKS_PER_PHOTO} marks.`);
      if (added || removed) await recordAudit(tx, ctx, "photo_markup.changed", "photo", photoId, { added, removed, removedOthers });
      return { items: await listMarks(tx, ctx, photoId) };
    });
  });
}
