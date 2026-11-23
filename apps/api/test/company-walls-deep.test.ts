import { DEV_AUTH_ISSUER } from "@rsb/contracts";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import sharp from "sharp";
import { setupCompany } from "@rsb/db";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDatabase, NotAMemberError } from "../src/lib/db.js";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Company walls, second pass. company-walls.test.ts sweeps every table and every route. This file checks the
 * things a route-by-route sweep can miss:
 *  - the database rules themselves (every policy, every right the app login has, every "runs as admin" function),
 *  - that a request's company is only ever set after membership is proven, and never survives on a pooled connection,
 *  - many people from different companies at once,
 *  - the server refusing to run on an unsafe database login,
 *  - invites only ever giving roles of their own company,
 *  - photo files being filed under the right company,
 *  - no company A names, titles or emails in anything company B can read.
 */
let t: TestApp;
const A = `/v1/orgs/${ORG_A}`;
const B = `/v1/orgs/${ORG_B}`;
const userId = async (subject: string) => {
  const admin = await adminClient();
  try {
    return (await admin.query<{ id: string }>("SELECT id FROM users WHERE idp_subject = $1", [subject])).rows[0]!.id;
  } finally {
    await admin.end();
  }
};

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe("company walls: the database rules themselves", () => {
  it("every table the app's login can reach has forced row-level security (only the global permission list is shared)", async () => {
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ name: string; kind: string; on: boolean; forced: boolean }>(
        `SELECT n.nspname || '.' || c.relname AS name, c.relkind::text AS kind, c.relrowsecurity AS on, c.relforcerowsecurity AS forced
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (has_table_privilege('rsb_app', c.oid, 'SELECT') OR has_table_privilege('rsb_app', c.oid, 'INSERT')
              OR has_table_privilege('rsb_app', c.oid, 'UPDATE') OR has_table_privilege('rsb_app', c.oid, 'DELETE')
              OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0
                          AND has_column_privilege('rsb_app', c.oid, a.attnum, 'SELECT,INSERT,UPDATE')))
          ORDER BY 1`,
      );
      // A view or materialized view would run with its owner's rights and skip row-level security entirely.
      expect(rows.filter((r) => r.kind !== "r" && r.kind !== "p").map((r) => r.name)).toEqual([]);
      const unwalled = rows.filter((r) => !(r.on && r.forced)).map((r) => r.name);
      expect(unwalled).toEqual(["public.permissions"]);
      expect(rows.length).toBeGreaterThan(18);
    } finally {
      await admin.end();
    }
  });

  it("every policy is for the app role (or the admin tools), and every policy that lets the app write is tied to the current company", async () => {
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ t: string; p: string; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
        "SELECT tablename AS t, policyname AS p, cmd, roles::text[] AS roles, qual, with_check AS check FROM pg_policies ORDER BY 1, 2",
      );
      const appPolicies = rows.filter((r) => r.roles.join() === "rsb_app");
      const toolPolicies = rows.filter((r) => r.roles.join() === "rsb_admin_tools");
      expect(rows.filter((r) => !appPolicies.includes(r) && !toolPolicies.includes(r)).map((r) => `${r.p} ${r.roles}`)).toEqual([]);
      expect(appPolicies.length).toBeGreaterThan(18);
      for (const r of appPolicies) {
        // Reads must be tied to the current company or the current person; never "true" or anything open.
        expect({ policy: r.p, qualTied: r.qual === null || /app\.current_(org|user)_id\(\)/.test(r.qual) }).toEqual({ policy: r.p, qualTied: true });
        if (r.cmd !== "SELECT") {
          // Writes: the new row must belong to the current company (audit log: or to no company, for security events).
          const check = r.check ?? r.qual ?? "";
          expect({ policy: r.p, writeTiedToCompany: /(organization_id|\bid) = app\.current_org_id\(\)/.test(check) && !/current_user_id/.test(check) })
            .toEqual({ policy: r.p, writeTiedToCompany: true });
        }
      }
      // Admin tools (setup-company, seed, data migrations) need one full-access policy on every walled table,
      // or they break on a non-superuser admin such as Azure's.
      const { rows: walled } = await admin.query<{ t: string }>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity ORDER BY 1`,
      );
      expect(toolPolicies.map((r) => r.t).sort()).toEqual(walled.map((r) => r.t));
    } finally {
      await admin.end();
    }
  });

  it("only the admin login holds the admin-tools role; the app's login does not, directly or through another role", async () => {
    const admin = await adminClient();
    try {
      const appLogin = new URL(inject("appDbUrl")).username;
      const { rows } = await admin.query<{ app: boolean; app_role: boolean }>(
        "SELECT pg_has_role($1, 'rsb_admin_tools', 'MEMBER') AS app, pg_has_role('rsb_app', 'rsb_admin_tools', 'MEMBER') AS app_role",
        [appLogin],
      );
      expect(rows[0]).toEqual({ app: false, app_role: false });
      const { rows: direct } = await admin.query<{ m: string; login: boolean }>(
        `SELECT r.rolname AS m, r.rolcanlogin AS login FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.member
          WHERE am.roleid = 'rsb_admin_tools'::regrole`,
      );
      for (const d of direct) expect({ member: d.m, isAppLogin: d.m === appLogin || d.m === "rsb_app" }).toEqual({ member: d.m, isAppLogin: false });
    } finally {
      await admin.end();
    }
  });

  it("admin tools work on a non-superuser admin (like Azure's): refused without the admin-tools role, fine with it", async () => {
    const admin = await adminClient();
    const role = `rsb_test_nonsuper_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
      // A stand-in for Azure's admin: no superuser, no bypass of row-level security, ordinary table rights.
      await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      await admin.query(`GRANT USAGE ON SCHEMA app TO ${role}; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
      await admin.query(`GRANT ${role} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`);
      await admin.query(`SET ROLE ${role}`);
      await expect(setupCompany(admin, `Nonsuper Co ${role}`, [{ email: `${role}@example.com`, displayName: "Owner" }])).rejects.toThrow(/row-level security/);
      await admin.query("RESET ROLE");
      await admin.query(`GRANT rsb_admin_tools TO ${role}`);
      await admin.query(`SET ROLE ${role}`);
      const r = await setupCompany(admin, `Nonsuper Co ${role}`, [{ email: `${role}@example.com`, displayName: "Owner" }]);
      expect(r.created).toBe(true);
      expect(r.invited).toEqual([`${role}@example.com`]);
      await admin.query("RESET ROLE");
      await admin.query("UPDATE member_invites SET revoked_at = now() WHERE organization_id = $1", [r.orgId]);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}; REVOKE ALL ON SCHEMA app FROM ${role}`)
        .catch((e: Error) => console.error("cleanup: revoke", e.message));
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch((e: Error) => console.error("cleanup: drop role", e.message));
      await admin.end();
    }
  });

  it("the app login's rights are exactly the reviewed list (a new right must be added here on purpose)", async () => {
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ x: string }>(
        `SELECT table_name || ':' || string_agg(privilege_type, ',' ORDER BY privilege_type) AS x
           FROM information_schema.table_privileges WHERE grantee = 'rsb_app' GROUP BY table_name ORDER BY 1`,
      );
      const rw = "INSERT,SELECT,UPDATE";
      expect(rows.map((r) => r.x)).toEqual([
        "audit_events:INSERT,SELECT",
        `customers:${rw}`, `documents:${rw}`, `job_assignments:${rw}`, `jobs:${rw}`, `maintenance_records:${rw}`,
        "member_invites:INSERT,SELECT",
        "membership_roles:DELETE,INSERT,SELECT,UPDATE",
        `mileage_records:${rw}`,
        // 0022: alerts are add-only (only "read" can change); alert settings can only change the muted list.
        "notification_preferences:INSERT,SELECT", "notifications:INSERT,SELECT",
        "organization_memberships:SELECT", "organizations:SELECT", "permissions:SELECT",
        // 0019: comments are add-only; only their wording and edited/deleted markers can change (column grants below).
        "photo_comment_mentions:INSERT,SELECT", "photo_comment_revisions:INSERT,SELECT", "photo_comments:INSERT,SELECT",
        `photo_flags:${rw}`,
        // 0020: marks on photos are add-only; they can only be marked removed (column grants below).
        // 0021: issues; their history is add-only, and only an issue's working fields can change (column grants below).
        "photo_issue_events:INSERT,SELECT", "photo_issues:INSERT,SELECT",
        "photo_markups:INSERT,SELECT",
        `photos:${rw}`, `receipts:${rw}`,
        "role_permissions:DELETE,INSERT,SELECT,UPDATE", "roles:DELETE,INSERT,SELECT,UPDATE",
        "users:SELECT",
        `vehicle_assignments:${rw}`, `vehicles:${rw}`,
      ]);
      const { rows: cols } = await admin.query<{ x: string }>(
        `SELECT table_name || '.' || column_name || ':' || privilege_type AS x FROM information_schema.column_privileges cp
          WHERE grantee = 'rsb_app' AND NOT EXISTS (SELECT 1 FROM information_schema.table_privileges tp
                 WHERE tp.grantee = 'rsb_app' AND tp.table_name = cp.table_name AND tp.privilege_type = cp.privilege_type)
          ORDER BY 1`,
      );
      expect(cols.map((r) => r.x)).toEqual([
        "member_invites.expires_at:UPDATE",
        "member_invites.revoked_at:UPDATE",
        "notification_preferences.muted_kinds:UPDATE",
        "notification_preferences.updated_at:UPDATE",
        "notifications.read_at:UPDATE",
        // 0018: profile pictures. The API only lets people change their own (or a team manager remove one).
        "organization_memberships.avatar_storage_key:UPDATE",
        "organization_memberships.avatar_updated_at:UPDATE",
        "organization_memberships.job_title:UPDATE",
        "organization_memberships.status:UPDATE",
        "organizations.deleted_photo_retention_days:UPDATE",
        "organizations.sign_in_every_days:UPDATE",
        "photo_comments.body:UPDATE",
        "photo_comments.deleted_at:UPDATE",
        "photo_comments.deleted_by_membership_id:UPDATE",
        "photo_comments.edited_at:UPDATE",
        "photo_issues.assignee_membership_id:UPDATE",
        "photo_issues.details:UPDATE",
        "photo_issues.resolved_at:UPDATE",
        "photo_issues.resolved_by_membership_id:UPDATE",
        "photo_issues.status:UPDATE",
        "photo_issues.submitted_by_membership_id:UPDATE",
        "photo_issues.title:UPDATE",
        "photo_issues.updated_at:UPDATE",
        "photo_markups.removed_at:UPDATE",
        "photo_markups.removed_by_membership_id:UPDATE",
      ]);
    } finally {
      await admin.end();
    }
  });

  it("only the reviewed 'runs with admin rights' functions exist; each pins its search path and is closed to the public", async () => {
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ name: string; cfg: string[] | null; pub: boolean; app: boolean }>(
        `SELECT n.nspname || '.' || p.proname AS name, p.proconfig AS cfg,
                has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('rsb_app', p.oid, 'EXECUTE') AS app
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1`,
      );
      expect(rows.map((r) => `${r.name}${r.app ? " (app may call)" : ""}`)).toEqual([
        "app.my_invites (app may call)",
        "app.photos_past_retention (app may call)",
        "app.purge_deleted_photo (app may call)",
        "app.register_invited_user (app may call)",
        "app.require_an_owner",
        "app.resolve_principal (app may call)",
        "app.respond_to_invite (app may call)",
      ]);
      for (const r of rows) {
        expect({ fn: r.name, public: r.pub }).toEqual({ fn: r.name, public: false });
        expect({ fn: r.name, pinned: (r.cfg ?? []).some((c) => c.startsWith("search_path=")) }).toEqual({ fn: r.name, pinned: true });
      }
    } finally {
      await admin.end();
    }
  });

  it("people: working as company B, the app sees only people in company B (and the signed-in person)", async () => {
    const riley = await userId("dev-riley-owner");
    const c = await appRoleClient();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [riley, ORG_B]);
      // Seeded people only: other test files may have added (and removed) people of their own in company B.
      const { rows } = await c.query<{ email: string }>("SELECT email FROM users WHERE idp_issuer = $1 ORDER BY email", [DEV_AUTH_ISSUER]);
      const visible = rows.map((r) => r.email);
      expect(visible.some((e) => e.endsWith("@harborpine.example.com"))).toBe(false);
      const expected = F.users.filter((u) => u.memberships.some((m) => m.orgId === ORG_B)).map((u) => u.email).sort();
      expect(visible).toEqual(expected);
      // Audit log: none of company A's events, and none of the "no company" security events.
      const { rows: ev } = await c.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE organization_id IS DISTINCT FROM $1", [ORG_B]);
      expect(ev[0]!.n).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
  });

  it("an invite only ever gives roles of its own company, even if another company's role id is slipped into it", async () => {
    const admin = await adminClient();
    const email = `slipped.role.${Date.now()}@example.com`;
    try {
      const { rows: roles } = await admin.query<{ id: string; organization_id: string }>(
        "SELECT id, organization_id FROM roles WHERE key IN ('employee', 'owner') AND organization_id IN ($1, $2)", [ORG_A, ORG_B],
      );
      const aEmployee = roles.find((r) => r.organization_id === ORG_A)!.id;
      const bRoles = roles.filter((r) => r.organization_id === ORG_B).map((r) => r.id);
      // Written straight into the database, past every API check.
      await admin.query("INSERT INTO member_invites (organization_id, email, display_name, role_ids) VALUES ($1, $2, 'Slipped', $3)", [ORG_A, email, [aEmployee, ...bRoles]]);
    } finally {
      await admin.end();
    }
    const c = await appRoleClient();
    let uid = "";
    try {
      await c.query("BEGIN");
      const sub = uuid();
      uid = (await c.query<{ id: string }>("SELECT app.register_invited_user('https://walls.example.com', $1, $2, 'Slipped') AS id", [sub, email])).rows[0]!.id;
      const inv = (await c.query<{ invite_id: string }>("SELECT invite_id FROM app.my_invites('https://walls.example.com', $1, $2)", [sub, email])).rows;
      expect(inv).toHaveLength(1);
      expect((await c.query("SELECT app.respond_to_invite('https://walls.example.com', $1, $2, $3, true) AS o", [sub, email, inv[0]!.invite_id])).rows[0].o).toBe("accepted");
      await c.query("COMMIT");
    } finally {
      await c.end();
    }
    const check = await adminClient();
    try {
      const { rows } = await check.query<{ org: string; role_org: string; key: string }>(
        `SELECT m.organization_id AS org, r.organization_id AS role_org, r.key FROM organization_memberships m
           JOIN membership_roles mr ON mr.membership_id = m.id JOIN roles r ON r.id = mr.role_id WHERE m.user_id = $1`,
        [uid],
      );
      expect(rows).toEqual([{ org: ORG_A, role_org: ORG_A, key: "employee" }]);
    } finally {
      await check.end();
    }
  });

  it("'delete forever' working as company B can't remove company A's photos, even ones in A's Recently Deleted", async () => {
    const p = await t.as("dev-eli-employee").post(`${A}/jobs/${F.jobs[0]!.id}/photos`, {
      clientRef: uuid(), stage: "before", capturedAt: "2026-11-10T15:30:00Z", contentType: "image/jpeg",
    });
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${p.body.id}`)).status).toBe(204);
    const c = await appRoleClient();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_B]);
      expect((await c.query("SELECT * FROM app.purge_deleted_photo($1)", [p.body.id])).rowCount).toBe(0);
      await c.query("COMMIT");
    } finally {
      await c.end();
    }
    const admin = await adminClient();
    try {
      expect((await admin.query("SELECT 1 FROM photos WHERE id = $1", [p.body.id])).rowCount).toBe(1);
    } finally {
      await admin.end();
    }
  });
});

describe("company walls: each request's company", () => {
  it("the company is only switched on after membership is proven; a non-member's code never runs", async () => {
    const riley = await userId("dev-riley-owner");
    let ran = false;
    await expect(t.db.asOrg(riley, ORG_A, async () => { ran = true; })).rejects.toBeInstanceOf(NotAMemberError);
    expect(ran).toBe(false);
    // Suspended members and disabled people are refused the same way.
    const sam = await userId("dev-sam-suspended");
    await expect(t.db.asOrg(sam, ORG_A, async () => { ran = true; })).rejects.toBeInstanceOf(NotAMemberError);
    expect(ran).toBe(false);
    // A real member works, and sees their company as the current one.
    const avery = await userId("dev-avery-owner");
    expect(await t.db.asOrg(avery, ORG_A, async (tx) => (await tx.query("SELECT app.current_org_id() AS o")).rows[0].o)).toBe(ORG_A);
  });

  it("a pooled database connection never keeps a company or person after a request, even one that failed", async () => {
    const db = createDatabase(inject("appDbUrl"));
    try {
      const avery = await userId("dev-avery-owner");
      await Promise.all(Array.from({ length: 10 }, () => db.asOrg(avery, ORG_A, async (tx) => tx.query("SELECT pg_sleep(0.02)"))));
      await Promise.all(Array.from({ length: 10 }, () =>
        db.asOrg(avery, ORG_A, async (tx) => { await tx.query("SELECT 1"); throw new Error("boom"); }).catch(() => undefined)));
      expect(db.pool.totalCount).toBeGreaterThan(1);
      // Take every connection in the pool at once and look at what each one remembers.
      const clients = await Promise.all(Array.from({ length: db.pool.totalCount }, () => db.pool.connect()));
      try {
        for (const c of clients) {
          const { rows } = await c.query("SELECT app.current_org_id() AS o, app.current_user_id() AS u, (SELECT count(*)::int FROM jobs) AS jobs");
          expect(rows[0]).toEqual({ o: null, u: null, jobs: 0 });
        }
      } finally {
        for (const c of clients) c.release();
      }
    } finally {
      await db.close();
    }
  });

  it("many people from both companies at once: every answer holds only the asker's own company", async () => {
    const aTitles = F.jobs.filter((j) => j.orgId === ORG_A).map((j) => j.title);
    const bTitles = F.jobs.filter((j) => j.orgId === ORG_B).map((j) => j.title);
    const calls = Array.from({ length: 60 }, (_, i) =>
      i % 3 === 0 ? { who: "dev-avery-owner", url: `${A}/jobs`, own: aTitles, other: bTitles }
        : i % 3 === 1 ? { who: "dev-riley-owner", url: `${B}/jobs`, own: bTitles, other: aTitles }
          : { who: "dev-casey-both", url: i % 2 ? `${A}/photos` : `${B}/photos`, own: [], other: [] });
    const results = await Promise.all(calls.map(async (c) => ({ c, res: await t.as(c.who).get(c.url) })));
    for (const { c, res } of results) {
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      for (const title of c.other) expect({ url: c.url, leaked: body.includes(title) ? title : null }).toEqual({ url: c.url, leaked: null });
      if (c.own.length) expect(res.body.items.length).toBeGreaterThan(0);
      if (c.url.endsWith("/photos")) {
        const wanted = c.url.startsWith(A) ? F.jobs.filter((j) => j.orgId === ORG_A).map((j) => j.id) : F.jobs.filter((j) => j.orgId === ORG_B).map((j) => j.id);
        for (const p of res.body.items as { jobId: string }[]) expect(wanted).toContain(p.jobId);
      }
    }
  });

  it("the server refuses to start on a database login that could see past the walls (for example the admin login)", async () => {
    const config = loadConfig({ APP_ENV: "test", DATABASE_URL: inject("adminDbUrl"), DEV_AUTH_ENABLED: "false", LOG_LEVEL: "silent" });
    const db = createDatabase(config.databaseUrl);
    try {
      await expect(buildApp({ config, db, devAuth: null })).rejects.toThrow(/Refusing to start.*superuser/);
    } finally {
      await db.close();
    }
  });
});

describe("company walls: photo files and what company B can read", () => {
  it("photo files are filed under the company that took them, however the company id is written", async () => {
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const job = F.jobs.find((j) => j.orgId === ORG_B)!.id;
    const upper = `/v1/orgs/${ORG_B.toUpperCase()}`;
    const rec = await t.as("dev-riley-owner").post(`${upper}/jobs/${job}/photos`, {
      clientRef: uuid(), stage: "after", capturedAt: "2026-11-10T15:30:00Z", contentType: "image/jpeg",
    });
    expect(rec.status).toBe(201);
    expect((await t.as("dev-riley-owner").put(`${upper}/photos/${rec.body.id}/content`, jpeg, "image/jpeg")).status).toBe(200);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ k: string; pk: string }>("SELECT storage_key AS k, preview_storage_key AS pk FROM photos WHERE id = $1", [rec.body.id]);
      expect(rows[0]!.k).toBe(`org/${ORG_B}/photos/${rec.body.id}/original`);
      expect(rows[0]!.pk).toBe(`org/${ORG_B}/photos/${rec.body.id}/preview`);
    } finally {
      await admin.end();
    }
    expect((await t.as("dev-riley-owner").raw(`${B}/photos/${rec.body.id}/content`)).status).toBe(200);
    // Company A's owner can't get the file through either company's address.
    expect((await t.as("dev-avery-owner").raw(`${A}/photos/${rec.body.id}/content`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").raw(`${B}/photos/${rec.body.id}/content?variant=original`)).status).toBe(404);
  });

  it("nothing company B's owner can read contains company A's people, emails, customers or job titles", async () => {
    const onlyA = F.users.filter((u) => u.memberships.every((m) => m.orgId === ORG_A));
    const secrets = [
      ...onlyA.map((u) => u.displayName), ...onlyA.map((u) => u.email), "harborpine", "Harbor Pine",
      ...F.customers.filter((c) => c.orgId === ORG_A).flatMap((c) => [c.name, c.contactName, c.contactEmail]),
      ...F.jobs.filter((j) => j.orgId === ORG_A).flatMap((j) => [j.title, j.id, j.siteAddress ?? ""]).filter(Boolean),
      ORG_A,
    ];
    expect(onlyA.length).toBeGreaterThan(3);
    const reads = ["", "/dashboard", "/jobs", "/photos", "/photo-flags", "/members", "/audit-events?limit=100", "/receipts", "/vehicles",
      "/settings", "/team/members", "/team/roles", "/team/invites", "/team/permissions"];
    const me = await t.as("dev-riley-owner").get("/v1/me");
    const bodies = [JSON.stringify(me.body)];
    for (const r of reads) {
      const res = await t.as("dev-riley-owner").get(`${B}${r}`);
      expect({ r, status: res.status }).toEqual({ r, status: 200 });
      bodies.push(JSON.stringify(res.body));
    }
    for (const job of F.jobs.filter((j) => j.orgId === ORG_B)) {
      bodies.push(JSON.stringify((await t.as("dev-riley-owner").get(`${B}/jobs/${job.id}`)).body));
      bodies.push(JSON.stringify((await t.as("dev-riley-owner").get(`${B}/jobs/${job.id}/photos`)).body));
      bodies.push(JSON.stringify((await t.as("dev-riley-owner").get(`${B}/jobs/${job.id}/photos/deleted`)).body));
    }
    const leaks = secrets.filter((s) => bodies.some((b) => b.includes(s)));
    expect(leaks).toEqual([]);
  });
});
