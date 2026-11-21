import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Deliberate attempts by users of one organization to read or write another
 * organization's records. Every attempt must fail without revealing whether
 * the target exists.
 */
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const jobA = F.jobs[0].id; // HP-1001, org A
const jobB = F.jobs[3].id; // RS-2001, org B
const photoB = F.photos[3].id;
const vehicleB = F.vehicles[2].id;
const customerB = F.customers[2]!.id;
const blakeMembershipB = "00000000-0000-4b00-8000-00000000b002";

describe("cross-organization reads", () => {
  it("an owner of A cannot open organization B at all", async () => {
    const r = await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_B}`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });

  it.each([
    "jobs", `jobs/${jobB}`, `jobs/${jobB}/photos`, "receipts", "vehicles", `vehicles/${vehicleB}`, "members",
    "audit-events", "dashboard", "photo-flags",
  ])("owner of A gets 404 for B's /%s", async (path) => {
    const r = await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_B}/${path}`);
    expect(r.status).toBe(404);
  });

  it("probing another org returns the same response as a non-existent org", async () => {
    const real = await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_B}/jobs`);
    const fake = await t.as("dev-avery-owner").get(`/v1/orgs/${uuid()}/jobs`);
    expect(real.status).toBe(fake.status);
    expect(real.body.error.code).toBe(fake.body.error.code);
    expect(real.body.error.message).toBe(fake.body.error.message);
  });

  it("using A's org in the URL with B's record ID does not leak B's record", async () => {
    expect((await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/jobs/${jobB}`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/jobs/${jobB}/photos`)).status).toBe(404);
    expect((await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/vehicles/${vehicleB}`)).status).toBe(404);
  });

  it("list endpoints contain only the caller's organization data", async () => {
    const jobs = await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/jobs`);
    const ids = jobs.body.items.map((j: { id: string }) => j.id);
    expect(ids).toContain(jobA);
    expect(ids).not.toContain(jobB);
    expect(ids).not.toContain(F.jobs[4].id); // org B's job that reuses number HP-1001
    const receipts = await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/receipts`);
    expect(receipts.body.items.map((r: { id: string }) => r.id)).not.toContain(F.receipts[2].id);
  });

  it("the same job number in two organizations resolves to each org's own job", async () => {
    const a = await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/jobs`);
    const b = await t.as("dev-riley-owner").get(`/v1/orgs/${ORG_B}/jobs`);
    const aJob = a.body.items.find((j: { jobNumber: string }) => j.jobNumber === "HP-1001");
    const bJob = b.body.items.find((j: { jobNumber: string }) => j.jobNumber === "HP-1001");
    expect(aJob.id).not.toBe(bJob.id);
  });
});

describe("cross-organization writes", () => {
  it("cannot create a job in B by targeting B's URL", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_B}/jobs`, { jobNumber: "X-1", title: "intrusion" });
    expect(r.status).toBe(404);
  });

  it("cannot smuggle organizationId in the request body", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/jobs`, {
      jobNumber: "X-2", title: "smuggle", organizationId: ORG_B,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_failed");
  });

  it("cannot attach B's customer to A's job (composite foreign key)", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/jobs`, {
      jobNumber: "X-3", title: "cross customer", customerId: customerB,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_failed");
  });

  it("cannot assign a member of B to a job in A", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/jobs/${jobA}/assignments`, { membershipId: blakeMembershipB });
    expect(r.status).toBe(400);
  });

  it("cannot submit a receipt in A against B's job", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/receipts`, {
      clientRef: uuid(), jobId: jobB, vendor: "x", amountCents: 100, purchasedOn: "2026-11-05", category: "other",
    });
    expect(r.status).toBe(404);
  });

  it("cannot flag B's photo through A", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/photos/${photoB}/flags`, { reason: "probe" });
    expect(r.status).toBe(404);
  });

  it("cannot log mileage on B's vehicle through A", async () => {
    const r = await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/vehicles/${vehicleB}/mileage`, {
      clientRef: uuid(), tripDate: "2026-11-05", odometerStart: 1, odometerEnd: 2,
    });
    expect(r.status).toBe(404);
  });

  it("an idempotency key from another organization cannot be used to read its record", async () => {
    const ref = uuid();
    const mine = await t.as("dev-blake-employee").post(`/v1/orgs/${ORG_B}/receipts`, {
      clientRef: ref, vendor: "B vendor", amountCents: 500, purchasedOn: "2026-11-05", category: "other",
    });
    expect(mine.status).toBe(201);
    const replay = await t.as("dev-eli-employee").post(`/v1/orgs/${ORG_A}/receipts`, {
      clientRef: ref, vendor: "A vendor", amountCents: 1, purchasedOn: "2026-11-05", category: "other",
    });
    // Unique per organization, so this simply creates A's own receipt.
    expect(replay.status).toBe(201);
    expect(replay.body.vendor).toBe("A vendor");
    expect(replay.body.id).not.toBe(mine.body.id);
  });
});

describe("a person in two organizations", () => {
  it("is a manager in B but only an employee in A", async () => {
    const a = await t.as("dev-casey-both").get(`/v1/orgs/${ORG_A}`);
    const b = await t.as("dev-casey-both").get(`/v1/orgs/${ORG_B}`);
    expect(a.body.roles).toEqual(["employee"]);
    expect(b.body.roles).toEqual(["manager"]);
  });

  it("manager rights in B do not apply in A", async () => {
    expect((await t.as("dev-casey-both").post(`/v1/orgs/${ORG_B}/jobs`, { jobNumber: "RS-9001", title: "ok in B" })).status).toBe(201);
    const inA = await t.as("dev-casey-both").post(`/v1/orgs/${ORG_A}/jobs`, { jobNumber: "HP-9001", title: "not in A" });
    expect(inA.status).toBe(403);
    expect((await t.as("dev-casey-both").get(`/v1/orgs/${ORG_A}/members`)).status).toBe(403);
  });

  it("sees only A jobs assigned to them in A, but all jobs in B", async () => {
    const a = await t.as("dev-casey-both").get(`/v1/orgs/${ORG_A}/jobs`);
    expect(a.body.items.map((j: { jobNumber: string }) => j.jobNumber)).toEqual(["HP-1001"]);
    const b = await t.as("dev-casey-both").get(`/v1/orgs/${ORG_B}/jobs`);
    expect(b.body.items.length).toBeGreaterThanOrEqual(2);
  });
});

describe("denials are audited", () => {
  it("records an audit event when a user probes another organization", async () => {
    await t.as("dev-eli-employee").get(`/v1/orgs/${ORG_B}/jobs`);
    const { rows } = await t.db.pool.query(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.org_access_denied'",
    ).catch(() => ({ rows: [{ n: -1 }] }));
    // The runtime role cannot read org-less audit rows (RLS); verify via the owner instead.
    expect(rows[0]!.n).toBe(0);
    const { adminClient } = await import("./helpers.js");
    const admin = await adminClient();
    const res = await admin.query("SELECT count(*)::int AS n FROM audit_events WHERE action = 'authz.org_access_denied' AND organization_id IS NULL");
    expect(res.rows[0].n).toBeGreaterThan(0);
    await admin.end();
  });
});
