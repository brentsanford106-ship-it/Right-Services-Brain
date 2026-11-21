import type { FastifyInstance } from "fastify";
import { OrgParams, type MeResponse, type OrgContextResponse, type DashboardResponse } from "@rsb/contracts";
import { inOrg, requireUser } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { jobVisibilitySql } from "../lib/access.js";
import type { RouteDeps } from "./index.js";

export async function meRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/me", async (req): Promise<MeResponse> => {
    const userId = requireUser(req);
    // Already-registered people may have been added to another company since: accept those invites too.
    if (req.identity?.email) {
      const id = req.identity;
      await db.anonymous((tx) => tx.query("SELECT app.claim_invites($1, $2, $3, $4)", [id.issuer, id.subject, id.email, id.name ?? null]));
    }
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
