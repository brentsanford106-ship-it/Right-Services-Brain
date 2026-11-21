import type { FastifyInstance } from "fastify";
import { AuditEvent, OrgParams, PageQuery, type Member } from "@rsb/contracts";
import type { z } from "zod";
import { inOrg } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import type { RouteDeps } from "./index.js";

export async function memberRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/orgs/:orgId/members", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("members.read");
      const { rows } = await tx.query<{ id: string; display_name: string; job_title: string | null; status: Member["status"]; roles: string[] | null }>(
        `SELECT m.id, u.display_name, m.job_title, m.status,
                array_agg(r.key ORDER BY r.key) FILTER (WHERE r.key IS NOT NULL) AS roles
           FROM organization_memberships m
           JOIN users u ON u.id = m.user_id
           LEFT JOIN membership_roles mr ON mr.organization_id = m.organization_id AND mr.membership_id = m.id
           LEFT JOIN roles r ON r.organization_id = mr.organization_id AND r.id = mr.role_id
          WHERE m.organization_id = $1
          GROUP BY m.id, u.display_name, m.job_title, m.status
          ORDER BY u.display_name`,
        [ctx.orgId],
      );
      // Email addresses are deliberately not returned (data minimisation); add when a feature needs them.
      const items: Member[] = rows.map((r) => ({
        membershipId: r.id,
        displayName: r.display_name,
        jobTitle: r.job_title,
        status: r.status,
        roles: r.roles ?? [],
      }));
      return { items };
    });
  });

  app.get("/v1/orgs/:orgId/audit-events", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { limit } = parse(PageQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("audit.read");
      const { rows } = await tx.query<{ id: string; action: string; outcome: "success" | "denied" | "error"; actor_user_id: string | null; target_type: string | null; target_id: string | null; occurred_at: Date }>(
        `SELECT id, action, outcome, actor_user_id, target_type, target_id, occurred_at
           FROM audit_events ORDER BY occurred_at DESC LIMIT $1`,
        [limit],
      );
      const items: z.infer<typeof AuditEvent>[] = rows.map((r) => ({
        id: r.id,
        action: r.action,
        outcome: r.outcome,
        actorUserId: r.actor_user_id,
        targetType: r.target_type,
        targetId: r.target_id,
        occurredAt: r.occurred_at.toISOString(),
      }));
      return { items };
    });
  });
}
