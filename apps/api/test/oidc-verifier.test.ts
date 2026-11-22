import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { OidcVerifier } from "../src/auth/oidc.js";
import { adminClient, createTestApp, ORG_A, type TestApp } from "./helpers.js";

/**
 * The REAL production token checker (OidcVerifier), tested against a stand-in identity provider running on
 * this computer: it publishes its public key exactly like Microsoft does (a JWKS address) and signs tokens.
 */
const ISSUER = "https://local-test-idp.example.com/tenant/v2.0";
const AUDIENCE = "api-client-id-for-tests";
let server: Server;
let jwksUri: string;
type Key = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let key: Key;
let otherKey: Key;
let verifier: OidcVerifier;
let t: TestApp;

async function token(claims: Record<string, unknown>, opts: { key?: Key; iss?: string; aud?: string; exp?: string | number; alg?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject(String(claims.sub ?? "sub-oidc-1"))
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "10m")
    .sign(opts.key ?? key);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  jwksUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/keys`;
  verifier = new OidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri });
  t = await createTestApp({}, { extraVerifiers: [verifier] });
});
afterAll(async () => {
  const admin = await adminClient();
  try {
    await admin.query("UPDATE member_invites SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL");
    await admin.query("UPDATE organization_memberships m SET status = 'removed' FROM users u WHERE u.id = m.user_id AND u.idp_issuer = $1", [ISSUER]);
  } finally {
    await admin.end();
  }
  await t.close();
  await new Promise((r) => server.close(r));
});

describe("production token checker", () => {
  it("accepts a correctly signed token and reads who it is, their email and name", async () => {
    const id = await verifier.verify(await token({ sub: "sub-oidc-1", email: " Pat@Example.com ", name: "Pat" }));
    expect(id).toEqual({ issuer: ISSUER, subject: "sub-oidc-1", email: "Pat@Example.com", name: "Pat" });
  });

  it("company walls: an email the provider marks as NOT verified is never used to join a company", async () => {
    const id = await verifier.verify(await token({ sub: "sub-oidc-unverified", email: "someone@example.com", email_verified: false }));
    expect(id).toEqual({ issuer: ISSUER, subject: "sub-oidc-unverified" });
    const ok = await verifier.verify(await token({ sub: "sub-oidc-verified", email: "someone@example.com", email_verified: true }));
    expect(ok?.email).toBe("someone@example.com");
  });

  it("rejects tokens signed by someone else, for another app, from another issuer, expired, or unsigned", async () => {
    expect(await verifier.verify(await token({}, { key: otherKey }))).toBeNull();
    expect(await verifier.verify(await token({}, { aud: "some-other-api" }))).toBeNull();
    expect(await verifier.verify(await token({}, { iss: "https://evil.example.com/v2.0" }))).toBeNull();
    expect(await verifier.verify(await token({}, { exp: Math.floor(Date.now() / 1000) - 600 }))).toBeNull();
    const unsigned = (await token({})).split(".").slice(0, 2).join(".") + ".";
    expect(await verifier.verify(unsigned)).toBeNull();
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ sub: "x", iss: ISSUER, aud: AUDIENCE, exp: 9999999999, iat: 1 })).toString("base64url")}.`;
    expect(await verifier.verify(none)).toBeNull();
    expect(await verifier.verify("not-a-token")).toBeNull();
  });

  it("treats an unreachable key list as a temporary error, never as 'not signed in'", async () => {
    const down = new OidcVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUri: "http://127.0.0.1:1/keys" });
    await expect(down.verify(await token({}))).rejects.toMatchObject({ status: 500 });
  });

  it("end to end: owner adds an email, a real-format token with that email gets in; a forged one doesn't", async () => {
    const roles = (await t.as("dev-avery-owner").get(`/v1/orgs/${ORG_A}/team/roles`)).body.items as { key: string; id: string }[];
    const employee = roles.find((r) => r.key === "employee")!.id;
    expect((await t.as("dev-avery-owner").post(`/v1/orgs/${ORG_A}/team/invites`, { email: "oidc.person@example.com", displayName: "Oidc Person", roleIds: [employee] })).status).toBe(201);

    const forged = await token({ sub: "sub-oidc-2", email: "oidc.person@example.com" }, { key: otherKey });
    const bad = await t.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${forged}` } });
    expect(bad.statusCode).toBe(401);

    const good = await token({ sub: "sub-oidc-2", email: "oidc.person@example.com", name: "Oidc P." });
    const me = await t.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${good}` } });
    expect(me.statusCode).toBe(200);
    expect(JSON.parse(me.body).memberships.map((m: { organizationId: string }) => m.organizationId)).toEqual([ORG_A]);
  });
});
