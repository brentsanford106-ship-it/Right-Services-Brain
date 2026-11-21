import type { FastifyInstance } from "fastify";
import {
  CreateInviteRequest,
  CreateRoleRequest,
  InviteParams,
  SetMemberStatusRequest,
  type TeamInvite,
  MemberParams,
  OrgParams,
  PERMISSIONS,
  PERMISSION_INFO,
  RoleParams,
  SetMemberRolesRequest,
  UpdateOrgSettingsRequest,
  UpdateRoleRequest,
  type OrgSettings,
  type Permission,
  type PermissionInfo,
  type TeamMember,
  type TeamRole,
} from "@rsb/contracts";
import { inOrg, type OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError, notFound } from "../lib/errors.js";
import type { RouteDeps } from "./index.js";

/**
 * Team & Roles: owners (or anyone given `roles.manage`) create roles, choose what each role may do,
 * and choose each person's roles. Every rule is enforced here and in the database, never only in the app:
 *
 *  - Everything stays inside the caller's company (row-level security + explicit checks; other companies' ids give 404).
 *  - You can't hand out power you don't have: to create, edit, delete or assign a role, you must hold EVERY
 *    permission that role has before and after the change. So a manager can never touch the Owner role,
 *    an owner's roles, or create a role stronger than themselves.
 *  - The Owner role always has every permission; it can't be edited, renamed or deleted (database trigger).
 *  - A company can never be left without an active owner (database trigger, checked before commit).
 *  - Every change is written to the audit log.
 */

const NOT_YOURS = "You can only give out (or take away) permissions that you have yourself.";
const OWNER_LOCKED = "The Owner role always has every permission and can't be changed.";
const LAST_OWNER = "The company needs at least one active owner. Make someone else an owner first.";

interface RoleRow {
  id: string;
  key: string;
  name: string;
  is_system: boolean;
  permissions: string[] | null;
  member_count: number;
}

const toRole = (r: RoleRow): TeamRole => ({
  id: r.id,
  key: r.key,
  name: r.name,
  builtIn: r.is_system,
  locked: r.key === "owner",
  permissions: (r.permissions ?? []).sort(),
  memberCount: r.member_count,
});

async function loadRoles(tx: Tx, where = "TRUE", params: unknown[] = []): Promise<RoleRow[]> {
  const { rows } = await tx.query<RoleRow>(
    `SELECT r.id, r.key, r.name, r.is_system,
            (SELECT array_agg(rp.permission_key ORDER BY rp.permission_key) FROM role_permissions rp
              WHERE rp.organization_id = r.organization_id AND rp.role_id = r.id) AS permissions,
            (SELECT count(*)::int FROM membership_roles mr
              WHERE mr.organization_id = r.organization_id AND mr.role_id = r.id) AS member_count
       FROM roles r
      WHERE ${where}
      ORDER BY CASE r.key WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'employee' THEN 2 ELSE 3 END, lower(r.name)`,
    params,
  );
  return rows;
}

async function loadRole(tx: Tx, roleId: string): Promise<RoleRow> {
  const rows = await loadRoles(tx, "r.id = $1", [roleId]);
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** A broader permission covers its narrower twin (seeing ALL jobs includes seeing your assigned jobs). */
const COVERED_BY: Partial<Record<Permission, Permission>> = {
  "jobs.read_assigned": "jobs.read_all",
  "vehicles.read_assigned": "vehicles.read_all",
  "receipts.read_own": "receipts.read_all",
};

/** Throws 403 unless the caller holds every listed permission. */
function mustHoldAll(ctx: OrgContext, perms: Iterable<string>): void {
  for (const p of perms) {
    const broader = COVERED_BY[p as Permission];
    if (!ctx.has(p as Permission) && !(broader && ctx.has(broader))) throw new HttpError("forbidden", NOT_YOURS);
  }
}

function validPermissions(perms: string[]): Permission[] {
  const known = new Set<string>(PERMISSIONS);
  const unique = [...new Set(perms)];
  const bad = unique.filter((p) => !known.has(p));
  if (bad.length) throw new HttpError("validation_failed", "Unknown permission.", bad.map((p) => ({ path: "permissions", issue: p })));
  return unique as Permission[];
}

async function assertNameFree(tx: Tx, name: string, exceptRoleId: string | null): Promise<void> {
  const { rows } = await tx.query("SELECT 1 FROM roles WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)", [name, exceptRoleId]);
  if (rows.length) throw new HttpError("conflict", "A role with that name already exists.");
}

async function newRoleKey(tx: Tx, name: string): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "role";
  let key = `custom_${slug}`;
  for (let i = 0; i < 5; i++) {
    const { rows } = await tx.query("SELECT 1 FROM roles WHERE key = $1", [key]);
    if (!rows.length) return key;
    const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
    key = `custom_${slug}_${suffix}`;
  }
  throw new HttpError("conflict");
}

/** Runs the "company keeps an owner" check now (instead of at commit) so it can be turned into a friendly message. */
async function checkOwnerRule(tx: Tx): Promise<void> {
  try {
    await tx.query("SET CONSTRAINTS membership_roles_keep_owner IMMEDIATE");
  } catch (e) {
    if (/at least one active owner/.test((e as Error).message)) throw new HttpError("conflict", LAST_OWNER);
    throw e;
  }
}

async function permissionsOfRoles(tx: Tx, roleIds: string[]): Promise<Set<string>> {
  if (!roleIds.length) return new Set();
  const { rows } = await tx.query<{ permission_key: string }>("SELECT DISTINCT permission_key FROM role_permissions WHERE role_id = ANY($1::uuid[])", [roleIds]);
  return new Set(rows.map((r) => r.permission_key));
}

export async function teamRoutes(app: FastifyInstance, { db, config }: RouteDeps): Promise<void> {
  // ------------------------------------------------------------ read
  app.get("/v1/orgs/:orgId/team/permissions", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (_tx, ctx) => {
      ctx.require("roles.manage", "members.read");
      const items: PermissionInfo[] = PERMISSIONS.map((key) => ({
        key,
        group: PERMISSION_INFO[key].group,
        label: PERMISSION_INFO[key].label,
        inUse: PERMISSION_INFO[key].phase1 || config.phase2Features,
      }));
      return { items };
    });
  });

  app.get("/v1/orgs/:orgId/team/roles", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("roles.manage", "members.read");
      return { items: (await loadRoles(tx)).map(toRole) };
    });
  });

  app.get("/v1/orgs/:orgId/team/members", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("roles.manage", "members.read");
      const { rows } = await tx.query<{
        id: string; display_name: string; job_title: string | null; status: TeamMember["status"];
        roles: { id: string; key: string; name: string }[] | null;
      }>(
        `SELECT m.id, u.display_name, m.job_title, m.status,
                (SELECT json_agg(json_build_object('id', r.id, 'key', r.key, 'name', r.name) ORDER BY r.name)
                   FROM membership_roles mr JOIN roles r ON r.organization_id = mr.organization_id AND r.id = mr.role_id
                  WHERE mr.organization_id = m.organization_id AND mr.membership_id = m.id) AS roles
           FROM organization_memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1
          ORDER BY (m.status = 'active') DESC, u.display_name`,
        [ctx.orgId],
      );
      // Email addresses are deliberately not returned (data minimisation).
      const items: TeamMember[] = rows.map((r) => ({
        membershipId: r.id,
        displayName: r.display_name,
        jobTitle: r.job_title,
        status: r.status,
        isYou: r.id === ctx.membershipId,
        roles: r.roles ?? [],
      }));
      return { items };
    });
  });

  // ------------------------------------------------------------ roles
  app.post("/v1/orgs/:orgId/team/roles", async (req, reply) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(CreateRoleRequest, req.body);
    const role = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("roles.manage");
      const perms = validPermissions(body.permissions);
      mustHoldAll(ctx, perms);
      await assertNameFree(tx, body.name, null);
      const key = await newRoleKey(tx, body.name);
      const { rows } = await tx.query<{ id: string }>(
        "INSERT INTO roles (organization_id, key, name, is_system) VALUES ($1, $2, $3, false) RETURNING id",
        [ctx.orgId, key, body.name],
      );
      const id = rows[0]!.id;
      if (perms.length) {
        await tx.query(
          "INSERT INTO role_permissions (organization_id, role_id, permission_key) SELECT $1, $2, unnest($3::text[])",
          [ctx.orgId, id, perms],
        );
      }
      await recordAudit(tx, ctx, "role.created", "role", id, { key, permissions: perms });
      return toRole(await loadRole(tx, id));
    });
    return reply.status(201).send(role);
  });

  app.patch("/v1/orgs/:orgId/team/roles/:roleId", async (req) => {
    const { orgId, roleId } = parse(RoleParams, req.params);
    const body = parse(UpdateRoleRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("roles.manage");
      const role = await loadRole(tx, roleId);
      if (role.key === "owner") throw new HttpError("conflict", OWNER_LOCKED);
      const before = new Set(role.permissions ?? []);
      // You may only edit a role that is no stronger than you, before and after the change.
      mustHoldAll(ctx, before);
      const changes: Record<string, string[] | string> = {};
      if (body.name !== undefined && body.name !== role.name) {
        await assertNameFree(tx, body.name, roleId);
        await tx.query("UPDATE roles SET name = $2 WHERE id = $1", [roleId, body.name]);
        changes.renamed = "yes";
      }
      if (body.permissions !== undefined) {
        const after = new Set<string>(validPermissions(body.permissions));
        mustHoldAll(ctx, after);
        const added = [...after].filter((p) => !before.has(p));
        const removed = [...before].filter((p) => !after.has(p));
        if (removed.length) {
          await tx.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_key = ANY($2::text[])", [roleId, removed]);
        }
        if (added.length) {
          await tx.query(
            "INSERT INTO role_permissions (organization_id, role_id, permission_key) SELECT $1, $2, unnest($3::text[])",
            [ctx.orgId, roleId, added],
          );
        }
        changes.added = added;
        changes.removed = removed;
      }
      await recordAudit(tx, ctx, "role.updated", "role", roleId, { key: role.key, ...changes });
      return toRole(await loadRole(tx, roleId));
    });
  });

  app.delete("/v1/orgs/:orgId/team/roles/:roleId", async (req, reply) => {
    const { orgId, roleId } = parse(RoleParams, req.params);
    await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("roles.manage");
      const role = await loadRole(tx, roleId);
      if (role.is_system) throw new HttpError("conflict", "Built-in roles (Owner, Manager, Employee) can't be deleted.");
      mustHoldAll(ctx, role.permissions ?? []);
      if (role.member_count > 0) {
        throw new HttpError("conflict", `${role.member_count} ${role.member_count === 1 ? "person has" : "people have"} this role. Give them a different role first.`);
      }
      await tx.query("DELETE FROM roles WHERE id = $1", [roleId]);
      await recordAudit(tx, ctx, "role.deleted", "role", roleId, { key: role.key });
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------ who has which role
  app.patch("/v1/orgs/:orgId/team/members/:membershipId", async (req) => {
    const { orgId, membershipId } = parse(MemberParams, req.params);
    const body = parse(SetMemberRolesRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("roles.manage");
      const { rows: m } = await tx.query("SELECT 1 FROM organization_memberships WHERE id = $1 AND organization_id = $2", [membershipId, ctx.orgId]);
      if (!m.length) throw notFound();

      const wanted = [...new Set(body.roleIds)];
      const { rows: found } = await tx.query<{ id: string; key: string }>("SELECT id, key FROM roles WHERE id = ANY($1::uuid[])", [wanted]);
      if (found.length !== wanted.length) throw notFound(); // includes roles from another company

      const { rows: current } = await tx.query<{ role_id: string; key: string }>(
        "SELECT mr.role_id, r.key FROM membership_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.membership_id = $1",
        [membershipId],
      );
      // You can't change the roles of someone stronger than you, or give anyone more than you have.
      mustHoldAll(ctx, await permissionsOfRoles(tx, current.map((c) => c.role_id)));
      mustHoldAll(ctx, await permissionsOfRoles(tx, wanted));

      const currentIds = new Set(current.map((c) => c.role_id));
      const wantedSet = new Set(wanted);
      const toRemove = [...currentIds].filter((id) => !wantedSet.has(id));
      const toAdd = wanted.filter((id) => !currentIds.has(id));
      if (toRemove.length) {
        await tx.query("DELETE FROM membership_roles WHERE membership_id = $1 AND role_id = ANY($2::uuid[])", [membershipId, toRemove]);
      }
      if (toAdd.length) {
        await tx.query(
          "INSERT INTO membership_roles (organization_id, membership_id, role_id) SELECT $1, $2, unnest($3::uuid[])",
          [ctx.orgId, membershipId, toAdd],
        );
      }
      await checkOwnerRule(tx);
      if (toAdd.length || toRemove.length) {
        await recordAudit(tx, ctx, "member.roles_changed", "membership", membershipId, {
          from: current.map((c) => c.key).sort(),
          to: found.map((f) => f.key).sort(),
        });
      }
      const { rows: roles } = await tx.query<{ id: string; key: string; name: string }>(
        "SELECT r.id, r.key, r.name FROM membership_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.membership_id = $1 ORDER BY r.name",
        [membershipId],
      );
      return { membershipId, roles };
    });
  });

  // ------------------------------------------------------------ adding and removing people
  app.get("/v1/orgs/:orgId/team/invites", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("members.manage", "roles.manage");
      const { rows } = await tx.query<{ id: string; email: string; display_name: string; job_title: string | null; roles: { id: string; name: string }[] | null; invited_by: string; created_at: Date }>(
        `SELECT i.id, i.email, i.display_name, i.job_title, COALESCE(iu.display_name, 'Company setup') AS invited_by, i.created_at,
                (SELECT json_agg(json_build_object('id', r.id, 'name', r.name) ORDER BY r.name) FROM roles r WHERE r.id = ANY (i.role_ids)) AS roles
           FROM member_invites i
           LEFT JOIN organization_memberships im ON im.organization_id = i.organization_id AND im.id = i.invited_by_membership_id
           LEFT JOIN users iu ON iu.id = im.user_id
          WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
          ORDER BY i.created_at DESC`,
      );
      const items: TeamInvite[] = rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.display_name,
        jobTitle: r.job_title,
        roles: r.roles ?? [],
        invitedBy: r.invited_by,
        createdAt: r.created_at.toISOString(),
      }));
      return { items };
    });
  });

  app.post("/v1/orgs/:orgId/team/invites", async (req, reply) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(CreateInviteRequest, req.body);
    const invite = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("members.manage");
      const roleIds = [...new Set(body.roleIds)];
      const { rows: found } = await tx.query<{ id: string }>("SELECT id FROM roles WHERE id = ANY($1::uuid[])", [roleIds]);
      if (found.length !== roleIds.length) throw notFound();
      // Same rule as changing roles: you can't add someone with more power than you have.
      mustHoldAll(ctx, await permissionsOfRoles(tx, roleIds));
      const { rows: existing } = await tx.query<{ status: string }>(
        "SELECT m.status FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND u.email = $2::citext",
        [ctx.orgId, body.email],
      );
      if (existing.some((e) => e.status !== "removed")) throw new HttpError("conflict", "Someone with that email is already in the company.");
      const { rows: open } = await tx.query("SELECT 1 FROM member_invites WHERE email = $1::citext AND accepted_at IS NULL AND revoked_at IS NULL", [body.email]);
      if (open.length) throw new HttpError("conflict", "That email has already been added and is waiting for its first sign-in.");
      const { rows } = await tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO member_invites (organization_id, email, display_name, job_title, role_ids, invited_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [ctx.orgId, body.email, body.displayName, body.jobTitle ?? null, roleIds, ctx.membershipId],
      );
      const id = rows[0]!.id;
      // The email address itself is deliberately not copied into the audit log.
      await recordAudit(tx, ctx, "member.invited", "member_invite", id, { roleIds });
      return { id, createdAt: rows[0]!.created_at.toISOString() };
    });
    return reply.status(201).send(invite);
  });

  app.delete("/v1/orgs/:orgId/team/invites/:inviteId", async (req, reply) => {
    const { orgId, inviteId } = parse(InviteParams, req.params);
    await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("members.manage");
      const { rowCount } = await tx.query("UPDATE member_invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [inviteId]);
      if (rowCount !== 1) throw notFound();
      await recordAudit(tx, ctx, "member.invite_revoked", "member_invite", inviteId);
    });
    return reply.status(204).send();
  });

  app.patch("/v1/orgs/:orgId/team/members/:membershipId/status", async (req) => {
    const { orgId, membershipId } = parse(MemberParams, req.params);
    const body = parse(SetMemberStatusRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("members.manage");
      const { rows: m } = await tx.query<{ status: string }>("SELECT status FROM organization_memberships WHERE id = $1 AND organization_id = $2", [membershipId, ctx.orgId]);
      if (!m[0]) throw notFound();
      const { rows: current } = await tx.query<{ role_id: string }>("SELECT role_id FROM membership_roles WHERE membership_id = $1", [membershipId]);
      // You can't remove or suspend someone with more power than you.
      mustHoldAll(ctx, await permissionsOfRoles(tx, current.map((c) => c.role_id)));
      if (m[0].status !== body.status) {
        await tx.query("UPDATE organization_memberships SET status = $2 WHERE id = $1", [membershipId, body.status]);
        try {
          await tx.query("SET CONSTRAINTS memberships_keep_owner IMMEDIATE");
        } catch (e) {
          if (/at least one active owner/.test((e as Error).message)) throw new HttpError("conflict", LAST_OWNER);
          throw e;
        }
        await recordAudit(tx, ctx, "member.status_changed", "membership", membershipId, { from: m[0].status, to: body.status });
      }
      return { membershipId, status: body.status };
    });
  });

  // ------------------------------------------------------------ company settings
  app.get("/v1/orgs/:orgId/settings", async (req): Promise<OrgSettings> => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("org.read");
      const { rows } = await tx.query<{ days: number; sign_in: number }>(
        "SELECT deleted_photo_retention_days AS days, sign_in_every_days AS sign_in FROM organizations WHERE id = $1",
        [ctx.orgId],
      );
      return { deletedPhotoRetentionDays: rows[0]!.days, signInEveryDays: rows[0]!.sign_in, canEdit: ctx.has("org.manage") };
    });
  });

  app.patch("/v1/orgs/:orgId/settings", async (req): Promise<OrgSettings> => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(UpdateOrgSettingsRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("org.manage");
      const { rows: before } = await tx.query<{ days: number; sign_in: number }>(
        "SELECT deleted_photo_retention_days AS days, sign_in_every_days AS sign_in FROM organizations WHERE id = $1",
        [ctx.orgId],
      );
      if (!before[0]) throw notFound();
      const days = body.deletedPhotoRetentionDays ?? before[0].days;
      const signIn = body.signInEveryDays ?? before[0].sign_in;
      const { rowCount } = await tx.query("UPDATE organizations SET deleted_photo_retention_days = $2, sign_in_every_days = $3 WHERE id = $1", [ctx.orgId, days, signIn]);
      if (rowCount !== 1) throw notFound();
      if (days !== before[0].days) {
        await recordAudit(tx, ctx, "org.settings_updated", "organization", ctx.orgId, { setting: "deleted_photo_retention_days", from: before[0].days, to: days });
      }
      if (signIn !== before[0].sign_in) {
        await recordAudit(tx, ctx, "org.settings_updated", "organization", ctx.orgId, { setting: "sign_in_every_days", from: before[0].sign_in, to: signIn });
      }
      return { deletedPhotoRetentionDays: days, signInEveryDays: signIn, canEdit: true };
    });
  });
}
