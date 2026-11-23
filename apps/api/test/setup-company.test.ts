import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOwners, setupCompany } from "@rsb/db";
import { adminClient, createTestApp, ORG_A, type TestApp } from "./helpers.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/types.js";

/** Creating the real company and its first owners, who then get in by signing in with Microsoft. */
const ISSUER = "https://setup-test.ciamlogin.example.com/tenant/v2.0";
const ids = new Map<string, VerifiedIdentity>();
class FakeOidc implements TokenVerifier {
  async verify(token: string) {
    return ids.get(token) ?? null;
  }
}
const signIn = (key: string, email: string) => {
  ids.set(`tok.${key}.sig`, { issuer: ISSUER, subject: `sub-${key}`, email, name: key });
  return `tok.${key}.sig`;
};

let t: TestApp;
let orgId = "";
beforeAll(async () => {
  t = await createTestApp({}, { extraVerifiers: [new FakeOidc()] });
});
afterAll(async () => {
  const admin = await adminClient();
  try {
    await admin.query("UPDATE member_invites SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL");
  } finally {
    await admin.end();
  }
  await t.close();
});

describe("setting up a real company", () => {
  it("reads --owner arguments", () => {
    expect(parseOwners(["x", "--owner", "a@b.co:Nate S", "--name", "Co", "--owner", "jb@b.co:JB"])).toEqual([
      { email: "a@b.co", displayName: "Nate S" },
      { email: "jb@b.co", displayName: "JB" },
    ]);
  });

  it("creates the company with the standard roles, and its owners get in at first sign-in", async () => {
    const admin = await adminClient();
    try {
      await expect(setupCompany(admin, "Test Setup Co", [{ email: "bad", displayName: "X" }])).rejects.toThrow(/valid email/);
      const r = await setupCompany(admin, "Test Setup Co", [
        { email: "Owner.One@Example.com", displayName: "Owner One" },
        { email: "owner.two@example.com", displayName: "Owner Two" },
      ]);
      expect(r.created).toBe(true);
      expect(r.invited).toEqual(["owner.one@example.com", "owner.two@example.com"]);
      orgId = r.orgId;
      // Running it again on purpose (--add-to-existing) changes nothing.
      const again = await setupCompany(admin, "Test Setup Co", [{ email: "owner.one@example.com", displayName: "Owner One" }], { addToExisting: true });
      expect(again).toEqual({ orgId, created: false, invited: [] });
    } finally {
      await admin.end();
    }

    const one = signIn("one", "owner.one@example.com");
    const first = JSON.parse((await t.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${one}` } })).body);
    expect(first.memberships).toEqual([]);
    expect(first.invites.map((i: { organizationName: string }) => i.organizationName)).toEqual(["Test Setup Co"]);
    expect((await t.app.inject({ method: "POST", url: `/v1/invites/${first.invites[0].inviteId}/accept`, headers: { authorization: `Bearer ${one}` } })).statusCode).toBe(200);
    const me = await t.app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${one}` } });
    expect(JSON.parse(me.body).memberships.map((m: { organizationId: string }) => m.organizationId)).toEqual([orgId]);
    const ctx = await t.app.inject({ method: "GET", url: `/v1/orgs/${orgId}`, headers: { authorization: `Bearer ${one}` } });
    expect(JSON.parse(ctx.body).roles).toEqual(["owner"]);
    // The first owner sees the second still waiting, marked as added by company setup.
    const inv = await t.app.inject({ method: "GET", url: `/v1/orgs/${orgId}/team/invites`, headers: { authorization: `Bearer ${one}` } });
    expect(JSON.parse(inv.body).items).toMatchObject([{ email: "owner.two@example.com", invitedBy: "Company setup", roles: [{ name: "Organization Owner" }] }]);
    // ...and can't see the demo company.
    expect((await t.app.inject({ method: "GET", url: `/v1/orgs/${ORG_A}`, headers: { authorization: `Bearer ${one}` } })).statusCode).toBe(404);
  });

  it("company walls: a second company with a matching name is refused, never merged into the first", async () => {
    const admin = await adminClient();
    try {
      const count = async () => (await admin.query("SELECT count(*)::int AS n FROM member_invites")).rows[0].n as number;
      const before = await count();
      // "TEST setup, co." has the same web-address name as "Test Setup Co". Without the flag nothing changes.
      await expect(setupCompany(admin, "TEST setup, co.", [{ email: "stranger@other-company.example", displayName: "Stranger" }]))
        .rejects.toThrow(/already exists.*Nothing was changed/);
      expect(await count()).toBe(before);
      const { rows } = await admin.query("SELECT 1 FROM member_invites WHERE email = 'stranger@other-company.example'");
      expect(rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});
