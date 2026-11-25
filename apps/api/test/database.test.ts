import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { PERMISSIONS } from "@rsb/contracts";
import { adminClient, appRoleClient, F, ORG_A, ORG_B } from "./helpers.js";
import { DEV_LOGIN_USERS } from "../src/auth/devUsers.js";

/**
 * Database-level controls, tested directly as the restricted runtime role
 * (the same role the API uses), independent of API code. These prove RLS still
 * isolates tenants even if an API route had a bug.
 */
let app: pg.Client;
let admin: pg.Client;
beforeAll(async () => {
  app = await appRoleClient();
  admin = await adminClient();
});
afterAll(async () => {
  await app.end();
  await admin.end();
});

async function asOrg<T>(orgId: string | null, fn: () => Promise<T>, userId = ""): Promise<T> {
  await app.query("BEGIN");
  try {
    await app.query("SELECT set_config('app.current_org_id', $1, true), set_config('app.current_user_id', $2, true)", [orgId ?? "", userId]);
    return await fn();
  } finally {
    await app.query("ROLLBACK");
  }
}

const sqlstate = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe("runtime role", () => {
  it("is not a superuser, cannot bypass RLS, and owns no tables", async () => {
    const { rows } = await app.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await app.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user");
    expect(owned.rows[0].n).toBe(0);
  });

  it("cannot run DDL or delete records", async () => {
    expect(await sqlstate(app.query("CREATE TABLE evil (id int)"))).toBe("42501");
    expect(await asOrg(ORG_A, () => sqlstate(app.query("DELETE FROM jobs")))).toBe("42501");
    expect(await asOrg(ORG_A, () => sqlstate(app.query("TRUNCATE jobs")))).toBe("42501");
  });
});

describe("row-level security", () => {
  const tenantTables = ["customers", "jobs", "job_assignments", "photos", "photo_flags", "photo_comments", "photo_comment_revisions", "photo_comment_mentions", "photo_markups", "photo_issues", "photo_issue_events", "notifications", "notification_preferences", "receipts", "vehicles",
    "vehicle_assignments", "mileage_records", "maintenance_records", "roles", "role_permissions", "membership_roles"];

  it.each(tenantTables)("%s: no rows are visible without an organization context", async (table) => {
    const { rows } = await asOrg(null, () => app.query(`SELECT count(*)::int AS n FROM ${table}`));
    expect(rows[0].n).toBe(0);
  });

  it.each(tenantTables)("%s: with org A context, only org A rows are visible", async (table) => {
    const { rows } = await asOrg(ORG_A, () => app.query(`SELECT DISTINCT organization_id FROM ${table}`));
    expect(rows.every((r) => r.organization_id === ORG_A)).toBe(true);
  });

  it("every tenant table has RLS enabled and forced", async () => {
    const { rows } = await admin.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('schema_migrations', 'permissions')`,
    );
    for (const r of rows) expect([r.relname, r.relrowsecurity, r.relforcerowsecurity]).toEqual([r.relname, true, true]);
  });

  it("cannot insert a row for another organization", async () => {
    const code = await asOrg(ORG_A, () =>
      sqlstate(app.query("INSERT INTO vehicles (organization_id, unit_number, make, model) VALUES ($1, 'EVIL-1', 'x', 'y')", [ORG_B])),
    );
    expect(code).toBe("42501");
  });

  it("cannot move a row to another organization", async () => {
    const code = await asOrg(ORG_A, () => sqlstate(app.query("UPDATE jobs SET organization_id = $1 WHERE id = $2", [ORG_B, F.jobs[0].id])));
    expect(["42501", "23514"]).toContain(code);
  });

  it("updating another organization's rows silently affects nothing", async () => {
    const { rowCount } = await asOrg(ORG_A, () => app.query("UPDATE jobs SET title = 'pwned' WHERE id = $1", [F.jobs[3].id]));
    expect(rowCount).toBe(0);
  });

  it("an empty-string org setting (reset pooled connection) means no access, not an error", async () => {
    await app.query("BEGIN");
    await app.query("SELECT set_config('app.current_org_id', '', true)");
    const { rows } = await app.query("SELECT count(*)::int AS n FROM jobs");
    await app.query("ROLLBACK");
    expect(rows[0].n).toBe(0);
  });

  it("organizations: a user sees only organizations they belong to", async () => {
    const eli = "00000000-0000-4a00-8000-00000000a003";
    const { rows } = await asOrg(null, () => app.query("SELECT id FROM organizations"), eli);
    expect(rows.map((r) => r.id)).toEqual([ORG_A]);
  });
});

describe("audit log", () => {
  it("is append-only even for the owner role", async () => {
    await admin.query("INSERT INTO audit_events (organization_id, action, outcome) VALUES ($1, 'test.event', 'success')", [ORG_A]);
    expect(await sqlstate(admin.query("UPDATE audit_events SET action = 'test.changed'"))).toBe("42501");
    expect(await sqlstate(admin.query("DELETE FROM audit_events"))).toBe("42501");
    expect(await sqlstate(admin.query("TRUNCATE audit_events"))).toBe("42501");
  });
});

describe("constraints", () => {
  const inTx = async (fn: () => Promise<unknown>) => {
    await admin.query("BEGIN");
    try {
      return await sqlstate(fn() as Promise<unknown>);
    } finally {
      await admin.query("ROLLBACK");
    }
  };

  it("job numbers are unique within an organization but may repeat across organizations", async () => {
    expect(await inTx(() => admin.query("INSERT INTO jobs (organization_id, job_number, title) VALUES ($1, 'HP-1001', 'dup')", [ORG_A]))).toBe("23505");
    expect(F.jobs.filter((j) => j.jobNumber === "HP-1001").map((j) => j.orgId).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it("composite foreign keys block cross-organization references", async () => {
    // Org B photo pointing at org A job.
    expect(await inTx(() => admin.query(
      `INSERT INTO photos (organization_id, job_id, content_type, stage, captured_at, uploaded_by_membership_id)
       VALUES ($1, $2, 'image/jpeg', 'before', now(), '00000000-0000-4b00-8000-00000000b002')`, [ORG_B, F.jobs[0].id]))).toBe("23503");
    // Membership in A given a role from B.
    expect(await inTx(async () => {
      const { rows } = await admin.query("SELECT id FROM roles WHERE organization_id = $1 AND key = 'owner'", [ORG_B]);
      return admin.query("INSERT INTO membership_roles (organization_id, membership_id, role_id) VALUES ($1, $2, $3)",
        [ORG_A, "00000000-0000-4b00-8000-00000000a003", rows[0].id]);
    })).toBe("23503");
  });

  it("rejects invalid values", async () => {
    const v = F.vehicles[0];
    expect(await inTx(() => admin.query(
      `INSERT INTO mileage_records (organization_id, vehicle_id, membership_id, trip_date, odometer_start, odometer_end)
       VALUES ($1, $2, '00000000-0000-4b00-8000-00000000a003', '2026-11-01', 100, 50)`, [ORG_A, v.id]))).toBe("23514");
    expect(await inTx(() => admin.query(
      `INSERT INTO receipts (organization_id, submitted_by_membership_id, vendor, amount_cents, purchased_on, category)
       VALUES ($1, '00000000-0000-4b00-8000-00000000a003', 'x', -1, '2026-11-01', 'fuel')`, [ORG_A]))).toBe("23514");
    expect(await inTx(() => admin.query(
      `INSERT INTO receipts (organization_id, submitted_by_membership_id, vendor, amount_cents, currency, purchased_on, category)
       VALUES ($1, '00000000-0000-4b00-8000-00000000a003', 'x', 1, 'usd', '2026-11-01', 'fuel')`, [ORG_A]))).toBe("23514");
    expect(await inTx(() => admin.query("INSERT INTO vehicles (organization_id, unit_number, make, model, vin) VALUES ($1, 'Z1', 'a', 'b', 'BADVIN')", [ORG_A]))).toBe("23514");
  });

  it("organization_id cannot be changed after creation", async () => {
    expect(await inTx(() => admin.query("UPDATE vehicles SET organization_id = $1 WHERE id = $2", [ORG_B, F.vehicles[0].id]))).toMatch(/23514|23503/);
  });
});

describe("catalogs stay in sync with code", () => {
  it("permission catalog matches packages/contracts", async () => {
    const { rows } = await admin.query("SELECT key FROM permissions ORDER BY key");
    expect(rows.map((r) => r.key)).toEqual([...PERMISSIONS].sort());
  });

  it("dev login users match the seed fixtures", () => {
    const seeded = new Set(F.users.map((u) => u.subject));
    for (const u of DEV_LOGIN_USERS) expect(seeded.has(u.subject)).toBe(true);
  });

  it("re-running migrations is a no-op and edited migrations are refused", async () => {
    const { migrate } = await import("@rsb/db");
    expect(await migrate(admin)).toEqual([]);
    await admin.query("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = '0001'");
    await expect(migrate(admin)).rejects.toThrow(/modified after being applied/);
    const { loadMigrations } = await import("@rsb/db");
    const first = (await loadMigrations())[0]!;
    await admin.query("UPDATE schema_migrations SET checksum = $1 WHERE version = '0001'", [first.checksum]);
  });
});
