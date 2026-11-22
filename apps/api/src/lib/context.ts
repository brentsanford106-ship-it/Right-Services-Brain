import type { FastifyRequest } from "fastify";
import type { Permission } from "@rsb/contracts";
import { NotAMemberError, type Database, type Tx } from "./db.js";
import { HttpError, notFound, unauthenticated } from "./errors.js";
import { recordAudit, recordSecurityEvent } from "./audit.js";

/** Authorization context for one request inside one organization. Built ONLY from database state. */
export interface OrgContext {
  userId: string;
  orgId: string;
  membershipId: string;
  roles: string[];
  permissions: ReadonlySet<Permission>;
  requestId: string;
  has(p: Permission): boolean;
  /** Throws 403 unless the member has at least one of the permissions. */
  require(...anyOf: Permission[]): void;
}

class PermissionDenied extends HttpError {
  constructor(readonly needed: Permission[]) {
    super("forbidden");
  }
}

class NoMembership extends Error {}

async function loadContext(tx: Tx, userId: string, orgId: string, requestId: string): Promise<OrgContext | null> {
  // RLS already restricts these rows to orgId; the explicit filters are a second check.
  const { rows } = await tx.query<{ membership_id: string; roles: string[] | null; permissions: string[] | null }>(
    `SELECT m.id AS membership_id,
            array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL) AS roles,
            array_agg(DISTINCT rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL) AS permissions
       FROM organization_memberships m
       JOIN organizations o ON o.id = m.organization_id AND o.status = 'active'
       JOIN users u ON u.id = m.user_id AND u.status = 'active'
       LEFT JOIN membership_roles mr ON mr.membership_id = m.id AND mr.organization_id = m.organization_id
       LEFT JOIN roles r ON r.id = mr.role_id AND r.organization_id = m.organization_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id AND rp.organization_id = m.organization_id
      WHERE m.organization_id = $1 AND m.user_id = $2 AND m.status = 'active'
      GROUP BY m.id`,
    [orgId, userId],
  );
  const row = rows[0];
  if (!row) return null;
  const permissions = new Set((row.permissions ?? []) as Permission[]);
  return {
    userId,
    orgId,
    membershipId: row.membership_id,
    roles: row.roles ?? [],
    permissions,
    requestId,
    has: (p) => permissions.has(p),
    require: (...anyOf) => {
      if (!anyOf.some((p) => permissions.has(p))) throw new PermissionDenied(anyOf);
    },
  };
}

export function requireUser(req: FastifyRequest): string {
  if (!req.principal) throw unauthenticated();
  return req.principal.userId;
}

/**
 * Runs `fn` inside a transaction scoped to `orgId`, after proving the caller
 * is an active member of that organization. Organization IDs supplied by the
 * client are only ever used as a *lookup key*, never as proof of access.
 *
 * Non-members get 404 (not 403) so the API does not reveal whether another
 * organization or record exists. Denials are written to the audit log.
 */
export async function inOrg<T>(
  db: Database,
  req: FastifyRequest,
  orgId: string,
  fn: (tx: Tx, ctx: OrgContext) => Promise<T>,
): Promise<T> {
  const userId = requireUser(req);
  let ctxForAudit: OrgContext | null = null;
  try {
    return await db.asOrg(userId, orgId, async (tx) => {
      const ctx = await loadContext(tx, userId, orgId, req.id);
      if (!ctx) throw new NoMembership();
      ctxForAudit = ctx;
      return fn(tx, ctx);
    });
  } catch (err) {
    if (err instanceof NoMembership || err instanceof NotAMemberError) {
      await recordSecurityEvent(db, {
        actorUserId: userId,
        action: "authz.org_access_denied",
        requestId: req.id,
        metadata: { route: req.routeOptions.url ?? "unknown" },
      }).catch((e: unknown) => req.log.error({ errName: (e as Error).name }, "failed to write security audit event"));
      throw notFound();
    }
    if (err instanceof PermissionDenied && ctxForAudit) {
      const ctx: OrgContext = ctxForAudit;
      await db
        .asOrg(userId, orgId, (tx) =>
          recordAudit(tx, ctx, "authz.permission_denied", null, null, {
            route: req.routeOptions.url ?? "unknown",
            needed: err.needed,
          }, "denied"),
        )
        .catch((e: unknown) => req.log.error({ errName: (e as Error).name }, "failed to write denial audit event"));
    }
    throw err;
  }
}
