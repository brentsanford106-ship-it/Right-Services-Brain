import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERMISSIONS, ROLE_TEMPLATES } from "@rsb/contracts";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, type TestApp } from "./helpers.js";

/**
 * Team & Roles: custom roles, who has which role, and the safety rules
 * (no escalation, Owner role locked, never zero owners, company isolation, audit).
 */
let t: TestApp;
const A = `/v1/orgs/${ORG_A}`;
const B = `/v1/orgs/${ORG_B}`;
const M = {
  avery: "00000000-0000-4b00-8000-00000000a001",
  morgan: "00000000-0000-4b00-8000-00000000a002",
  eli: "00000000-0000-4b00-8000-00000000a003",
  ezra: "00000000-0000-4b00-8000-00000000a004",
  riley: "00000000-0000-4b00-8000-00000000b001",
};
let roleA: Record<string, string> = {};
let roleB: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  const a = await t.as("dev-avery-owner").get(`${A}/team/roles`);
  expect(a.status).toBe(200);
  roleA = Object.fromEntries(a.body.items.map((r: { key: string; id: string }) => [r.key, r.id]));
  const b = await t.as("dev-riley-owner").get(`${B}/team/roles`);
  roleB = Object.fromEntries(b.body.items.map((r: { key: string; id: string }) => [r.key, r.id]));
});

/** Puts company A's roles back exactly as the seed had them, so other test files are unaffected. */
afterAll(async () => {
  const admin = await adminClient();
  try {
    await admin.query("BEGIN");
    await admin.query("DELETE FROM membership_roles WHERE organization_id = $1", [ORG_A]);
    await admin.query("DELETE FROM roles WHERE organization_id = $1 AND NOT is_system", [ORG_A]);
    for (const key of ["manager", "employee"] as const) {
      await admin.query("DELETE FROM role_permissions WHERE role_id = $1", [roleA[key]]);
      for (const p of ROLE_TEMPLATES[key].permissions) {
        await admin.query("INSERT INTO role_permissions (organization_id, role_id, permission_key) VALUES ($1, $2, $3)", [ORG_A, roleA[key], p]);
      }
      await admin.query("UPDATE roles SET name = $2 WHERE id = $1", [roleA[key], ROLE_TEMPLATES[key].name]);
    }
    for (const u of F.users) {
      for (const m of u.memberships.filter((x) => x.orgId === ORG_A)) {
        await admin.query("INSERT INTO membership_roles (organization_id, membership_id, role_id) VALUES ($1, $2, $3)", [ORG_A, m.membershipId, roleA[m.role]]);
      }
    }
    await admin.query("COMMIT");
  } finally {
    await admin.end();
  }
  await t.close();
});

async function audit(action: string, targetId: string) {
  const admin = await adminClient();
  try {
    const { rows } = await admin.query("SELECT actor_membership_id, metadata FROM audit_events WHERE action = $1 AND target_id = $2 ORDER BY occurred_at", [action, targetId]);
    return rows as { actor_membership_id: string; metadata: Record<string, unknown> }[];
  } finally {
    await admin.end();
  }
}

const setRoles = (subject: string, membershipId: string, keys: string[], org = A, ids = roleA) =>
  t.as(subject).patch(`${org}/team/members/${membershipId}`, { roleIds: keys.map((k) => ids[k]) });

describe("who can see and change roles", () => {
  it("owner sees every role; the Owner role is locked and has every permission", async () => {
    const r = await t.as("dev-avery-owner").get(`${A}/team/roles`);
    const owner = r.body.items.find((x: { key: string }) => x.key === "owner");
    expect(owner.locked).toBe(true);
    expect(owner.permissions).toEqual([...PERMISSIONS].sort());
    expect(owner.permissions).toContain("roles.manage");
    expect(owner.permissions).toContain("photos.purge");
    const perms = await t.as("dev-avery-owner").get(`${A}/team/permissions`);
    expect(perms.body.items.map((p: { key: string }) => p.key).sort()).toEqual([...PERMISSIONS].sort());
    const members = await t.as("dev-avery-owner").get(`${A}/team/members`);
    const me = members.body.items.find((m: { membershipId: string }) => m.membershipId === M.avery);
    expect(me.isYou).toBe(true);
    expect(me.roles.map((x: { key: string }) => x.key)).toEqual(["owner"]);
    expect(JSON.stringify(members.body)).not.toContain("@"); // no email addresses
  });

  it("employees can't see or change anything here", async () => {
    const eli = t.as("dev-eli-employee");
    expect((await eli.get(`${A}/team/roles`)).status).toBe(403);
    expect((await eli.get(`${A}/team/members`)).status).toBe(403);
    expect((await eli.post(`${A}/team/roles`, { name: "Mine", permissions: [] })).status).toBe(403);
    expect((await setRoles("dev-eli-employee", M.eli, ["owner"])).status).toBe(403);
  });

  it("managers can view the team but not change roles (no roles.manage by default)", async () => {
    const morgan = t.as("dev-morgan-manager");
    expect((await morgan.get(`${A}/team/members`)).status).toBe(200);
    expect((await morgan.post(`${A}/team/roles`, { name: "Sneaky", permissions: ["photos.upload"] })).status).toBe(403);
    expect((await morgan.patch(`${A}/team/roles/${roleA.employee}`, { permissions: [] })).status).toBe(403);
    expect((await setRoles("dev-morgan-manager", M.morgan, ["owner"])).status).toBe(403);
  });
});

describe("custom roles", () => {
  it("owner creates a role, gives it to someone, it takes effect, and everything is audited", async () => {
    const avery = t.as("dev-avery-owner");
    // Ezra (employee) can't see HP-1001 yet: he isn't assigned to it.
    expect((await t.as("dev-ezra-field").get(`${A}/jobs/${F.jobs[0].id}`)).status).toBe(404);

    const created = await avery.post(`${A}/team/roles`, { name: "Lead Technician", permissions: ["jobs.read_all", "photos.upload", "photos.export"] });
    expect(created.status).toBe(201);
    expect(created.body.builtIn).toBe(false);
    expect(created.body.key).toMatch(/^custom_lead_technician/);
    const lead = created.body.id as string;
    expect((await audit("role.created", lead)).length).toBe(1);

    const dupe = await avery.post(`${A}/team/roles`, { name: "lead technician", permissions: [] });
    expect(dupe.status).toBe(409);

    const set = await avery.patch(`${A}/team/members/${M.ezra}`, { roleIds: [roleA.employee, lead] });
    expect(set.status).toBe(200);
    expect(set.body.roles.map((r: { name: string }) => r.name).sort()).toEqual(["Employee", "Lead Technician"]);
    const a = await audit("member.roles_changed", M.ezra);
    expect(a.at(-1)!.metadata).toMatchObject({ from: ["employee"], to: expect.arrayContaining(["employee", created.body.key]) });
    expect(a.at(-1)!.actor_membership_id).toBe(M.avery);

    // Now Ezra can see every job.
    expect((await t.as("dev-ezra-field").get(`${A}/jobs/${F.jobs[0].id}`)).status).toBe(200);

    // Editing the role changes what Ezra can do straight away.
    const edit = await avery.patch(`${A}/team/roles/${lead}`, { name: "Lead Tech", permissions: ["photos.upload"] });
    expect(edit.status).toBe(200);
    expect(edit.body.permissions).toEqual(["photos.upload"]);
    expect((await audit("role.updated", lead)).at(-1)!.metadata).toMatchObject({ removed: expect.arrayContaining(["jobs.read_all", "photos.export"]), added: [] });
    expect((await t.as("dev-ezra-field").get(`${A}/jobs/${F.jobs[0].id}`)).status).toBe(404);

    // A role that people still have can't be deleted.
    const busy = await avery.del(`${A}/team/roles/${lead}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toMatch(/1 person has this role/);

    expect((await setRoles("dev-avery-owner", M.ezra, ["employee"])).status).toBe(200);
    expect((await avery.del(`${A}/team/roles/${lead}`)).status).toBe(204);
    expect((await audit("role.deleted", lead)).length).toBe(1);
    expect((await avery.get(`${A}/team/roles`)).body.items.some((r: { id: string }) => r.id === lead)).toBe(false);
  });

  it("rejects unknown permissions and an empty role list", async () => {
    const avery = t.as("dev-avery-owner");
    expect((await avery.post(`${A}/team/roles`, { name: "Bad", permissions: ["photos.fly"] })).status).toBe(400);
    expect((await avery.patch(`${A}/team/members/${M.eli}`, { roleIds: [] })).status).toBe(400);
  });

  it("built-in roles can't be deleted, and the Owner role can't be changed at all", async () => {
    const avery = t.as("dev-avery-owner");
    expect((await avery.del(`${A}/team/roles/${roleA.manager}`)).status).toBe(409);
    expect((await avery.del(`${A}/team/roles/${roleA.owner}`)).status).toBe(409);
    expect((await avery.patch(`${A}/team/roles/${roleA.owner}`, { permissions: ["org.read"] })).status).toBe(409);
    expect((await avery.patch(`${A}/team/roles/${roleA.owner}`, { name: "Boss" })).status).toBe(409);
  });

  it("owner can edit the Manager and Employee presets", async () => {
    const avery = t.as("dev-avery-owner");
    const r = await avery.patch(`${A}/team/roles/${roleA.employee}`, { permissions: [...ROLE_TEMPLATES.employee.permissions.filter((p) => p !== "photos.export")] });
    expect(r.status).toBe(200);
    expect(r.body.permissions).not.toContain("photos.export");
    // Takes effect: Eli can no longer share photos.
    expect((await t.as("dev-eli-employee").post(`${A}/photos/exports`, { photoIds: [F.photos[0].id], channel: "download" })).status).toBe(403);
    expect((await avery.patch(`${A}/team/roles/${roleA.employee}`, { permissions: [...ROLE_TEMPLATES.employee.permissions] })).status).toBe(200);
  });
});

describe("nobody can hand out power they don't have", () => {
  let roleAdmin = "";
  beforeAll(async () => {
    // Avery lets Morgan (manager) manage roles.
    const r = await t.as("dev-avery-owner").post(`${A}/team/roles`, { name: "Role admin", permissions: ["roles.manage"] });
    roleAdmin = r.body.id;
    const s = await t.as("dev-avery-owner").patch(`${A}/team/members/${M.morgan}`, { roleIds: [roleA.manager, roleAdmin] });
    expect(s.status).toBe(200);
  });

  it("a manager with roles.manage can't create or grow a role beyond their own permissions", async () => {
    const morgan = t.as("dev-morgan-manager");
    const tooMuch = await morgan.post(`${A}/team/roles`, { name: "Money", permissions: ["financials.read"] });
    expect(tooMuch.status).toBe(403);
    expect(tooMuch.body.error.message).toMatch(/permissions that you have yourself/);
    expect((await morgan.patch(`${A}/team/roles/${roleA.manager}`, { permissions: [...ROLE_TEMPLATES.manager.permissions, "audit.read"] })).status).toBe(403);
    // Within their own powers is fine (including editing the Employee preset).
    const ok = await morgan.post(`${A}/team/roles`, { name: "Photographer", permissions: ["photos.upload", "jobs.read_assigned"] });
    expect(ok.status).toBe(201);
    expect((await morgan.patch(`${A}/team/roles/${roleA.employee}`, { permissions: [...ROLE_TEMPLATES.employee.permissions] })).status).toBe(200);
    expect((await morgan.del(`${A}/team/roles/${ok.body.id}`)).status).toBe(204);
  });

  it("a manager can't make anyone (including themselves) an owner, or change an owner's roles", async () => {
    expect((await setRoles("dev-morgan-manager", M.morgan, ["owner"])).status).toBe(403);
    expect((await setRoles("dev-morgan-manager", M.eli, ["owner"])).status).toBe(403);
    expect((await setRoles("dev-morgan-manager", M.avery, ["employee"])).status).toBe(403);
    expect((await t.as("dev-morgan-manager").patch(`${A}/team/roles/${roleA.owner}`, { name: "x" })).status).toBe(409);
    // Denials are audited.
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.permission_denied' AND actor_membership_id = $1", [M.morgan]);
      expect(rows[0].n).toBeGreaterThan(0);
    } finally {
      await admin.end();
    }
  });

  it("but can move an employee between roles they fully cover", async () => {
    expect((await setRoles("dev-morgan-manager", M.eli, ["employee", "manager"])).status).toBe(200);
    expect((await setRoles("dev-morgan-manager", M.eli, ["employee"])).status).toBe(200);
  });

  afterAll(async () => {
    await t.as("dev-avery-owner").patch(`${A}/team/members/${M.morgan}`, { roleIds: [roleA.manager] });
    await t.as("dev-avery-owner").del(`${A}/team/roles/${roleAdmin}`);
  });
});

describe("the company always keeps an owner", () => {
  it("the only owner can't remove their own Owner role", async () => {
    const r = await setRoles("dev-avery-owner", M.avery, ["manager"]);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/at least one active owner/);
    const members = await t.as("dev-avery-owner").get(`${A}/team/members`);
    expect(members.body.items.find((m: { membershipId: string }) => m.membershipId === M.avery).roles.map((x: { key: string }) => x.key)).toEqual(["owner"]);
  });

  it("with a co-owner, either owner can step down, and the other can promote them back", async () => {
    expect((await setRoles("dev-avery-owner", M.morgan, ["owner"])).status).toBe(200);
    expect((await setRoles("dev-avery-owner", M.avery, ["manager"])).status).toBe(200);
    // Morgan is now the only owner.
    expect((await setRoles("dev-morgan-manager", M.morgan, ["manager"])).status).toBe(409);
    expect((await setRoles("dev-morgan-manager", M.avery, ["owner"])).status).toBe(200);
    expect((await setRoles("dev-avery-owner", M.morgan, ["manager"])).status).toBe(200);
  });
});

describe("company isolation", () => {
  it("ids from another company are never found", async () => {
    const avery = t.as("dev-avery-owner");
    expect((await avery.patch(`${A}/team/members/${M.eli}`, { roleIds: [roleB.owner] })).status).toBe(404);
    expect((await avery.patch(`${A}/team/members/${M.riley}`, { roleIds: [roleA.employee] })).status).toBe(404);
    expect((await avery.patch(`${A}/team/roles/${roleB.manager}`, { name: "Hijacked" })).status).toBe(404);
    expect((await avery.del(`${A}/team/roles/${roleB.manager}`)).status).toBe(404);
    expect((await avery.get(`${B}/team/roles`)).status).toBe(404);
    // Riley (owner of B) can't reach A at all; Casey's manager role in B grants nothing in A.
    expect((await t.as("dev-riley-owner").patch(`${A}/team/members/${M.eli}`, { roleIds: [roleA.owner] })).status).toBe(404);
    expect((await t.as("dev-casey-both").get(`${A}/team/members`)).status).toBe(403);
    // B's roles are untouched.
    const b = await t.as("dev-riley-owner").get(`${B}/team/roles`);
    expect(b.body.items.find((r: { key: string }) => r.key === "manager").name).toBe("Manager");
  });
});

describe("database safety nets (even if the API had a bug)", () => {
  async function inOrgAsApp(orgId: string, sql: string, params: unknown[] = []) {
    const c = await appRoleClient();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      await c.query(sql, params);
      await c.query("COMMIT");
      return "ok";
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      return (e as Error).message;
    } finally {
      await c.end();
    }
  }

  it("refuses to weaken, rename or delete the Owner role, or remove the last owner", async () => {
    expect(await inOrgAsApp(ORG_A, "DELETE FROM role_permissions WHERE role_id = $1", [roleA.owner])).toMatch(/every permission/);
    expect(await inOrgAsApp(ORG_A, "UPDATE roles SET name = 'Boss' WHERE id = $1", [roleA.owner])).toMatch(/cannot change/);
    expect(await inOrgAsApp(ORG_A, "DELETE FROM roles WHERE id = $1", [roleA.manager])).toMatch(/cannot be deleted/);
    expect(await inOrgAsApp(ORG_A, "DELETE FROM membership_roles WHERE role_id = $1", [roleA.owner])).toMatch(/at least one active owner/);
  });

  it("row-level security hides other companies' roles from writes", async () => {
    expect(await inOrgAsApp(ORG_A, "UPDATE roles SET name = 'Hijacked' WHERE id = $1", [roleB.employee])).toBe("ok"); // matched 0 rows
    const b = await t.as("dev-riley-owner").get(`${B}/team/roles`);
    expect(b.body.items.find((r: { key: string }) => r.key === "employee").name).toBe("Employee");
    expect(await inOrgAsApp(ORG_A, "INSERT INTO membership_roles (organization_id, membership_id, role_id) VALUES ($1, $2, $3)", [ORG_B, M.riley, roleB.employee])).toMatch(/row-level security/);
  });
});
