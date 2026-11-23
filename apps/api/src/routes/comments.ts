import type { FastifyInstance } from "fastify";
import {
  CommentParams,
  CreatePhotoCommentRequest,
  JobParams,
  PhotoParams,
  UpdatePhotoCommentRequest,
  type JobPerson,
  type PhotoComment,
} from "@rsb/contracts";
import { inOrg, type OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess, JOB_PEOPLE_SQL } from "../lib/access.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import { HttpError, notFound } from "../lib/errors.js";
import { loadVisiblePhoto } from "./photos.js";
import type { RouteDeps } from "./index.js";

/**
 * Comments and replies on photos (step 2 of the photo collaboration work).
 * Anyone who can see a photo can read its comments. Wording is never shown for a deleted comment, but it stays in
 * the database (with every earlier wording) for the record.
 */

interface CommentRow {
  id: string;
  photo_id: string;
  parent_id: string | null;
  author_membership_id: string;
  author: string;
  author_avatar_at: Date | null;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  mentions: { id: string; name: string }[] | null;
}

const COMMENT_SELECT = `
  SELECT c.id, c.photo_id, c.parent_id, c.author_membership_id, au.display_name AS author, am.avatar_updated_at AS author_avatar_at,
         c.body, c.created_at, c.edited_at, c.deleted_at, du.display_name AS deleted_by,
         (SELECT json_agg(json_build_object('id', mm.id, 'name', mu.display_name) ORDER BY mu.display_name)
            FROM photo_comment_mentions x
            JOIN organization_memberships mm ON mm.organization_id = x.organization_id AND mm.id = x.membership_id
            JOIN users mu ON mu.id = mm.user_id
           WHERE x.organization_id = c.organization_id AND x.comment_id = c.id) AS mentions
    FROM photo_comments c
    JOIN organization_memberships am ON am.organization_id = c.organization_id AND am.id = c.author_membership_id
    JOIN users au ON au.id = am.user_id
    LEFT JOIN organization_memberships dm ON dm.organization_id = c.organization_id AND dm.id = c.deleted_by_membership_id
    LEFT JOIN users du ON du.id = dm.user_id`;

const isAuthor = (ctx: OrgContext, authorId: string) => authorId === ctx.membershipId && ctx.has("photo_comments.create");

const toComment = (r: CommentRow, ctx: OrgContext): PhotoComment => {
  const deleted = r.deleted_at !== null;
  return {
    id: r.id,
    photoId: r.photo_id,
    parentId: r.parent_id,
    authorId: r.author_membership_id,
    author: r.author,
    authorAvatarAt: r.author_avatar_at?.toISOString() ?? null,
    body: deleted ? null : r.body,
    mentions: deleted ? [] : (r.mentions ?? []),
    createdAt: r.created_at.toISOString(),
    editedAt: r.edited_at?.toISOString() ?? null,
    deletedAt: r.deleted_at?.toISOString() ?? null,
    deletedBy: r.deleted_by,
    mine: r.author_membership_id === ctx.membershipId,
    canEdit: !deleted && isAuthor(ctx, r.author_membership_id),
    canDelete: !deleted && (isAuthor(ctx, r.author_membership_id) || ctx.has("photo_comments.moderate")),
  };
};

/** Every @mention must be someone who can see the job. Returns the unique ids. */
async function checkMentions(tx: Tx, ctx: OrgContext, jobId: string, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const { rows } = await tx.query<{ id: string }>(`SELECT p.id FROM (${JOB_PEOPLE_SQL}) p WHERE p.id = ANY($3::uuid[])`, [ctx.orgId, jobId, unique]);
  if (rows.length !== unique.length) {
    throw new HttpError("validation_failed", "You can only mention people who can see this job.", [{ path: "mentionIds", issue: "not on this job" }]);
  }
  return unique;
}

async function addMentions(tx: Tx, ctx: OrgContext, commentId: string, ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const { rowCount } = await tx.query(
    `INSERT INTO photo_comment_mentions (organization_id, comment_id, membership_id)
     SELECT $1, $2, unnest($3::uuid[]) ON CONFLICT DO NOTHING`,
    [ctx.orgId, commentId, ids],
  );
  return rowCount ?? 0;
}

/** Loads a comment on a photo the caller can see, or throws 404. */
async function loadComment(tx: Tx, ctx: OrgContext, commentId: string) {
  const { rows } = await tx.query<{ photo_id: string; author_membership_id: string; deleted_at: Date | null }>(
    "SELECT photo_id, author_membership_id, deleted_at FROM photo_comments WHERE id = $1",
    [commentId],
  );
  if (!rows[0]) throw notFound();
  const photo = await loadVisiblePhoto(tx, ctx, rows[0].photo_id);
  return { ...rows[0], jobId: photo.job_id };
}

async function readComment(tx: Tx, ctx: OrgContext, id: string): Promise<PhotoComment> {
  const { rows } = await tx.query<CommentRow>(`${COMMENT_SELECT} WHERE c.id = $1`, [id]);
  return toComment(rows[0]!, ctx);
}

export async function commentRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/orgs/:orgId/photos/:photoId/comments", async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await loadVisiblePhoto(tx, ctx, photoId, ctx.has("photos.delete_any"));
      const { rows } = await tx.query<CommentRow>(`${COMMENT_SELECT} WHERE c.photo_id = $1 ORDER BY c.created_at, c.id LIMIT 1000`, [photoId]);
      return { items: rows.map((r) => toComment(r, ctx)) };
    });
  });

  app.post("/v1/orgs/:orgId/photos/:photoId/comments", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const body = parse(CreatePhotoCommentRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_comments.create");
      const photo = await loadVisiblePhoto(tx, ctx, photoId);
      if (body.parentId) {
        const { rows } = await tx.query<{ parent_id: string | null }>(
          "SELECT parent_id FROM photo_comments WHERE id = $1 AND photo_id = $2",
          [body.parentId, photoId],
        );
        if (!rows[0]) throw new HttpError("validation_failed", "The comment you are replying to is not on this photo.", [{ path: "parentId", issue: "not found" }]);
        if (rows[0].parent_id) throw new HttpError("validation_failed", "Reply to the main comment instead (replies are one level deep).", [{ path: "parentId", issue: "is a reply" }]);
      }
      const mentions = await checkMentions(tx, ctx, photo.job_id, body.mentionIds);
      const { id, created } = await insertIdempotent(
        tx, "photo_comments", body.clientRef, ctx.membershipId,
        `INSERT INTO photo_comments (organization_id, photo_id, parent_id, author_membership_id, body, client_ref)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, photoId, body.parentId ?? null, ctx.membershipId, body.body, body.clientRef],
      );
      if (created) {
        await addMentions(tx, ctx, id, mentions);
        // The wording is not copied into the activity log; it stays with the comment.
        await recordAudit(tx, ctx, "photo_comment.created", "photo_comment", id, { photoId, reply: !!body.parentId, mentions: mentions.length });
      }
      return { comment: await readComment(tx, ctx, id), created };
    });
    return reply.status(result.created ? 201 : 200).send(result.comment);
  });

  app.patch("/v1/orgs/:orgId/photo-comments/:commentId", async (req) => {
    const { orgId, commentId } = parse(CommentParams, req.params);
    const body = parse(UpdatePhotoCommentRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const c = await loadComment(tx, ctx, commentId);
      if (!isAuthor(ctx, c.author_membership_id)) throw new HttpError("forbidden", "Only the person who wrote a comment can edit it.");
      if (c.deleted_at) throw new HttpError("conflict", "This comment was deleted.");
      const mentions = await checkMentions(tx, ctx, c.jobId, body.mentionIds);
      // The database keeps the earlier wording and sets "edited" itself.
      const { rowCount } = await tx.query("UPDATE photo_comments SET body = $2 WHERE id = $1 AND deleted_at IS NULL AND body IS DISTINCT FROM $2", [commentId, body.body]);
      const added = await addMentions(tx, ctx, commentId, mentions);
      if (rowCount || added) await recordAudit(tx, ctx, "photo_comment.edited", "photo_comment", commentId, { photoId: c.photo_id, newMentions: added });
      return readComment(tx, ctx, commentId);
    });
  });

  app.delete("/v1/orgs/:orgId/photo-comments/:commentId", async (req, reply) => {
    const { orgId, commentId } = parse(CommentParams, req.params);
    await inOrg(db, req, orgId, async (tx, ctx) => {
      const c = await loadComment(tx, ctx, commentId);
      const own = isAuthor(ctx, c.author_membership_id);
      if (!own && !ctx.has("photo_comments.moderate")) throw new HttpError("forbidden", "Only the person who wrote a comment can delete it.");
      if (c.deleted_at) return; // already deleted: nothing to do
      await tx.query("UPDATE photo_comments SET deleted_at = now(), deleted_by_membership_id = $2 WHERE id = $1 AND deleted_at IS NULL", [commentId, ctx.membershipId]);
      await recordAudit(tx, ctx, "photo_comment.deleted", "photo_comment", commentId, { photoId: c.photo_id, byModerator: !own });
    });
    return reply.status(204).send();
  });

  // People who can be @mentioned on a job: everyone who can see it.
  app.get("/v1/orgs/:orgId/jobs/:jobId/people", async (req) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_comments.create");
      await assertJobAccess(tx, ctx, jobId);
      const { rows } = await tx.query<{ id: string; name: string; avatar_updated_at: Date | null }>(`${JOB_PEOPLE_SQL} ORDER BY u.display_name LIMIT 500`, [ctx.orgId, jobId]);
      const items: JobPerson[] = rows.map((r) => ({ id: r.id, name: r.name, avatarAt: r.avatar_updated_at?.toISOString() ?? null, me: r.id === ctx.membershipId }));
      return { items };
    });
  });
}
