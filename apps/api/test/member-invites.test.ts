import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, createTestApp, F, ORG_A, ORG_B, type Res, type TestApp } from "./helpers.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/types.js";

/**
 * Adding people by email and linking them on their first REAL sign-in (Entra External ID in production).
 * A stand-in verifier plays the identity provider: it returns a fixed identity (with a verified email) per token.
 */
const ISSUER = "https://example-tenant.ciamlogin.example.com/tenant-id/v2.0";
const identities = new Map<string, VerifiedIdentity>();
class FakeOidc implements TokenVerifier {
  async verify(token: string) {
    return identities.get(token) ?? null;
  }
}
function person(key: string, email: string | undefined, name = "Test Person"): string {
  const token = `fake.${key}.sig`;
  identities.set(token, { issuer: ISSUER, subject: `sub-${key}`, ...(email ? { email } : {}), name });
  return token;
}

let t: TestApp;
const A = `/v1/orgs/${ORG_A}`;
const B = `/v1/orgs/${ORG_B}`;
let roleA: Record<string, string> = {};
let roleB: Record<string, string> = {};

async function call(token: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<Res> {
  const res = await t.app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

beforeAll(async () => {
  t = await createTestApp({}, { extraVerifiers: [new FakeOidc()] });
  roleA = Object.fromEntries((await t.as("dev-avery-owner").get(`${A}/team/roles`)).body.items.map((r: { key: string; id: string }) => [r.key, r.id]));
  roleB = Object.fromEntries((await t.as("dev-riley-owner").get(`${B}/team/roles`)).body.items.map((r: { key: string; id: string }) => [r.key, r.id]));
});
afterAll(async () => {
  const admin = await adminClient();
  try {
    // Leave company A as the seed had it for later test files: new people removed, open invites revoked.
    await admin.query("UPDATE member_invites SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL");
    await admin.query(
      "UPDATE organization_memberships m SET status = 'removed' FROM users u WHERE u.id = m.user_id AND u.idp_issuer = $1",
      [ISSUER],
    );
  } finally {
    await admin.end();
  }
  await t.close();
});

const invite = (subject: string, body: Record<string, unknown>, org = A) => t.as(subject).post(`${org}/team/invites`, body);
/** The person presses Accept on every invite waiting for them. */
async function acceptAll(token: string): Promise<void> {
  const me = await call(token, "GET", "/v1/me");
  expect(me.status).toBe(200);
  for (const i of me.body.invites as { inviteId: string }[]) {
    expect((await call(token, "POST", `/v1/invites/${i.inviteId}/accept`)).status).toBe(200);
  }
}

describe("adding a person and their first sign-in", () => {
  it("owner adds someone by email; their first real sign-in links them to the company with that role", async () => {
    const r = await invite("dev-avery-owner", { email: "New.Tech@Example.com", displayName: "Nia Newtech", jobTitle: "Technician", roleIds: [roleA.employee] });
    expect(r.status).toBe(201);
    const list = await t.as("dev-avery-owner").get(`${A}/team/invites`);
    const open = list.body.items.find((i: { id: string }) => i.id === r.body.id);
    expect(open).toMatchObject({ email: "new.tech@example.com", displayName: "Nia Newtech", roles: [{ name: "Employee" }] });

    const token = person("nia", "new.tech@example.com", "Nia N.");
    // Signing in alone does NOT join: the company is shown as an invite, and nothing of it is reachable yet.
    const before = await call(token, "GET", "/v1/me");
    expect(before.status).toBe(200);
    expect(before.body.memberships).toEqual([]);
    expect(before.body.invites).toEqual([
      expect.objectContaining({ inviteId: r.body.id, organizationId: ORG_A, organizationName: F.organizations[0]!.name, roles: ["Employee"], invitedBy: "Avery Owner" }),
    ]);
    expect((await call(token, "GET", A)).status).toBe(404);
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/accept`)).body).toEqual({ inviteId: r.body.id, outcome: "accepted" });
    const me = await call(token, "GET", "/v1/me");
    expect(me.body.memberships.map((m: { organizationId: string }) => m.organizationId)).toEqual([ORG_A]);
    expect(me.body.invites).toEqual([]);
    // Accepting twice does nothing more.
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(404);
    const ctx = await call(token, "GET", A);
    expect(ctx.body.roles).toEqual(["employee"]);
    expect(ctx.body.permissions).not.toContain("roles.manage");

    // The invite is used up and the person shows in the team list.
    expect((await t.as("dev-avery-owner").get(`${A}/team/invites`)).body.items.some((i: { id: string }) => i.id === r.body.id)).toBe(false);
    const team = await t.as("dev-avery-owner").get(`${A}/team/members`);
    expect(team.body.items.find((m: { displayName: string }) => m.displayName === "Nia N.")).toMatchObject({ jobTitle: "Technician", status: "active" });

    // Audited, without copying the email address into the log.
    const admin = await adminClient();
    try {
      const { rows } = await admin.query(
        `SELECT action, metadata::text AS m FROM audit_events WHERE organization_id = $1
            AND ((action = 'member.invited' AND target_id = $2) OR (action = 'member.invite_accepted' AND metadata->>'inviteId' = $2::text))`,
        [ORG_A, r.body.id],
      );
      expect(rows.map((x) => x.action).sort()).toEqual(["member.invite_accepted", "member.invited"]);
      for (const x of rows) expect(x.m).not.toContain("@");
    } finally {
      await admin.end();
    }
  });

  it("someone nobody added gets no access, with a clear message", async () => {
    const stranger = await call(person("stranger", "stranger@example.com"), "GET", "/v1/me");
    expect(stranger.status).toBe(401);
    expect(stranger.body.error.message).toMatch(/haven't been added to a company/);
    expect((await call(person("noemail", undefined), "GET", "/v1/me")).status).toBe(401);
    // And they can't reach a company by guessing its id.
    expect((await call(person("stranger", "stranger@example.com"), "GET", A)).status).toBe(401);
  });

  it("an existing person added to a second company gets it at their next sign-in", async () => {
    expect((await invite("dev-riley-owner", { email: "new.tech@example.com", displayName: "Nia at Redstone", roleIds: [roleB.employee] }, B)).status).toBe(201);
    await acceptAll(person("nia", "new.tech@example.com", "Nia N."));
    const me = await call(person("nia", "new.tech@example.com", "Nia N."), "GET", "/v1/me");
    expect(me.body.memberships.map((m: { organizationId: string }) => m.organizationId).sort()).toEqual([ORG_A, ORG_B].sort());
  });

  it("a withdrawn invite can't be used", async () => {
    const r = await invite("dev-avery-owner", { email: "changed.mind@example.com", displayName: "Changed Mind", roleIds: [roleA.employee] });
    expect((await t.as("dev-avery-owner").del(`${A}/team/invites/${r.body.id}`)).status).toBe(204);
    expect((await call(person("changed", "changed.mind@example.com"), "GET", "/v1/me")).status).toBe(401);
  });
});

describe("accepting, declining and expiry", () => {
  async function age(inviteId: string, days: number) {
    const admin = await adminClient();
    try {
      await admin.query("UPDATE member_invites SET expires_at = now() - make_interval(days => $2) WHERE id = $1", [inviteId, days]);
    } finally {
      await admin.end();
    }
  }

  it("a new invite lasts 14 days", async () => {
    const r = await invite("dev-avery-owner", { email: "fourteen@example.com", displayName: "Fourteen", roleIds: [roleA.employee] });
    const days = (Date.parse(r.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    const listed = (await t.as("dev-avery-owner").get(`${A}/team/invites`)).body.items.find((i: { id: string }) => i.id === r.body.id);
    expect(listed).toMatchObject({ expired: false, expiresAt: r.body.expiresAt });
  });

  it("an expired invite can't be accepted, gives a first-time person no account, and the owner sees it as expired", async () => {
    const r = await invite("dev-avery-owner", { email: "too.late@example.com", displayName: "Too Late", roleIds: [roleA.employee] });
    await age(r.body.id, 1);
    const token = person("late", "too.late@example.com");
    expect((await call(token, "GET", "/v1/me")).status).toBe(401);
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(401);
    const listed = (await t.as("dev-avery-owner").get(`${A}/team/invites`)).body.items.find((i: { id: string }) => i.id === r.body.id);
    expect(listed.expired).toBe(true);

    // Renew: it works again for 14 days from now.
    const renewed = await t.as("dev-avery-owner").post(`${A}/team/invites/${r.body.id}/renew`);
    expect(renewed.status).toBe(200);
    expect(renewed.body.expired).toBe(false);
    await acceptAll(token);
    expect((await call(token, "GET", A)).status).toBe(200);
  });

  it("an existing person can't accept an invite after it expires", async () => {
    const token = person("late", "too.late@example.com"); // has an account (joined company A in the test above)
    const r = await invite("dev-riley-owner", { email: "too.late@example.com", displayName: "Too Late", roleIds: [roleB.employee] }, B);
    expect(r.status).toBe(201);
    expect((await call(token, "GET", "/v1/me")).body.invites).toHaveLength(1);
    await age(r.body.id, 0);
    expect((await call(token, "GET", "/v1/me")).body.invites).toEqual([]);
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(404);
  });

  it("adding an email again after its invite expired replaces the old invite", async () => {
    const first = await invite("dev-avery-owner", { email: "again@example.com", displayName: "Again", roleIds: [roleA.employee] });
    expect((await invite("dev-avery-owner", { email: "again@example.com", displayName: "Again", roleIds: [roleA.employee] })).status).toBe(409);
    await age(first.body.id, 1);
    const second = await invite("dev-avery-owner", { email: "again@example.com", displayName: "Again", roleIds: [roleA.employee] });
    expect(second.status).toBe(201);
    const ids = (await t.as("dev-avery-owner").get(`${A}/team/invites`)).body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(second.body.id);
    expect(ids).not.toContain(first.body.id);
  });

  it("declining: the person doesn't join, the invite disappears, and it can't be accepted afterwards", async () => {
    const r = await invite("dev-avery-owner", { email: "no.thanks@example.com", displayName: "No Thanks", roleIds: [roleA.employee] });
    const token = person("nothanks", "no.thanks@example.com");
    expect((await call(token, "GET", "/v1/me")).body.invites).toHaveLength(1);
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/decline`)).body.outcome).toBe("declined");
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(404);
    expect((await call(token, "GET", "/v1/me")).body).toMatchObject({ memberships: [], invites: [] });
    expect((await t.as("dev-avery-owner").get(`${A}/team/invites`)).body.items.map((i: { id: string }) => i.id)).not.toContain(r.body.id);
    // The owner can add them again later.
    expect((await invite("dev-avery-owner", { email: "no.thanks@example.com", displayName: "No Thanks", roleIds: [roleA.employee] })).status).toBe(201);
  });

  it("only the person the invite was sent to can accept it", async () => {
    const r = await invite("dev-avery-owner", { email: "the.right.one@example.com", displayName: "Right One", roleIds: [roleA.manager] });
    // Someone else with an account (and their own email) tries the invite id.
    const other = person("nia", "new.tech@example.com", "Nia N.");
    expect((await call(other, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(404);
    expect((await t.as("dev-eli-employee").post(`/v1/invites/${r.body.id}/accept`)).status).toBe(404);
    expect((await call(other, "POST", `/v1/invites/not-a-uuid/accept`)).status).toBe(400);
    expect((await t.app.inject({ method: "POST", url: `/v1/invites/${r.body.id}/accept` })).statusCode).toBe(401);
    // Still open for the right person.
    expect((await t.as("dev-avery-owner").get(`${A}/team/invites`)).body.items.map((i: { id: string }) => i.id)).toContain(r.body.id);
  });

  it("a cancelled invite disappears from the person's list", async () => {
    const r = await invite("dev-avery-owner", { email: "cancel.me@example.com", displayName: "Cancel Me", roleIds: [roleA.employee] });
    const token = person("cancelme", "cancel.me@example.com");
    expect((await call(token, "GET", "/v1/me")).body.invites).toHaveLength(1);
    expect((await t.as("dev-avery-owner").del(`${A}/team/invites/${r.body.id}`)).status).toBe(204);
    expect((await call(token, "GET", "/v1/me")).body.invites).toEqual([]);
    expect((await call(token, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(404);
  });

  it("only people who may add people can renew, and not for someone stronger than themselves", async () => {
    const r = await invite("dev-avery-owner", { email: "future.boss@example.com", displayName: "Future Boss", roleIds: [roleA.owner] });
    expect((await t.as("dev-morgan-manager").post(`${A}/team/invites/${r.body.id}/renew`)).status).toBe(403);
    expect((await t.as("dev-riley-owner").post(`${A}/team/invites/${r.body.id}/renew`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").post(`${B}/team/invites/${r.body.id}/renew`)).status).toBe(404);
    await t.as("dev-avery-owner").del(`${A}/team/invites/${r.body.id}`);
  });
});

describe("who can add people, and with which roles", () => {
  it("employees and managers can't add people (owners only by default)", async () => {
    expect((await invite("dev-eli-employee", { email: "x1@example.com", displayName: "X", roleIds: [roleA.employee] })).status).toBe(403);
    expect((await invite("dev-morgan-manager", { email: "x2@example.com", displayName: "X", roleIds: [roleA.employee] })).status).toBe(403);
    expect((await t.as("dev-morgan-manager").get(`${A}/team/invites`)).status).toBe(403);
  });

  it("someone allowed to add people still can't add an owner unless they hold everything an owner has", async () => {
    const avery = t.as("dev-avery-owner");
    const helper = await avery.post(`${A}/team/roles`, { name: "People admin", permissions: ["members.manage"] });
    expect((await avery.patch(`${A}/team/members/00000000-0000-4b00-8000-00000000a002`, { roleIds: [roleA.manager, helper.body.id] })).status).toBe(200);
    try {
      const asOwner = await invite("dev-morgan-manager", { email: "boss@example.com", displayName: "Boss", roleIds: [roleA.owner] });
      expect(asOwner.status).toBe(403);
      expect((await invite("dev-morgan-manager", { email: "crew@example.com", displayName: "Crew", roleIds: [roleA.employee] })).status).toBe(201);
      // ...and can't remove or suspend an owner.
      expect((await t.as("dev-morgan-manager").patch(`${A}/team/members/00000000-0000-4b00-8000-00000000a001/status`, { status: "removed" })).status).toBe(403);
    } finally {
      await avery.patch(`${A}/team/members/00000000-0000-4b00-8000-00000000a002`, { roleIds: [roleA.manager] });
      await avery.del(`${A}/team/roles/${helper.body.id}`);
    }
  });

  it("rejects duplicates, people already in the company, bad emails, and other companies' roles", async () => {
    const avery = t.as("dev-avery-owner");
    expect((await invite("dev-avery-owner", { email: "dupe@example.com", displayName: "D", roleIds: [roleA.employee] })).status).toBe(201);
    expect((await invite("dev-avery-owner", { email: "DUPE@example.com", displayName: "D", roleIds: [roleA.employee] })).status).toBe(409);
    const already = await invite("dev-avery-owner", { email: F.users[2]!.email, displayName: "Eli", roleIds: [roleA.employee] });
    expect(already.status).toBe(409);
    expect(already.body.error.message).toMatch(/already in the company/);
    expect((await invite("dev-avery-owner", { email: "not-an-email", displayName: "D", roleIds: [roleA.employee] })).status).toBe(400);
    expect((await invite("dev-avery-owner", { email: "y@example.com", displayName: "Y", roleIds: [] })).status).toBe(400);
    expect((await invite("dev-avery-owner", { email: "y@example.com", displayName: "Y", roleIds: [roleB.employee] })).status).toBe(404);
    // Another company's owner can't see or withdraw company A's invites.
    const mine = (await avery.get(`${A}/team/invites`)).body.items.find((i: { email: string }) => i.email === "dupe@example.com");
    expect((await t.as("dev-riley-owner").del(`${A}/team/invites/${mine.id}`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").del(`${B}/team/invites/${mine.id}`)).status).toBe(404);
  });
});

describe("removing people", () => {
  it("a removed person loses access at once; adding them again brings them back with the new role only", async () => {
    const token = person("rex", "rex.removed@example.com", "Rex");
    await invite("dev-avery-owner", { email: "rex.removed@example.com", displayName: "Rex", roleIds: [roleA.manager] });
    await acceptAll(token);
    expect((await call(token, "GET", A)).status).toBe(200);
    const mid = (await call(token, "GET", "/v1/me")).body.memberships[0].membershipId as string;

    const removed = await t.as("dev-avery-owner").patch(`${A}/team/members/${mid}/status`, { status: "removed" });
    expect(removed.status).toBe(200);
    expect((await call(token, "GET", A)).status).toBe(404);
    expect((await call(token, "GET", "/v1/me")).body.memberships).toEqual([]);

    await invite("dev-avery-owner", { email: "rex.removed@example.com", displayName: "Rex", roleIds: [roleA.employee] });
    // Added again: they see the invite and must accept it again.
    expect((await call(token, "GET", A)).status).toBe(404);
    expect((await call(token, "GET", "/v1/me")).body.memberships).toHaveLength(0);
    await acceptAll(token);
    expect((await call(token, "GET", "/v1/me")).body.memberships).toHaveLength(1);
    const back = await call(token, "GET", A);
    expect(back.status).toBe(200);
    expect(back.body.roles).toEqual(["employee"]);
  });

  it("the last active owner can't be removed or suspended", async () => {
    const r = await t.as("dev-avery-owner").patch(`${A}/team/members/00000000-0000-4b00-8000-00000000a001/status`, { status: "suspended" });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/at least one active owner/);
    expect((await t.as("dev-avery-owner").get(A)).status).toBe(200);
  });

  it("can't touch people in another company", async () => {
    expect((await t.as("dev-avery-owner").patch(`${A}/team/members/00000000-0000-4b00-8000-00000000b002/status`, { status: "removed" })).status).toBe(404);
    expect((await t.as("dev-blake-employee").get(B)).status).toBe(200);
  });
});

describe("trying it with test people (development sign-in)", () => {
  it("Nia Newcomer has no company until an owner adds her email and she presses Accept", async () => {
    const nia = t.as("dev-nia-newcomer");
    expect((await nia.get("/v1/me")).body).toMatchObject({ memberships: [], invites: [] });
    const r = await invite("dev-avery-owner", { email: "nia.newcomer@example.com", displayName: "Nia Newcomer", roleIds: [roleA.employee] });
    expect(r.status).toBe(201);
    // Development tokens carry the made-up person's email so the invite shows up.
    const tokenRes = await t.app.inject({ method: "POST", url: "/dev/auth/token", payload: { subject: "dev-nia-newcomer" } });
    const devToken = JSON.parse(tokenRes.body).accessToken as string;
    const me = await call(devToken, "GET", "/v1/me");
    expect(me.body.invites.map((i: { inviteId: string }) => i.inviteId)).toEqual([r.body.id]);
    expect((await call(devToken, "GET", A)).status).toBe(404);
    expect((await call(devToken, "POST", `/v1/invites/${r.body.id}/accept`)).status).toBe(200);
    expect((await call(devToken, "GET", A)).status).toBe(200);
    // Put her back outside every company for other test files.
    const mid = (await call(devToken, "GET", "/v1/me")).body.memberships[0].membershipId as string;
    expect((await t.as("dev-avery-owner").patch(`${A}/team/members/${mid}/status`, { status: "removed" })).status).toBe(200);
  });
});
