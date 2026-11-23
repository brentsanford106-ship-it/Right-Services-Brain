import type { FastifyInstance } from "fastify";
import { MyInviteParams, OrgParams, type MeResponse, type OrgContextResponse, type DashboardResponse, type PendingInvite } from "@rsb/contracts";
import { HttpError } from "../lib/errors.js";
import type { Tx } from "../lib/db.js";
import type { FastifyRequest } from "fastify";
import { inOrg, requireUser } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { jobVisibilitySql } from "../lib/access.js";
import type { RouteDeps } from "./index.js";

/** Live invites for the signed-in person's verified email (none without one). */
async function pendingInvites(tx: Tx, req: FastifyRequest): Promise<PendingInvite[]> {
  const id = req.identity;
  if (!id?.email) return [];
  const { rows } = await tx.query<{ invite_id: string; organization_id: string; organization_name: string; role_names: string[]; invited_by: string; expires_at: Date }>(
    "SELECT * FROM app.my_invites($1, $2, $3)",
    [id.issuer, id.subject, id.email],
  );
  return rows.map((r) => ({
    inviteId: r.invite_id,
    organizationId: r.organization_id,
    organizationName: r.organization_name,
    roles: r.role_names,
    invitedBy: r.invited_by,
    expiresAt: r.expires_at.toISOString(),
  }));
}

export async function meRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  // Accept or decline an invite. Joining a company always takes the person's own Accept.
  for (const [action, accept] of [["accept", true], ["decline", false]] as const) {
    app.post(`/v1/invites/:inviteId/${action}`, async (req) => {
      requireUser(req);
      const { inviteId } = parse(MyInviteParams, req.params);
      const id = req.identity!;
      const { rows } = await db.anonymous((tx) =>
        tx.query<{ outcome: string }>("SELECT app.respond_to_invite($1, $2, $3, $4, $5) AS outcome", [id.issuer, id.subject, id.email ?? null, inviteId, accept]),
      );
      const outcome = rows[0]?.outcome;
      if (outcome !== "accepted" && outcome !== "declined") {
        throw new HttpError("not_found", "This invite is no longer available. It may have expired or been cancelled. Ask the owner to add you again.");
      }
      return { inviteId, outcome };
    });
  }

  app.get("/v1/me", async (req): Promise<MeResponse> => {
    const userId = requireUser(req);
    const invites = await db.anonymous((tx) => pendingInvites(tx, req));
    return db.asUser(userId, async (tx) => {
      const { rows: u } = await tx.query<{ id: string; display_name: string; email: string }>(
        "SELECT id, display_name, email FROM users WHERE id = $1",
        [userId],
      );
      const { rows: m } = await tx.query<{ organization_id: string; name: string; membership_id: string }>(
        `SELECT m.organization_id, o.name, m.id AS membership_id
           FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'
          ORDER BY o.name`,
        [userId],
      );
      const user = u[0]!;
      return {
        user: { id: user.id, displayName: user.display_name, email: user.email },
        memberships: m.map((r) => ({ organizationId: r.organization_id, organizationName: r.name, membershipId: r.membership_id })),
        invites,
      };
    });
  });

  app.get("/v1/orgs/:orgId", async (req): Promise<OrgContextResponse> => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("org.read");
      const { rows } = await tx.query<{ id: string; name: string; slug: string; sign_in_every_days: number }>(
        "SELECT id, name, slug, sign_in_every_days FROM organizations WHERE id = $1",
        [orgId],
      );
      const { sign_in_every_days, ...organization } = rows[0]!;
      return {
        organization,
        signInEveryDays: sign_in_every_days,
        membershipId: ctx.membershipId,
        roles: ctx.roles,
        permissions: [...ctx.permissions].sort(),
      };
    });
  });

  app.get("/v1/orgs/:orgId/dashboard", async (req): Promise<DashboardResponse> => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("org.read");
      const vis = jobVisibilitySql(ctx);
      const { rows: jobs } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM jobs j WHERE j.status = 'active' AND j.deleted_at IS NULL AND (${vis.where})`,
        [ctx.membershipId],
      );
      // Photo counts are limited to jobs this member can see (RLS already limits to this organization).
      const { rows: p } = await tx.query<{ recent: number; flagged: number; awaiting: number }>(
        `SELECT count(*) FILTER (WHERE p.captured_at >= now() - interval '7 days')::int AS recent,
                count(*) FILTER (WHERE p.is_flagged)::int AS flagged,
                count(*) FILTER (WHERE p.stored_at IS NULL)::int AS awaiting
           FROM photos p JOIN jobs j ON j.organization_id = p.organization_id AND j.id = p.job_id
          WHERE p.deleted_at IS NULL AND j.deleted_at IS NULL AND (${vis.where})`,
        [ctx.membershipId],
      );
      const r = p[0]!;
      return { activeJobs: jobs[0]!.n, photosLast7Days: r.recent, flaggedPhotos: r.flagged, photosAwaitingUpload: r.awaiting };
    });
  });
}
