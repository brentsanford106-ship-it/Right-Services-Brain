import type { Tx } from "./db.js";
import type { OrgContext } from "./context.js";
import { JOB_PEOPLE_SQL } from "./access.js";
import type { NotificationKind } from "@rsb/contracts";

/**
 * Writes in-app alerts (step 5). Skips the person who did the action, anyone who can't see the job
 * (or isn't active), and anyone who switched this kind of alert off. Never fails the action it's part of
 * because of who was or wasn't alerted.
 */
export async function notify(
  tx: Tx, ctx: OrgContext,
  n: { kind: NotificationKind; recipients: (string | null | undefined)[]; jobId: string; photoId: string; commentId?: string | null; issueId?: string | null },
): Promise<number> {
  const to = [...new Set(n.recipients.filter((r): r is string => !!r && r !== ctx.membershipId))];
  if (!to.length) return 0;
  const { rowCount } = await tx.query(
    `INSERT INTO notifications (organization_id, recipient_membership_id, actor_membership_id, kind, job_id, photo_id, comment_id, issue_id)
     SELECT $1, r, $3, $4, $2, $5, $6, $7
       FROM unnest($8::uuid[]) AS r
      WHERE r IN (SELECT jp.id FROM (${JOB_PEOPLE_SQL}) jp)
        AND NOT EXISTS (SELECT 1 FROM notification_preferences np
                         WHERE np.organization_id = $1 AND np.membership_id = r AND $4 = ANY (np.muted_kinds))`,
    [ctx.orgId, n.jobId, ctx.membershipId, n.kind, n.photoId, n.commentId ?? null, n.issueId ?? null, to],
  );
  return rowCount ?? 0;
}

/** People on a job who can assign and approve issues (the ones told about new reports and fixes to review). */
export async function jobIssueManagers(tx: Tx, ctx: OrgContext, jobId: string): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT jp.id FROM (${JOB_PEOPLE_SQL}) jp
      WHERE EXISTS (SELECT 1 FROM membership_roles mr JOIN role_permissions rp ON rp.organization_id = mr.organization_id AND rp.role_id = mr.role_id
                     WHERE mr.organization_id = $1 AND mr.membership_id = jp.id AND rp.permission_key = 'photo_issues.manage')`,
    [ctx.orgId, jobId],
  );
  return rows.map((r) => r.id);
}
