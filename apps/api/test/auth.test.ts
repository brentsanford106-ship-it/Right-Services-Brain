import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import { DEV_AUTH_AUDIENCE, DEV_AUTH_ISSUER } from "@rsb/contracts";
import { DevAuth } from "../src/auth/dev.js";
import { createTestApp, ORG_A, type TestApp } from "./helpers.js";

let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

async function call(token: string | null, url = "/v1/me") {
  const res = await t.app.inject({ method: "GET", url, headers: token === null ? {} : { authorization: token } });
  return { status: res.statusCode, body: JSON.parse(res.body) };
}

describe("authentication boundaries", () => {
  it("rejects requests with no token", async () => {
    const r = await call(null);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("unauthenticated");
  });

  it("rejects a malformed authorization header", async () => {
    expect((await call("Basic dXNlcjpwYXNz")).status).toBe(401);
    expect((await call("Bearer not-a-jwt")).status).toBe(401);
    expect((await call("Bearer a.b.c")).status).toBe(401);
  });

  it("rejects an unsigned (alg=none) token", async () => {
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const tok = `${enc({ alg: "none", typ: "JWT" })}.${enc({ sub: "dev-avery-owner", iss: DEV_AUTH_ISSUER, aud: DEV_AUTH_AUDIENCE, exp: 9999999999 })}.x`;
    expect((await call(`Bearer ${tok}`)).status).toBe(401);
  });

  it("rejects a token signed with a different key (forged)", async () => {
    const attacker = await DevAuth.create();
    expect((await call(`Bearer ${await attacker.issue("dev-avery-owner")}`)).status).toBe(401);
  });

  it("rejects a correctly signed token with the wrong issuer or audience", async () => {
    // Build a token with the real verifier's algorithm but foreign claims, signed by another key.
    const { privateKey } = await generateKeyPair("ES256");
    const wrongIss = await new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setIssuer("https://evil.example.com")
      .setAudience(DEV_AUTH_AUDIENCE).setSubject("dev-avery-owner").setExpirationTime("5m").sign(privateKey);
    expect((await call(`Bearer ${wrongIss}`)).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    expect((await call(`Bearer ${await t.token("dev-avery-owner", -120)}`)).status).toBe(401);
  });

  it("rejects a valid token for an unknown subject", async () => {
    expect((await call(`Bearer ${await t.token("dev-nobody")}`)).status).toBe(401);
  });

  it("rejects a valid token for a disabled user (offboarding takes effect immediately)", async () => {
    const r = await call(`Bearer ${await t.token("dev-dana-disabled")}`);
    expect(r.status).toBe(401);
  });

  it("accepts a valid token and returns only the caller's own memberships", async () => {
    const r = await call(`Bearer ${await t.token("dev-eli-employee")}`);
    expect(r.status).toBe(200);
    expect(r.body.user.displayName).toBe("Eli Employee");
    expect(r.body.memberships.map((m: { organizationId: string }) => m.organizationId)).toEqual([ORG_A]);
  });

  it("a suspended membership grants nothing", async () => {
    const tok = `Bearer ${await t.token("dev-sam-suspended")}`;
    const me = await call(tok);
    expect(me.status).toBe(200);
    expect(me.body.memberships).toEqual([]);
    expect((await call(tok, `/v1/orgs/${ORG_A}/jobs`)).status).toBe(404);
  });
});

describe("development authentication isolation", () => {
  it("the dev login endpoint does not exist when dev auth is disabled", async () => {
    const off = await createTestApp({ DEV_AUTH_ENABLED: "false" });
    const res = await off.app.inject({ method: "POST", url: "/dev/auth/token", payload: { subject: "dev-avery-owner" } });
    expect(res.statusCode).toBe(404);
    await off.close();
  });

  it("dev tokens are not accepted when dev auth is disabled", async () => {
    const off = await createTestApp({ DEV_AUTH_ENABLED: "false" });
    // off.token() mints a correctly signed dev token, but this app has no dev verifier.
    const res = await off.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${await off.token("dev-avery-owner")}` } });
    expect(res.statusCode).toBe(401);
    await off.close();
  });

  it("dev login issues tokens only for active seeded users", async () => {
    const ok = await t.app.inject({ method: "POST", url: "/dev/auth/token", payload: { subject: "dev-eli-employee" } });
    expect(ok.statusCode).toBe(200);
    const bad = await t.app.inject({ method: "POST", url: "/dev/auth/token", payload: { subject: "dev-dana-disabled" } });
    expect(bad.statusCode).toBe(401);
  });
});
