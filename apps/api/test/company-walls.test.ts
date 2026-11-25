import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * "Company walls": one company can never read or change another company's data.
 *
 * Two independent sweeps, so a gap in one layer is caught by the other:
 *  1. DATABASE: every table that holds company data has row-level security switched on and forced, and the
 *     app's own database login, working as company B, cannot see or change a single company A row.
 *  2. API: company B's OWNER (who holds every permission) calls EVERY route with company A's ids, both in
 *     company A's address and smuggled into company B's address. Nothing may succeed, no list may contain
 *     company A data, and a fingerprint of all of company A's rows must be identical before and after.
 */
let t: TestApp;
const A = `/v1/orgs/${ORG_A}`;
const B = `/v1/orgs/${ORG_B}`;
const ids: Record<string, string> = {};

/** Tables whose rows are not company data, or that are written by the denials themselves. */
const NOT_COMPANY_DATA = new Set(["users", "permissions", "schema_migrations"]);
const CHANGES_ON_DENIAL = new Set(["audit_events", "idempotency_keys"]);

async function tenantTables(): Promise<string[]> {
  const admin = await adminClient();
  try {
    const { rows } = await admin.query<{ t: string }>(
      `SELECT c.table_name AS t FROM information_schema.columns c
         JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' ORDER BY 1`,
    );
    return rows.map((r) => r.t);
  } finally {
    await admin.end();
  }
}

/** A hash of every company A row in every company table (plus company A itself). */
async function fingerprintA(): Promise<Record<string, string>> {
  const admin = await adminClient();
  try {
    const out: Record<string, string> = {};
    for (const table of await tenantTables()) {
      if (CHANGES_ON_DENIAL.has(table)) continue;
      const { rows } = await admin.query<{ h: string | null }>(
        `SELECT md5(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text)) AS h FROM ${table} x WHERE organization_id = $1`,
        [ORG_A],
      );
      out[table] = rows[0]?.h ?? "";
    }
    const { rows } = await admin.query<{ h: string }>("SELECT md5(to_jsonb(o)::text) AS h FROM organizations o WHERE id = $1", [ORG_A]);
    out.organizations = rows[0]!.h;
    return out;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  t = await createTestApp({ PHASE2_FEATURES: "true" });
  const admin = await adminClient();
  try {
    const one = async (sql: string, params: unknown[] = []) => ((await admin.query<{ id: string }>(sql, params)).rows[0]?.id ?? "");
    ids.job = F.jobs[0]!.id;
    ids.photo = F.photos[0]!.id;
    ids.flag = F.photoFlags[0]!.id;
    ids.receipt = F.receipts[0]!.id;
    ids.vehicle = F.vehicles[0]!.id;
    ids.membership = "00000000-0000-4b00-8000-00000000a003";
    ids.role = await one("SELECT id FROM roles WHERE organization_id = $1 AND key = 'employee'", [ORG_A]);
    ids.ownerRole = await one("SELECT id FROM roles WHERE organization_id = $1 AND key = 'owner'", [ORG_A]);
    ids.customer = await one("SELECT id FROM customers WHERE organization_id = $1 LIMIT 1", [ORG_A]);
    ids.rileyUser = await one("SELECT id FROM users WHERE idp_subject = 'dev-riley-owner'");
  } finally {
    await admin.end();
  }
  const inv = await t.as("dev-avery-owner").post(`${A}/team/invites`, { email: "walls.test@example.com", displayName: "Walls Test", roleIds: [ids.role] });
  ids.invite = inv.body.id;
  // A deleted photo in A, so restore/purge have something real to aim at.
  const p = await t.as("dev-eli-employee").post(`${A}/jobs/${ids.job}/photos`, {
    clientRef: uuid(), stage: "before", capturedAt: "2026-11-10T15:30:00Z", contentType: "image/jpeg",
  });
  ids.deletedPhoto = p.body.id;
  expect((await t.as("dev-avery-owner").del(`${A}/photos/${ids.deletedPhoto}`)).status).toBe(204);
});
afterAll(async () => {
  await t.as("dev-avery-owner").del(`${A}/team/invites/${ids.invite}`);
  // The sweep is allowed to change company B's OWN data; put it back for later test files.
  await t.as("dev-riley-owner").patch(`${B}/settings`, { signInEveryDays: 30 });
  const extra = (await t.as("dev-riley-owner").get(`${B}/team/roles`)).body.items.filter((r: { name: string }) => r.name === "Wall test role");
  for (const r of extra) await t.as("dev-riley-owner").del(`${B}/team/roles/${r.id}`);
  await t.close();
});

describe("company walls: database layer", () => {
  it("every table holding company data has row-level security switched on and forced", async () => {
    const tables = await tenantTables();
    expect(tables.length).toBeGreaterThan(10);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query<{ relname: string; on: boolean; forced: boolean; policies: number }>(
        `SELECT c.relname, c.relrowsecurity AS on, c.relforcerowsecurity AS forced,
                (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = ANY ($1)`,
        [[...tables, "organizations"]],
      );
      const weak = rows.filter((r) => !r.on || !r.forced || r.policies === 0).map((r) => r.relname);
      expect(weak).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("the app's own database login, working as company B, sees and changes nothing of company A", async () => {
    const tables = (await tenantTables()).filter((x) => !NOT_COMPANY_DATA.has(x));
    const before = await fingerprintA();
    const c = await appRoleClient();
    try {
      for (const table of tables) {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [ids.rileyUser, ORG_B]);
        const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE organization_id <> $1`, [ORG_B]).catch(() => ({ rows: [{ n: 0 }] }));
        expect({ table, visible: rows[0]!.n }).toEqual({ table, visible: 0 });
        // Try to change and delete company A rows. Either the login lacks the right (error) or no row matches.
        await c.query("SAVEPOINT s");
        const upd = await c.query(`UPDATE ${table} SET organization_id = organization_id WHERE organization_id = $1`, [ORG_A]).catch(() => null);
        expect({ table, updated: upd?.rowCount ?? 0 }).toEqual({ table, updated: 0 });
        await c.query("ROLLBACK TO SAVEPOINT s");
        const del = await c.query(`DELETE FROM ${table} WHERE organization_id = $1`, [ORG_A]).catch(() => null);
        expect({ table, deleted: del?.rowCount ?? 0 }).toEqual({ table, deleted: 0 });
        await c.query("ROLLBACK");
      }
      // Company A itself is invisible too.
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.current_user_id', $1, true), set_config('app.current_org_id', $2, true)", [ids.rileyUser, ORG_B]);
      expect((await c.query("SELECT 1 FROM organizations WHERE id = $1", [ORG_A])).rowCount).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      await c.end();
    }
    expect(await fingerprintA()).toEqual(before);
  });
});

describe("company walls: every API route", () => {
  type Call = { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string; body?: unknown };
  /** Every company route, with company A's record ids. `{org}` is filled in with A or B. */
  const routes = (): Call[] => [
    { method: "GET", path: "{org}" },
    { method: "GET", path: "{org}/dashboard" },
    { method: "GET", path: "{org}/audit-events" },
    { method: "GET", path: "{org}/jobs" },
    { method: "POST", path: "{org}/jobs", body: { jobNumber: `W-${Date.now() % 100000}`, title: "Wall test", customerId: ids.customer } },
    { method: "GET", path: `{org}/jobs/${ids.job}` },
    { method: "PATCH", path: `{org}/jobs/${ids.job}`, body: { title: "Changed by another company" } },
    { method: "POST", path: `{org}/jobs/${ids.job}/assignments`, body: { membershipId: ids.membership } },
    { method: "GET", path: `{org}/jobs/${ids.job}/photos` },
    { method: "POST", path: `{org}/jobs/${ids.job}/photos`, body: { clientRef: uuid(), stage: "before", capturedAt: "2026-11-10T15:30:00Z", contentType: "image/jpeg" } },
    { method: "GET", path: `{org}/jobs/${ids.job}/photos/deleted` },
    { method: "GET", path: "{org}/members" },
    { method: "GET", path: "{org}/photo-flags" },
    { method: "POST", path: `{org}/photo-flags/${ids.flag}/resolve`, body: { resolutionNote: "x" } },
    { method: "GET", path: "{org}/photos" },
    { method: "GET", path: `{org}/photos/${ids.photo}` },
    { method: "PATCH", path: `{org}/photos/${ids.photo}`, body: { flagged: true, note: "changed by another company" } },
    { method: "DELETE", path: `{org}/photos/${ids.photo}` },
    { method: "GET", path: `{org}/photos/${ids.photo}/content` },
    { method: "GET", path: `{org}/photos/${ids.photo}/content?variant=original` },
    { method: "PUT", path: `{org}/photos/${ids.photo}/content` },
    { method: "POST", path: `{org}/photos/${ids.photo}/flags`, body: { reason: "x" } },
    { method: "POST", path: `{org}/photos/${ids.deletedPhoto}/restore`, body: {} },
    { method: "POST", path: "{org}/photos/purge", body: { photoIds: [ids.deletedPhoto] } },
    { method: "POST", path: "{org}/photos/exports", body: { photoIds: [ids.photo], channel: "download" } },
    { method: "GET", path: "{org}/receipts" },
    { method: "POST", path: "{org}/receipts", body: { clientRef: uuid(), jobId: ids.job, vendor: "x", amountCents: 1, purchasedOn: "2026-11-01", category: "other" } },
    { method: "GET", path: "{org}/settings" },
    { method: "PATCH", path: "{org}/settings", body: { signInEveryDays: 1 } },
    { method: "GET", path: "{org}/team/invites" },
    { method: "POST", path: "{org}/team/invites", body: { email: "x.walls@example.com", displayName: "X", roleIds: [ids.role] } },
    { method: "DELETE", path: `{org}/team/invites/${ids.invite}` },
    { method: "GET", path: "{org}/team/members" },
    { method: "PATCH", path: `{org}/team/members/${ids.membership}`, body: { roleIds: [ids.ownerRole] } },
    { method: "PATCH", path: `{org}/team/members/${ids.membership}/status`, body: { status: "removed" } },
    { method: "GET", path: "{org}/team/permissions" },
    { method: "GET", path: "{org}/team/roles" },
    { method: "POST", path: "{org}/team/roles", body: { name: "Wall test role", permissions: ["org.read"] } },
    { method: "PATCH", path: `{org}/team/roles/${ids.role}`, body: { name: "Changed by another company", permissions: ["org.read"] } },
    { method: "DELETE", path: `{org}/team/roles/${ids.role}` },
    { method: "GET", path: "{org}/vehicles" },
    { method: "GET", path: `{org}/vehicles/${ids.vehicle}` },
    { method: "POST", path: `{org}/vehicles/${ids.vehicle}/mileage`, body: { clientRef: uuid(), tripDate: "2026-11-01", odometerStart: 1, odometerEnd: 2 } },
    { method: "POST", path: `{org}/vehicles/${ids.vehicle}/maintenance`, body: { clientRef: uuid(), kind: "issue", description: "x" } },
  ];

  /** Strings that would only appear in a response if company A data leaked. */
  const secretsOfA = () => [ORG_A, ...Object.entries(ids).filter(([k]) => k !== "rileyUser").map(([, v]) => v), "harborpine", "Harbor Pine", "HP-1002", "Canopy"];

  async function call(c: Call, org: string) {
    const url = c.path.replace("{org}", org);
    const token = await t.devAuth.issue("dev-riley-owner");
    const res = await t.app.inject({
      method: c.method,
      url,
      headers: { authorization: `Bearer ${token}`, ...(c.method === "PUT" ? { "content-type": "image/jpeg" } : {}), "idempotency-key": uuid() },
      ...(c.method === "PUT" ? { payload: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) } : c.body !== undefined ? { payload: c.body as object } : {}),
    });
    return { url, status: res.statusCode, body: res.body };
  }

  it("company B's owner, aiming at company A's address, gets 'not found' everywhere and changes nothing", async () => {
    const before = await fingerprintA();
    const results = [];
    for (const r of routes()) results.push(await call(r, A));
    const wrong = results.filter((r) => r.status !== 404).map((r) => `${r.status} ${r.url}`);
    expect(wrong).toEqual([]);
    for (const r of results) for (const s of secretsOfA().filter((x) => x !== ORG_A)) expect({ url: r.url, leaked: r.body.includes(s) ? s : null }).toEqual({ url: r.url, leaked: null });
    expect(await fingerprintA()).toEqual(before);
  });

  it("company B's owner, using company A's record ids inside company B's own address, can't touch them or see them", async () => {
    const before = await fingerprintA();
    const results = [];
    for (const r of routes()) results.push({ ...(await call(r, B)), hasIdOfA: r.path.includes("/") && r.path !== "{org}" && Object.values(ids).some((v) => r.path.includes(v) || JSON.stringify(r.body ?? {}).includes(v)) });
    // Anything that names a company A record must be refused (not found, or rejected as invalid).
    const accepted = results.filter((r) => r.hasIdOfA && r.status < 400).map((r) => `${r.status} ${r.url}`);
    expect(accepted).toEqual([]);
    // No answer, refused or not, may contain company A data.
    const leaks = results.flatMap((r) => secretsOfA().filter((s) => r.body.includes(s)).map((s) => `${r.url} -> ${s}`));
    expect(leaks).toEqual([]);
    expect(await fingerprintA()).toEqual(before);
  });
});
