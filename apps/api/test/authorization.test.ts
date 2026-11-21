import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, F, ORG_A, uuid, type TestApp } from "./helpers.js";

/** Role and record-level authorization inside one organization (Harbor Pine, org A). */
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const [hp1001, hp1002, hp1003] = [F.jobs[0].id, F.jobs[1].id, F.jobs[2].id];
const [truck1, van2] = [F.vehicles[0].id, F.vehicles[1].id];
const base = `/v1/orgs/${ORG_A}`;

describe("employee", () => {
  const eli = () => t.as("dev-eli-employee");

  it("sees only assigned jobs", async () => {
    const r = await eli().get(`${base}/jobs`);
    expect(r.body.items.map((j: { id: string }) => j.id)).toEqual([hp1001]);
  });

  it("gets 404 for an unassigned job in the same company", async () => {
    expect((await eli().get(`${base}/jobs/${hp1002}`)).status).toBe(404);
    expect((await eli().get(`${base}/jobs/${hp1003}/photos`)).status).toBe(404);
  });

  it("cannot see customer names (customers.read not granted)", async () => {
    const r = await eli().get(`${base}/jobs/${hp1001}`);
    expect(r.status).toBe(200);
    expect(r.body.customerName).toBeNull();
    expect(r.body.assignees).toBeNull();
  });

  it("cannot create jobs or assignments", async () => {
    expect((await eli().post(`${base}/jobs`, { jobNumber: "E-1", title: "nope" })).status).toBe(403);
    expect((await eli().post(`${base}/jobs/${hp1001}/assignments`, { membershipId: "00000000-0000-4b00-8000-00000000a003" })).status).toBe(403);
  });

  it("sees only their own receipts", async () => {
    const r = await eli().get(`${base}/receipts`);
    expect(r.body.scope).toBe("own");
    expect(r.body.items.every((x: { submittedBy: string }) => x.submittedBy === "Eli Employee")).toBe(true);
  });

  it("gets a photo-only dashboard with no financial fields, and cannot see members, flags queue, or audit log", async () => {
    const d = await eli().get(`${base}/dashboard`);
    expect(d.status).toBe(200);
    expect(Object.keys(d.body).sort()).toEqual(["activeJobs", "flaggedPhotos", "photosAwaitingUpload", "photosLast7Days"]);
    expect((await eli().get(`${base}/members`)).status).toBe(403);
    expect((await eli().get(`${base}/photo-flags`)).status).toBe(403);
    expect((await eli().get(`${base}/audit-events`)).status).toBe(403);
  });

  it("sees only the assigned vehicle and cannot log mileage on another", async () => {
    const r = await eli().get(`${base}/vehicles`);
    expect(r.body.items.map((v: { id: string }) => v.id)).toEqual([truck1]);
    const other = await eli().post(`${base}/vehicles/${van2}/mileage`, { clientRef: uuid(), tripDate: "2026-11-05", odometerStart: 1, odometerEnd: 5 });
    expect(other.status).toBe(404);
  });

  it("can upload photo metadata, submit receipts and mileage on assigned work", async () => {
    expect((await eli().post(`${base}/jobs/${hp1001}/photos`, {
      clientRef: uuid(), stage: "during", capturedAt: "2026-11-05T14:00:00Z", contentType: "image/jpeg",
    })).status).toBe(201);
    expect((await eli().post(`${base}/receipts`, {
      clientRef: uuid(), jobId: hp1001, vendor: "Demo Hardware", amountCents: 1999, purchasedOn: "2026-11-05", category: "tools",
    })).status).toBe(201);
    expect((await eli().post(`${base}/vehicles/${truck1}/mileage`, {
      clientRef: uuid(), tripDate: "2026-11-05", odometerStart: 48210, odometerEnd: 48250, jobId: hp1001,
    })).status).toBe(201);
    expect((await eli().post(`${base}/vehicles/${truck1}/maintenance`, {
      clientRef: uuid(), kind: "issue", description: "Low tire pressure (synthetic)",
    })).status).toBe(201);
  });

  it("cannot upload photos to an unassigned job", async () => {
    const r = await eli().post(`${base}/jobs/${hp1002}/photos`, {
      clientRef: uuid(), stage: "before", capturedAt: "2026-11-05T14:00:00Z", contentType: "image/jpeg",
    });
    expect(r.status).toBe(404);
  });

  it("cannot resolve photo flags", async () => {
    expect((await eli().post(`${base}/photo-flags/${F.photoFlags[0]!.id}/resolve`, {})).status).toBe(403);
  });
});

describe("manager", () => {
  const morgan = () => t.as("dev-morgan-manager");

  it("sees all jobs and can assign employees", async () => {
    const r = await morgan().get(`${base}/jobs`);
    expect(r.body.items).toHaveLength(r.body.items.length);
    expect(r.body.items.map((j: { id: string }) => j.id)).toEqual(expect.arrayContaining([hp1001, hp1002, hp1003]));
    const a = await morgan().post(`${base}/jobs/${hp1003}/assignments`, { membershipId: "00000000-0000-4b00-8000-00000000a004" });
    expect(a.status).toBe(201);
    // Assignment immediately grants the employee access to that job.
    expect((await t.as("dev-ezra-field").get(`${base}/jobs/${hp1003}`)).status).toBe(200);
  });

  it("cannot assign a suspended member", async () => {
    const r = await morgan().post(`${base}/jobs/${hp1001}/assignments`, { membershipId: "00000000-0000-4b00-8000-00000000a005" });
    expect(r.status).toBe(400);
  });

  it("can view and resolve photo flags", async () => {
    const list = await morgan().get(`${base}/photo-flags`);
    expect(list.status).toBe(200);
    const r = await morgan().post(`${base}/photo-flags/${F.photoFlags[0]!.id}/resolve`, { resolutionNote: "Reviewed" });
    expect(r.status).toBe(200);
    const again = await morgan().post(`${base}/photo-flags/${F.photoFlags[0]!.id}/resolve`, {});
    expect(again.status).toBe(409);
  });

  it("does not see other people's receipts", async () => {
    expect((await morgan().get(`${base}/receipts`)).body.scope).toBe("own");
  });

  it("cannot read the audit log", async () => {
    expect((await morgan().get(`${base}/audit-events`)).status).toBe(403);
  });
});

describe("owner", () => {
  const avery = () => t.as("dev-avery-owner");

  it("sees photo dashboard counts and all receipts", async () => {
    const d = await avery().get(`${base}/dashboard`);
    expect(typeof d.body.flaggedPhotos).toBe("number");
    expect(d.body).not.toHaveProperty("receiptsTotalCents");
    expect((await avery().get(`${base}/receipts`)).body.scope).toBe("all");
  });

  it("can read the audit log, which records actions and denials", async () => {
    await t.as("dev-eli-employee").get(`${base}/members`); // denied -> audited
    const r = await avery().get(`${base}/audit-events?limit=100`);
    expect(r.status).toBe(200);
    const actions = r.body.items.map((e: { action: string }) => e.action);
    expect(actions).toContain("authz.permission_denied");
  });

  it("member list does not expose email addresses", async () => {
    const r = await avery().get(`${base}/members`);
    expect(JSON.stringify(r.body)).not.toContain("@");
  });
});

describe("privilege escalation", () => {
  it("there is no API to change one's own role in Phase 1", async () => {
    const r = await t.as("dev-eli-employee").post(`${base}/members/00000000-0000-4b00-8000-00000000a003/roles`, { role: "owner" });
    expect(r.status).toBe(404);
  });

  it("client-supplied role or permission fields are rejected", async () => {
    const r = await t.as("dev-eli-employee").post(`${base}/receipts`, {
      clientRef: uuid(), vendor: "x", amountCents: 1, purchasedOn: "2026-11-05", category: "other", role: "owner",
    });
    expect(r.status).toBe(400);
  });
});

describe("offline idempotency", () => {
  it("re-sending the same submission returns the original instead of duplicating it", async () => {
    const body = { clientRef: uuid(), vendor: "Retry Supply", amountCents: 1234, purchasedOn: "2026-11-06", category: "materials" };
    const first = await t.as("dev-eli-employee").post(`${base}/receipts`, body);
    const second = await t.as("dev-eli-employee").post(`${base}/receipts`, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("another member reusing someone's submission id gets 409 and learns nothing", async () => {
    const ref = uuid();
    await t.as("dev-eli-employee").post(`${base}/receipts`, { clientRef: ref, vendor: "Mine", amountCents: 1, purchasedOn: "2026-11-06", category: "other" });
    const r = await t.as("dev-ezra-field").post(`${base}/receipts`, { clientRef: ref, vendor: "Theirs", amountCents: 2, purchasedOn: "2026-11-06", category: "other" });
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).not.toContain("Mine");
  });
});
