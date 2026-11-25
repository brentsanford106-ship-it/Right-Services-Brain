import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, F, ORG_A, uuid, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });
const base = `/v1/orgs/${ORG_A}`;

describe("health", () => {
  it("live and ready respond without authentication", async () => {
    expect((await t.app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await t.app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
  });
});

describe("input validation", () => {
  const owner = () => t.as("dev-avery-owner");

  it("rejects non-UUID identifiers", async () => {
    const r = await owner().get(`/v1/orgs/not-a-uuid/jobs`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_failed");
  });

  it("rejects SQL-injection-shaped input as plain invalid data", async () => {
    const r = await owner().get(`/v1/orgs/${ORG_A}' OR '1'='1/jobs`);
    expect(r.status).toBe(400);
    const j = await owner().post(`${base}/jobs`, { jobNumber: "1'; DROP TABLE jobs;--", title: "x" });
    expect(j.status).toBe(400);
    // Values are stored verbatim (parameterized), never executed.
    const ok = await owner().post(`${base}/jobs`, { jobNumber: "SQL-1", title: "Robert'); DROP TABLE jobs;--" });
    expect(ok.status).toBe(201);
    expect(ok.body.title).toBe("Robert'); DROP TABLE jobs;--");
  });

  it("rejects unknown fields, wrong types, and out-of-range values", async () => {
    const cases: [unknown, string][] = [
      [{ clientRef: uuid(), vendor: "x", amountCents: -5, purchasedOn: "2026-11-05", category: "fuel" }, "amountCents"],
      [{ clientRef: uuid(), vendor: "x", amountCents: 1.5, purchasedOn: "2026-11-05", category: "fuel" }, "amountCents"],
      [{ clientRef: uuid(), vendor: "x", amountCents: "100", purchasedOn: "2026-11-05", category: "fuel" }, "amountCents"],
      [{ clientRef: uuid(), vendor: "x", amountCents: 1, currency: "usd", purchasedOn: "2026-11-05", category: "fuel" }, "currency"],
      [{ clientRef: uuid(), vendor: "x", amountCents: 1, purchasedOn: "11/05/2026", category: "fuel" }, "purchasedOn"],
      [{ clientRef: uuid(), vendor: "x", amountCents: 1, purchasedOn: "2026-11-05", category: "bribes" }, "category"],
      [{ clientRef: uuid(), vendor: "x".repeat(201), amountCents: 1, purchasedOn: "2026-11-05", category: "fuel" }, "vendor"],
      [{ clientRef: "abc", vendor: "x", amountCents: 1, purchasedOn: "2026-11-05", category: "fuel" }, "clientRef"],
    ];
    for (const [body, field] of cases) {
      const r = await owner().post(`${base}/receipts`, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.details.map((d: { path: string }) => d.path)).toContain(field);
    }
  });

  it("validation errors never echo submitted values", async () => {
    const r = await owner().post(`${base}/receipts`, { clientRef: uuid(), vendor: "SECRET-VALUE-123", amountCents: -1, purchasedOn: "2026-11-05", category: "fuel" });
    expect(JSON.stringify(r.body)).not.toContain("SECRET-VALUE-123");
  });

  it("rejects mileage with end before start", async () => {
    const r = await t.as("dev-eli-employee").post(`${base}/vehicles/${F.vehicles[0].id}/mileage`, {
      clientRef: uuid(), tripDate: "2026-11-05", odometerStart: 500, odometerEnd: 100,
    });
    expect(r.status).toBe(400);
  });

  it("rejects oversized and non-JSON bodies", async () => {
    const tok = await t.token("dev-avery-owner");
    const big = await t.app.inject({ method: "POST", url: `${base}/jobs`, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, payload: JSON.stringify({ title: "x".repeat(70_000) }) });
    expect(big.statusCode).toBe(413);
    const text = await t.app.inject({ method: "POST", url: `${base}/jobs`, headers: { authorization: `Bearer ${tok}`, "content-type": "text/plain" }, payload: "hello" });
    expect(text.statusCode).toBe(400);
    const broken = await t.app.inject({ method: "POST", url: `${base}/jobs`, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, payload: "{not json" });
    expect(broken.statusCode).toBe(400);
  });

  it("duplicate job number returns 409 conflict", async () => {
    const r = await t.as("dev-avery-owner").post(`${base}/jobs`, { jobNumber: "HP-1001", title: "dup" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
  });
});

describe("error format and headers", () => {
  it("unknown routes use the standard error shape", async () => {
    const r = await t.app.inject({ method: "GET", url: "/nope" });
    const body = JSON.parse(r.body);
    expect(r.statusCode).toBe(404);
    expect(body.error).toEqual({ code: "not_found", message: "Not found.", requestId: expect.any(String) });
  });

  it("every response carries a server-generated request id, no-store, and security headers", async () => {
    const r = await t.app.inject({ method: "GET", url: "/health/live", headers: { "x-request-id": "attacker-chosen" } });
    expect(r.headers["x-request-id"]).not.toBe("attacker-chosen");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("CORS allows only configured origins", async () => {
    const ok = await t.app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "http://localhost:5173", "access-control-request-method": "GET" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const bad = await t.app.inject({ method: "OPTIONS", url: "/v1/me", headers: { origin: "https://evil.example.com", "access-control-request-method": "GET" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("logging hygiene", () => {
  it("never writes bearer tokens, query strings, or request bodies to logs", async () => {
    const tok = await t.token("dev-avery-owner");
    await t.app.inject({ method: "POST", url: `${base}/receipts?email=pat@fuelmart.example.com`, headers: { authorization: `Bearer ${tok}` },
      payload: { clientRef: uuid(), vendor: "LOGLEAK-VENDOR", amountCents: 1, purchasedOn: "2026-11-05", category: "fuel" } });
    await t.app.inject({ method: "POST", url: `${base}/jobs`, headers: { authorization: `Bearer ${tok}` }, payload: { jobNumber: "HP-1001", title: "LOGLEAK-TITLE" } });
    const all = t.logs.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(tok);
    expect(all).not.toContain(tok.split(".")[1]!);
    expect(all).not.toContain("pat@fuelmart");
    expect(all).not.toContain("LOGLEAK");
  });
});

describe("rate limiting", () => {
  it("returns 429 with the standard error shape when the limit is exceeded", async () => {
    const limited = await createTestApp({ RATE_LIMIT_PER_MINUTE: "3" });
    let last = 0;
    let body: { error?: { code: string } } = {};
    for (let i = 0; i < 5; i++) {
      const r = await limited.app.inject({ method: "GET", url: "/v1/me" });
      last = r.statusCode;
      body = JSON.parse(r.body);
    }
    expect(last).toBe(429);
    expect(body.error?.code).toBe("rate_limited");
    await limited.close();
  });
});

describe("basic functionality", () => {
  it("owner sees synthetic data on dashboard, jobs, vehicles and members", async () => {
    const owner = t.as("dev-avery-owner");
    const org = await owner.get(base);
    expect(org.body.organization.name).toContain("DEMO");
    expect((await owner.get(`${base}/dashboard`)).body.activeJobs).toBeGreaterThanOrEqual(1);
    const job = await owner.get(`${base}/jobs/${F.jobs[0].id}`);
    expect(job.body.customerName).toBe("Demo Fuel Mart #12");
    expect(job.body.assignees.length).toBe(2);
    const photos = await owner.get(`${base}/jobs/${F.jobs[0].id}/photos`);
    expect(photos.body.items.length).toBeGreaterThanOrEqual(2);
    const vehicle = await owner.get(`${base}/vehicles/${F.vehicles[0].id}`);
    expect(vehicle.body.mileage.length).toBeGreaterThanOrEqual(1);
    const members = await owner.get(`${base}/members`);
    expect(members.body.items.length).toBeGreaterThanOrEqual(6);
  });
});
