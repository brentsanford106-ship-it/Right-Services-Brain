import type { Database, Tx } from "./db.js";
import type { OrgContext } from "./context.js";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * Keys that must never be written to audit metadata. Audit records describe
 * WHO did WHAT to WHICH record; they must not copy record contents.
 */
const FORBIDDEN_KEYS = /token|secret|password|authorization|cookie|email|phone|address|amount|vendor|description|caption|reason|note/i;

function sanitize(metadata: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Writes an audit event in the caller's transaction, so it commits or rolls back with the change it describes. */
export async function recordAudit(
  tx: Tx,
  ctx: OrgContext,
  action: string,
  targetType: string | null,
  targetId: string | null,
  metadata: Record<string, Json> = {},
  outcome: "success" | "denied" | "error" = "success",
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (organization_id, actor_user_id, actor_membership_id, action, outcome, target_type, target_id, request_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [ctx.orgId, ctx.userId, ctx.membershipId, action, outcome, targetType, targetId, ctx.requestId, sanitize(metadata)],
  );
}

/** Security events outside any organization context (for example, probing another organization). */
export async function recordSecurityEvent(
  db: Database,
  ev: { actorUserId: string | null; action: string; requestId: string; metadata?: Record<string, Json> },
): Promise<void> {
  const run = async (tx: Tx) => {
    await tx.query(
      `INSERT INTO audit_events (organization_id, actor_user_id, action, outcome, request_id, metadata)
       VALUES (NULL, $1, $2, 'denied', $3, $4)`,
      [ev.actorUserId, ev.action, ev.requestId, sanitize(ev.metadata ?? {})],
    );
  };
  if (ev.actorUserId) await db.asUser(ev.actorUserId, run);
  else await db.anonymous(run);
}
