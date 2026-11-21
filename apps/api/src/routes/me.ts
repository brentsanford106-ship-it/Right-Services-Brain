import type { FastifyInstance } from "fastify";
import { OrgParams, type MeResponse, type OrgContextResponse, type DashboardResponse } from "@rsb/contracts";
import { inOrg, requireUser } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { jobVisibilitySql } from "../lib/access.js";
import type { RouteDeps } from "./index.js";

export async function meRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/me", async (req): Promise<MeResponse> => {
    const userId = requireUser(req);
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
      const { rows } = await tx.query<{ id: string; name: string; slug: string }>(
        "SELECT id, name, slug FROM organizations WHERE id = $1",
        [orgId],
      );
      return {
        organization: rows[0]!,
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
      const flags = ctx.has("photo_flags.manage")
        ? (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM photo_flags WHERE status = 'open'")).rows[0]!.n
        : null;
      const maint = ctx.has("maintenance.manage")
        ? (await tx.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM maintenance_records WHERE status <> 'done' AND kind = 'issue' AND deleted_at IS NULL",
          )).rows[0]!.n
        : null;
      // Financial totals: computed in trusted SQL, only for members with financials.read.
      const total = ctx.has("financials.read")
        ? (await tx.query<{ n: number }>(
            "SELECT COALESCE(sum(amount_cents), 0)::bigint AS n FROM receipts WHERE deleted_at IS NULL AND status <> 'rejected'",
          )).rows[0]!.n
        : null;
      return { activeJobs: jobs[0]!.n, openPhotoFlags: flags, openMaintenanceIssues: maint, receiptsTotalCents: total };
    });
  });
}
