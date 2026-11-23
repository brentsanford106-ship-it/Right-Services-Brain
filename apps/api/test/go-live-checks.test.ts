import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, uuid, type Res, type TestApp } from "./helpers.js";
import { clientAddress } from "../src/app.js";
import { photoKey } from "../src/storage/types.js";
import type { TokenVerifier, VerifiedIdentity } from "../src/auth/types.js";

/**
 * Gaps found in the pre-go-live review (2026-11-22), each with the test that shows it is closed:
 *  1. Someone who may resolve flags but sees only their assigned jobs could list and resolve flags on other jobs.
 *  2. Someone with "add people" could cancel the invite of a future owner (stronger than themselves).
 *  3. The same photo file arriving twice at once (phone retry while the first try is still going) gave a false
 *     "different file" error, and a different file could replace a stored original.
 *  4. Two requests at the same moment on a person's very first sign-in: one could say "not added to a company".
 *  5. The rate limit trusted a caller-supplied X-Forwarded-For address in Azure.
 */
const ISSUER = "https://example-tenant.ciamlogin.example.com/go-live-checks/v2.0";
const identities = new Map<string, VerifiedIdentity>();
class FakeOidc implements TokenVerifier {
  async verify(token: string) {
    return identities.get(token) ?? null;
  }
}

let t: TestApp;
let jpeg: Buffer;
let otherJpeg: Buffer;
const A = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id; // Eli assigned
const hp1002 = F.jobs[1].id; // Ezra assigned
const M = { eli: "00000000-0000-4b00-8000-00000000a003", morgan: "00000000-0000-4b00-8000-00000000a002" };
let roles: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp({}, { extraVerifiers: [new FakeOidc()] });
  jpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#225588" } }).jpeg().toBuffer();
  otherJpeg = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#885522" } }).jpeg().toBuffer();
  roles = Object.fromEntries((await t.as("dev-avery-owner").get(`${A}/team/roles`)).body.items.map((r: { key: string; id: string }) => [r.key, r.id]));
});
afterAll(async () => {
  // Put company A back as the seed had it for later test files.
  await t.as("dev-avery-owner").patch(`${A}/team/members/${M.eli}`, { roleIds: [roles.employee] });
  await t.as("dev-avery-owner").patch(`${A}/team/members/${M.morgan}`, { roleIds: [roles.manager] });
  const admin = await adminClient();
  try {
    await admin.query("UPDATE member_invites SET revoked_at = now() WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL");
    await admin.query("UPDATE organization_memberships m SET status = 'removed' FROM users u WHERE u.id = m.user_id AND u.idp_issuer = $1", [ISSUER]);
  } finally {
    await admin.end();
  }
  await t.close();
});

async function newRole(name: string, permissions: string[]): Promise<string> {
  const r = await t.as("dev-avery-owner").post(`${A}/team/roles`, { name, permissions });
  expect(r.status).toBe(201);
  return r.body.id;
}

async function record(subject: string, jobId: string): Promise<string> {
  const r = await t.as(subject).post(`${A}/jobs/${jobId}/photos`, {
    clientRef: uuid(), stage: "during", capturedAt: "2026-11-20T10:00:00Z", contentType: "image/jpeg",
  });
  expect(r.status).toBe(201);
  return r.body.id;
}

describe("1. flag review respects which jobs a person can see", () => {
  it("a flag reviewer who sees only assigned jobs gets only those jobs' flags, and can't resolve others", async () => {
    const reviewer = await newRole("Flag reviewer (assigned jobs)", ["photo_flags.manage"]);
    expect((await t.as("dev-avery-owner").patch(`${A}/team/members/${M.eli}`, { roleIds: [roles.employee, reviewer] })).status).toBe(200);

    // A flag on Eli's job, and one on Ezra's job (HP-1002) that Eli can't see.
    const mine = await record("dev-eli-employee", hp1001);
    const myFlag = await t.as("dev-eli-employee").post(`${A}/photos/${mine}/flags`, { reason: "Check this (synthetic)" });
    expect(myFlag.status).toBe(201);
    const theirs = await record("dev-ezra-field", hp1002);
    const theirFlag = await t.as("dev-ezra-field").post(`${A}/photos/${theirs}/flags`, { reason: "Hidden from Eli (synthetic)" });
    expect(theirFlag.status).toBe(201);

    const list = await t.as("dev-eli-employee").get(`${A}/photo-flags`);
    expect(list.status).toBe(200);
    const photoIds = list.body.items.map((f: { photoId: string }) => f.photoId);
    expect(photoIds).toContain(mine);
    expect(photoIds).not.toContain(theirs);
    expect(list.body.items.every((f: { jobNumber: string }) => f.jobNumber === "HP-1001")).toBe(true);

    expect((await t.as("dev-eli-employee").post(`${A}/photo-flags/${theirFlag.body.id}/resolve`, {})).status).toBe(404);
    expect((await t.as("dev-eli-employee").post(`${A}/photo-flags/${myFlag.body.id}/resolve`, {})).status).toBe(200);

    // A manager (sees every job) still sees every open flag.
    const all = await t.as("dev-morgan-manager").get(`${A}/photo-flags`);
    expect(all.body.items.map((f: { photoId: string }) => f.photoId)).toContain(theirs);
  });

  it("flags on deleted photos drop out of the review list", async () => {
    const p = await record("dev-eli-employee", hp1001);
    await t.as("dev-eli-employee").post(`${A}/photos/${p}/flags`, { reason: "Soon deleted (synthetic)" });
    expect((await t.as("dev-eli-employee").del(`${A}/photos/${p}`)).status).toBe(204);
    const list = await t.as("dev-morgan-manager").get(`${A}/photo-flags`);
    expect(list.body.items.map((f: { photoId: string }) => f.photoId)).not.toContain(p);
  });
});

describe("2. cancelling an invite follows the 'no one stronger than you' rule", () => {
  it("a helper who may add people can cancel an employee's invite but not a future owner's", async () => {
    const helper = await newRole("People helper", ["org.read", "members.manage"]);
    expect((await t.as("dev-avery-owner").patch(`${A}/team/members/${M.morgan}`, { roleIds: [roles.manager, helper] })).status).toBe(200);

    const ownerInvite = await t.as("dev-avery-owner").post(`${A}/team/invites`, { email: "future.owner@example.com", displayName: "Future Owner", roleIds: [roles.owner] });
    expect(ownerInvite.status).toBe(201);
    const empInvite = await t.as("dev-morgan-manager").post(`${A}/team/invites`, { email: "new.hand@example.com", displayName: "New Hand", roleIds: [roles.employee] });
    expect(empInvite.status).toBe(201);

    const denied = await t.as("dev-morgan-manager").del(`${A}/team/invites/${ownerInvite.body.id}`);
    expect(denied.status).toBe(403);
    const still = await t.as("dev-avery-owner").get(`${A}/team/invites`);
    expect(still.body.items.map((i: { id: string }) => i.id)).toContain(ownerInvite.body.id);

    expect((await t.as("dev-morgan-manager").del(`${A}/team/invites/${empInvite.body.id}`)).status).toBe(204);
    expect((await t.as("dev-avery-owner").del(`${A}/team/invites/${ownerInvite.body.id}`)).status).toBe(204);
  });
});

describe("3. photo files are write-once", () => {
  it("the same file sent twice at the same moment: both succeed, one copy is stored", async () => {
    const id = await record("dev-eli-employee", hp1001);
    const eli = t.as("dev-eli-employee");
    const [a, b] = await Promise.all([eli.put(`${A}/photos/${id}/content`, jpeg, "image/jpeg"), eli.put(`${A}/photos/${id}/content`, jpeg, "image/jpeg")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.duplicate, b.body.duplicate].sort()).toEqual([false, true]);
    const stored = await t.storage.get(photoKey(ORG_A, id) + "/original");
    expect(stored?.equals(jpeg)).toBe(true);
  });

  it("a different file never replaces a stored original", async () => {
    const id = await record("dev-eli-employee", hp1001);
    const eli = t.as("dev-eli-employee");
    expect((await eli.put(`${A}/photos/${id}/content`, jpeg, "image/jpeg")).status).toBe(200);
    expect((await eli.put(`${A}/photos/${id}/content`, otherJpeg, "image/jpeg")).status).toBe(409);
    expect((await t.storage.get(photoKey(ORG_A, id) + "/original"))?.equals(jpeg)).toBe(true);
  });

  it("left-over file from a try that died before finishing: same file completes, a different file is refused", async () => {
    const id = await record("dev-eli-employee", hp1001);
    const key = photoKey(ORG_A, id) + "/original";
    await t.storage.put(key, jpeg, "image/jpeg"); // as if the server stopped right after writing the file
    expect((await t.as("dev-eli-employee").put(`${A}/photos/${id}/content`, otherJpeg, "image/jpeg")).status).toBe(409);
    expect((await t.storage.get(key))?.equals(jpeg)).toBe(true);
    const ok = await t.as("dev-eli-employee").put(`${A}/photos/${id}/content`, jpeg, "image/jpeg");
    expect(ok.status).toBe(200);
    const view = await t.as("dev-eli-employee").raw(`${A}/photos/${id}/content?variant=original`);
    expect(view.status).toBe(403); // employees can't open originals; check the record instead
    const list = await t.as("dev-eli-employee").get(`${A}/jobs/${hp1001}/photos`);
    expect(list.body.items.find((p: { id: string }) => p.id === id)).toMatchObject({ uploadStatus: "stored", hasPreview: true });
  });

  it("the write-once storage call itself: first write wins, later writes change nothing", async () => {
    const key = photoKey(ORG_A, uuid()) + "/original";
    expect(await t.storage.putIfAbsent(key, jpeg, "image/jpeg")).toBe(true);
    expect(await t.storage.putIfAbsent(key, otherJpeg, "image/jpeg")).toBe(false);
    expect((await t.storage.get(key))?.equals(jpeg)).toBe(true);
    await t.storage.delete(key);
  });
});

describe("4. first sign-in with several requests at once", () => {
  it("every request succeeds, one account is made, and the person joins once, on Accept", async () => {
    const inv = await t.as("dev-avery-owner").post(`${A}/team/invites`, { email: "fast.clicker@example.com", displayName: "Fast Clicker", roleIds: [roles.employee] });
    expect(inv.status).toBe(201);
    const token = "fake.fastclicker.sig";
    identities.set(token, { issuer: ISSUER, subject: "sub-fastclicker", email: "fast.clicker@example.com", name: "Fast Clicker" });
    const call = async (url: string): Promise<Res> => {
      const res = await t.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
      return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
    };
    const results = await Promise.all([call("/v1/me"), call("/v1/me"), call("/v1/me"), call("/v1/me")]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.user.id)).size).toBe(1);
    // Not a member until they accept (the company answers "not found"), then a member exactly once.
    expect((await call(A)).status).toBe(404);
    const accepts = await Promise.all([0, 1].map(() => t.app.inject({ method: "POST", url: `/v1/invites/${inv.body.id}/accept`, headers: { authorization: `Bearer ${token}` } })));
    expect(accepts.map((r) => r.statusCode).sort()).toEqual([200, 404]);
    expect((await call(A)).status).toBe(200);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE u.idp_issuer = $1 AND u.idp_subject = $2",
        [ISSUER, "sub-fastclicker"],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await admin.end();
    }
  });
});

describe("4b. first sign-in race, step by step in the database", () => {
  it("the second of two simultaneous first sign-ins gets the account the first one created", async () => {
    const inv = await t.as("dev-avery-owner").post(`${A}/team/invites`, { email: "race.two@example.com", displayName: "Race Two", roleIds: [roles.employee] });
    expect(inv.status).toBe(201);
    const first = await appRoleClient();
    const second = await appRoleClient();
    try {
      await first.query("BEGIN");
      const a = await first.query("SELECT app.register_invited_user($1, $2, $3, $4) AS id", [ISSUER, "sub-race-two", "race.two@example.com", "Race Two"]);
      expect(a.rows[0].id).toEqual(expect.any(String));
      // The second sign-in starts while the first hasn't finished; it waits on the invite.
      const pending = second.query("SELECT app.register_invited_user($1, $2, $3, $4) AS id", [ISSUER, "sub-race-two", "race.two@example.com", "Race Two"]);
      await new Promise((r) => setTimeout(r, 300));
      await first.query("COMMIT");
      const b = await pending;
      expect(b.rows[0].id).toBe(a.rows[0].id);
    } finally {
      await first.end();
      await second.end();
    }
  });
});

describe("5. rate limit uses the real caller address", () => {
  it("in Azure, only the address App Service added (the last one) counts; caller-typed ones are ignored", () => {
    expect(clientAddress({ "x-forwarded-for": "203.0.113.9:51234" }, "10.0.0.5", true)).toBe("203.0.113.9");
    expect(clientAddress({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.9:4000" }, "10.0.0.5", true)).toBe("203.0.113.9");
    expect(clientAddress({ "x-forwarded-for": "[2001:db8::1]:443" }, "10.0.0.5", true)).toBe("2001:db8::1");
    expect(clientAddress({}, "10.0.0.5", true)).toBe("10.0.0.5");
  });

  it("on a developer's computer the header is ignored completely", () => {
    expect(clientAddress({ "x-forwarded-for": "1.2.3.4" }, "127.0.0.1", false)).toBe("127.0.0.1");
  });

  it("a made-up X-Forwarded-For can't dodge the limit", async () => {
    const strict = await createTestApp({ RATE_LIMIT_PER_MINUTE: "3" });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await strict.app.inject({ method: "GET", url: "/v1/me", headers: { "x-forwarded-for": `198.51.100.${i}` } });
        codes.push(res.statusCode);
      }
      expect(codes.slice(3)).toEqual([429, 429]);
    } finally {
      await strict.close();
    }
  });
});
