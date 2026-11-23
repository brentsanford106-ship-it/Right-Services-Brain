import type { FastifyInstance } from "fastify";
import { MarkNotificationsReadRequest, NotificationListQuery, NotificationSettings, OrgParams, type Notification } from "@rsb/contracts";
import { inOrg, type OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { jobVisibilitySql } from "../lib/access.js";
import type { RouteDeps } from "./index.js";

/**
 * In-app alerts (step 5). Everyone sees only their own alerts, and only for jobs they can still see:
 * someone taken off a job stops seeing its alerts. Deleted photos' alerts are hidden too.
 */

interface Row {
  id: string; kind: Notification["kind"]; actor: string; actor_id: string; actor_avatar_at: Date | null;
  job_id: string; job_number: string; photo_id: string; comment_id: string | null; issue_id: string | null;
  issue_title: string | null; body: string | null; deleted_at: Date | null; created_at: Date; read_at: Date | null;
}

/** $1 = my membership (used by the job visibility check). */
function visibleSql(ctx: OrgContext, joins = ""): string {
  return `
    FROM notifications n
    JOIN jobs j ON j.organization_id = n.organization_id AND j.id = n.job_id AND j.deleted_at IS NULL
    JOIN photos p ON p.organization_id = n.organization_id AND p.id = n.photo_id AND p.deleted_at IS NULL
    ${joins}
   WHERE n.recipient_membership_id = $1 AND (${jobWhere(ctx)})`;
}

/** Someone whose role can't see any jobs simply has no alerts (rather than an error on every page). */
function jobWhere(ctx: OrgContext): string {
  return ctx.has("jobs.read_all") || ctx.has("jobs.read_assigned") ? jobVisibilitySql(ctx).where : "FALSE AND $1::uuid IS NOT NULL";
}

const toNotification = (r: Row): Notification => ({
  id: r.id,
  kind: r.kind,
  actor: r.actor,
  actorId: r.actor_id,
  actorAvatarAt: r.actor_avatar_at?.toISOString() ?? null,
  jobId: r.job_id,
  jobNumber: r.job_number,
  photoId: r.photo_id,
  commentId: r.comment_id,
  issueId: r.issue_id,
  issueTitle: r.issue_title,
  snippet: r.body && !r.deleted_at ? (r.body.length > 140 ? `${r.body.slice(0, 139)}…` : r.body) : null,
  createdAt: r.created_at.toISOString(),
  readAt: r.read_at?.toISOString() ?? null,
});

async function unreadCount(tx: Tx, ctx: OrgContext): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::int AS n ${visibleSql(ctx)} AND n.read_at IS NULL`, [ctx.membershipId]);
  return rows[0]!.n;
}

export async function notificationRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/orgs/:orgId/notifications", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const q = parse(NotificationListQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const { rows } = await tx.query<Row>(
        `SELECT n.id, n.kind, u.display_name AS actor, n.actor_membership_id AS actor_id, am.avatar_updated_at AS actor_avatar_at,
                n.job_id, j.job_number, n.photo_id, n.comment_id, n.issue_id, i.title AS issue_title,
                c.body, c.deleted_at, n.created_at, n.read_at
           ${visibleSql(ctx, `
             JOIN organization_memberships am ON am.organization_id = n.organization_id AND am.id = n.actor_membership_id
             JOIN users u ON u.id = am.user_id
             LEFT JOIN photo_comments c ON c.organization_id = n.organization_id AND c.id = n.comment_id
             LEFT JOIN photo_issues i ON i.organization_id = n.organization_id AND i.id = n.issue_id`)}
           ${q.unread === "true" ? "AND n.read_at IS NULL" : ""}
          ORDER BY n.created_at DESC
          LIMIT ${q.limit}`,
        [ctx.membershipId],
      );
      return { items: rows.map(toNotification), unreadCount: await unreadCount(tx, ctx) };
    });
  });

  app.get("/v1/orgs/:orgId/notifications/unread-count", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => ({ unreadCount: await unreadCount(tx, ctx) }));
  });

  app.post("/v1/orgs/:orgId/notifications/read", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(MarkNotificationsReadRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      // Only ever your own alerts.
      if (body.all) {
        await tx.query("UPDATE notifications SET read_at = now() WHERE recipient_membership_id = $1 AND read_at IS NULL", [ctx.membershipId]);
      } else {
        await tx.query("UPDATE notifications SET read_at = now() WHERE recipient_membership_id = $1 AND read_at IS NULL AND id = ANY ($2::uuid[])", [ctx.membershipId, body.ids]);
      }
      return { unreadCount: await unreadCount(tx, ctx) };
    });
  });

  app.get("/v1/orgs/:orgId/notification-settings", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const { rows } = await tx.query<{ muted_kinds: string[] }>("SELECT muted_kinds FROM notification_preferences WHERE membership_id = $1", [ctx.membershipId]);
      return { muted: rows[0]?.muted_kinds ?? [] };
    });
  });

  app.patch("/v1/orgs/:orgId/notification-settings", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(NotificationSettings, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const muted = [...new Set(body.muted)].sort();
      await tx.query(
        `INSERT INTO notification_preferences (organization_id, membership_id, muted_kinds) VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, membership_id) DO UPDATE SET muted_kinds = EXCLUDED.muted_kinds, updated_at = now()`,
        [ctx.orgId, ctx.membershipId, muted],
      );
      return { muted };
    });
  });
}
