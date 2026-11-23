import type { Tx } from "./db.js";
import type { OrgContext } from "./context.js";
import { forbidden, notFound } from "./errors.js";

/**
 * Record-level access rules. Each returns normally only when the caller may
 * access the record; otherwise throws 404 so that the existence of records the
 * caller cannot see is not revealed.
 */

/** SQL fragment restricting `jobs j` to jobs visible to the caller. Uses $1 = membership id. */
export function jobVisibilitySql(ctx: OrgContext): { where: string; needsMembership: boolean } {
  if (ctx.has("jobs.read_all")) return { where: "$1::uuid IS NOT NULL", needsMembership: false };
  if (ctx.has("jobs.read_assigned")) {
    return {
      where: `EXISTS (SELECT 1 FROM job_assignments ja
                        WHERE ja.organization_id = j.organization_id AND ja.job_id = j.id
                          AND ja.membership_id = $1 AND ja.ended_at IS NULL)`,
      needsMembership: true,
    };
  }
  throw forbidden();
}

export async function assertJobAccess(tx: Tx, ctx: OrgContext, jobId: string): Promise<void> {
  const vis = jobVisibilitySql(ctx);
  const { rowCount } = await tx.query(
    `SELECT 1 FROM jobs j WHERE j.id = $2 AND j.deleted_at IS NULL AND (${vis.where})`,
    [ctx.membershipId, jobId],
  );
  if (!rowCount) throw notFound();
}

export function vehicleVisibilitySql(ctx: OrgContext): string {
  if (ctx.has("vehicles.read_all")) return "$1::uuid IS NOT NULL";
  if (ctx.has("vehicles.read_assigned")) {
    return `EXISTS (SELECT 1 FROM vehicle_assignments va
                     WHERE va.organization_id = v.organization_id AND va.vehicle_id = v.id
                       AND va.membership_id = $1 AND va.ends_at IS NULL)`;
  }
  throw forbidden();
}

export async function assertVehicleAccess(tx: Tx, ctx: OrgContext, vehicleId: string): Promise<void> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM vehicles v WHERE v.id = $2 AND v.deleted_at IS NULL AND (${vehicleVisibilitySql(ctx)})`,
    [ctx.membershipId, vehicleId],
  );
  if (!rowCount) throw notFound();
}

/**
 * Active people in the current company who can see one job (everyone with "see every job", plus people with
 * "see jobs they're assigned to" who are assigned to it). Used for @mentions. $1 = company id, $2 = job id.
 * The company filter is explicit because people can always read their own memberships in other companies.
 */
export const JOB_PEOPLE_SQL = `
  SELECT m.id, u.display_name AS name, m.avatar_updated_at
    FROM organization_memberships m
    JOIN users u ON u.id = m.user_id AND u.status = 'active'
   WHERE m.organization_id = $1 AND m.status = 'active'
     AND (EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.organization_id = mr.organization_id AND rp.role_id = mr.role_id
                   WHERE mr.organization_id = m.organization_id AND mr.membership_id = m.id AND rp.permission_key = 'jobs.read_all')
          OR (EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.organization_id = mr.organization_id AND rp.role_id = mr.role_id
                       WHERE mr.organization_id = m.organization_id AND mr.membership_id = m.id AND rp.permission_key = 'jobs.read_assigned')
              AND EXISTS (SELECT 1 FROM job_assignments ja
                           WHERE ja.organization_id = m.organization_id AND ja.job_id = $2 AND ja.membership_id = m.id AND ja.ended_at IS NULL)))`;
