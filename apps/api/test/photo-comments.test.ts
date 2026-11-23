import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Comments and replies on photos (JB's spec, step 2): who can read and write them, replies, @mentions,
 * edit/delete with every earlier wording kept, company walls, and "delete forever".
 */
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const A = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id; // Eli and Casey are assigned; Ezra is not
const AVERY = "00000000-0000-4b00-8000-00000000a001";
const MORGAN = "00000000-0000-4b00-8000-00000000a002";
const ELI = "00000000-0000-4b00-8000-00000000a003";
const EZRA = "00000000-0000-4b00-8000-00000000a004";
const SAM = "00000000-0000-4b00-8000-00000000a005";
const CASEY_A = "00000000-0000-4b00-8000-00000000c0a1";
const RILEY_B = "00000000-0000-4b00-8000-00000000b001";

async function newPhoto(subject = "dev-eli-employee") {
  const r = await t.as(subject).post(`${A}/jobs/${hp1001}/photos`, {
    clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg",
  });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const comment = (subject: string, photoId: string, body: Record<string, unknown>) =>
  t.as(subject).post(`${A}/photos/${photoId}/comments`, { clientRef: uuid(), ...body });
const list = async (subject: string, photoId: string) => (await t.as(subject).get(`${A}/photos/${photoId}/comments`)).body.items;

describe("photo comments", () => {
  it("a manager comments, the employee replies, and the photo shows how many comments it has", async () => {
    const photo = await newPhoto();
    const c = await comment("dev-morgan-manager", photo, { body: "  Fix the conduit strap here  ", mentionIds: [ELI] });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({
      body: "Fix the conduit strap here", author: "Morgan Manager", authorId: MORGAN, parentId: null, mine: true,
      mentions: [{ id: ELI, name: "Eli Employee" }], canEdit: true, canDelete: true, editedAt: null,
    });
    const r = await comment("dev-eli-employee", photo, { body: "On it", parentId: c.body.id });
    expect(r.status).toBe(201);
    expect(r.body.parentId).toBe(c.body.id);

    const items = await list("dev-eli-employee", photo);
    expect(items.map((x: { body: string }) => x.body)).toEqual(["Fix the conduit strap here", "On it"]);
    expect(items[0]).toMatchObject({ mine: false, canEdit: false, canDelete: false }); // Eli can't touch Morgan's comment
    const p = (await t.as("dev-avery-owner").get(`${A}/jobs/${hp1001}/photos`)).body.items.find((x: { id: string }) => x.id === photo);
    expect(p.commentCount).toBe(2);
    expect(p.lastCommentAt).toBe(r.body.createdAt);
  });

  it("sending the same comment twice (weak signal) saves it once; someone else can't reuse its id", async () => {
    const photo = await newPhoto();
    const clientRef = uuid();
    const first = await t.as("dev-eli-employee").post(`${A}/photos/${photo}/comments`, { clientRef, body: "Done" });
    const again = await t.as("dev-eli-employee").post(`${A}/photos/${photo}/comments`, { clientRef, body: "Done" });
    expect([first.status, again.status]).toEqual([201, 200]);
    expect(again.body.id).toBe(first.body.id);
    expect(await list("dev-eli-employee", photo)).toHaveLength(1);
    expect((await t.as("dev-morgan-manager").post(`${A}/photos/${photo}/comments`, { clientRef, body: "x" })).status).toBe(409);
  });

  it("replies are one level deep and must be on the same photo", async () => {
    const photo = await newPhoto();
    const other = await newPhoto();
    const top = await comment("dev-eli-employee", photo, { body: "top" });
    const reply = await comment("dev-eli-employee", photo, { body: "reply", parentId: top.body.id });
    expect((await comment("dev-eli-employee", photo, { body: "nested", parentId: reply.body.id })).status).toBe(400);
    expect((await comment("dev-eli-employee", other, { body: "wrong photo", parentId: top.body.id })).status).toBe(400);
    // The database refuses it too, not only the API.
    const admin = await adminClient();
    try {
      await expect(admin.query(
        `INSERT INTO photo_comments (organization_id, photo_id, parent_id, author_membership_id, body) VALUES ($1, $2, $3, $4, 'x')`,
        [ORG_A, photo, reply.body.id, ELI],
      )).rejects.toThrow(/cannot have replies/);
      await expect(admin.query(
        `INSERT INTO photo_comments (organization_id, photo_id, parent_id, author_membership_id, body) VALUES ($1, $2, $3, $4, 'x')`,
        [ORG_A, other, top.body.id, ELI],
      )).rejects.toThrow(/foreign key/);
    } finally {
      await admin.end();
    }
  });

  it("@mentions only people who can see the job", async () => {
    const photo = await newPhoto();
    const ok = await comment("dev-eli-employee", photo, { body: "@Avery @Casey look", mentionIds: [AVERY, CASEY_A, AVERY] });
    expect(ok.status).toBe(201);
    expect(ok.body.mentions.map((m: { id: string }) => m.id).sort()).toEqual([AVERY, CASEY_A].sort());
    for (const who of [EZRA, SAM, RILEY_B, uuid()]) {
      expect((await comment("dev-eli-employee", photo, { body: "hey", mentionIds: [who] })).status).toBe(400);
    }
    const people = await t.as("dev-eli-employee").get(`${A}/jobs/${hp1001}/people`);
    expect(people.status).toBe(200);
    const ids = people.body.items.map((p: { id: string }) => p.id);
    expect(ids).toEqual(expect.arrayContaining([AVERY, MORGAN, ELI, CASEY_A]));
    expect(ids).not.toContain(EZRA);
    expect(ids).not.toContain(SAM);
    expect(ids).not.toContain(RILEY_B);
    expect(people.body.items.find((p: { id: string }) => p.id === ELI).me).toBe(true);
  });

  it("only the writer can edit; every earlier wording is kept and the comment shows as edited", async () => {
    const photo = await newPhoto();
    const c = await comment("dev-eli-employee", photo, { body: "first wording" });
    expect((await t.as("dev-morgan-manager").patch(`${A}/photo-comments/${c.body.id}`, { body: "hijack" })).status).toBe(403);
    expect((await t.as("dev-avery-owner").patch(`${A}/photo-comments/${c.body.id}`, { body: "hijack" })).status).toBe(403);
    const e = await t.as("dev-eli-employee").patch(`${A}/photo-comments/${c.body.id}`, { body: "second wording", mentionIds: [MORGAN] });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ body: "second wording", mentions: [{ id: MORGAN }] });
    expect(e.body.editedAt).not.toBeNull();
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT body FROM photo_comment_revisions WHERE comment_id = $1", [c.body.id]);
      expect(rows.map((r) => r.body)).toEqual(["first wording"]);
      const { rows: a } = await admin.query("SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY occurred_at", [c.body.id]);
      expect(a.map((r) => r.action)).toEqual(["photo_comment.created", "photo_comment.edited"]);
      expect(JSON.stringify(a)).not.toContain("wording"); // the words themselves stay out of the activity log
      // Who wrote it and where it is can never be changed by the app.
      const app = await appRoleClient();
      try {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_A]);
        await expect(app.query("UPDATE photo_comments SET author_membership_id = $2 WHERE id = $1", [c.body.id, MORGAN])).rejects.toThrow(/permission denied/);
      } finally {
        await app.query("ROLLBACK").catch(() => undefined);
        await app.end();
      }
    } finally {
      await admin.end();
    }
  });

  it("deleting hides the wording but keeps the row; the owner can delete anyone's, a manager only their own", async () => {
    const photo = await newPhoto();
    const mine = await comment("dev-eli-employee", photo, { body: "mine" });
    const other = await comment("dev-eli-employee", photo, { body: "rude words" });
    expect((await t.as("dev-eli-employee").del(`${A}/photo-comments/${mine.body.id}`)).status).toBe(204);
    expect((await t.as("dev-morgan-manager").del(`${A}/photo-comments/${other.body.id}`)).status).toBe(403);
    expect((await t.as("dev-avery-owner").del(`${A}/photo-comments/${other.body.id}`)).status).toBe(204);
    const items = await list("dev-morgan-manager", photo);
    expect(items).toHaveLength(2);
    expect(items.map((x: { body: string | null; deletedBy: string }) => [x.body, x.deletedBy])).toEqual([[null, "Eli Employee"], [null, "Avery Owner"]]);
    expect((await t.as("dev-eli-employee").patch(`${A}/photo-comments/${mine.body.id}`, { body: "undo" })).status).toBe(409);
    const p = (await t.as("dev-avery-owner").get(`${A}/jobs/${hp1001}/photos`)).body.items.find((x: { id: string }) => x.id === photo);
    expect(p.commentCount).toBe(0);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT body FROM photo_comments WHERE id = $1", [other.body.id]);
      expect(rows[0].body).toBe("rude words"); // kept for the record
      const { rows: a } = await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'photo_comment.deleted'", [other.body.id]);
      expect(a[0].metadata).toMatchObject({ byModerator: true });
    } finally {
      await admin.end();
    }
  });

  it("company walls: other companies and people not on the job see and do nothing", async () => {
    const photo = await newPhoto();
    const c = await comment("dev-eli-employee", photo, { body: "private" });
    for (const [who, url] of [
      ["dev-ezra-field", `${A}/photos/${photo}/comments`],
      ["dev-riley-owner", `${A}/photos/${photo}/comments`],
      ["dev-riley-owner", `/v1/orgs/${ORG_B}/photos/${photo}/comments`],
    ] as const) {
      expect((await t.as(who).get(url)).status).toBe(404);
      expect((await t.as(who).post(url, { clientRef: uuid(), body: "x" })).status).toBe(404);
    }
    expect((await t.as("dev-ezra-field").patch(`${A}/photo-comments/${c.body.id}`, { body: "x" })).status).toBe(404);
    expect((await t.as("dev-ezra-field").del(`${A}/photo-comments/${c.body.id}`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").del(`/v1/orgs/${ORG_B}/photo-comments/${c.body.id}`)).status).toBe(404);
    expect((await t.as("dev-ezra-field").get(`${A}/jobs/${hp1001}/people`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").get(`/v1/orgs/${ORG_B}/jobs/${hp1001}/people`)).status).toBe(404);
  });

  it("an owner can switch commenting off for a role", async () => {
    const photo = await newPhoto();
    const admin = await adminClient();
    try {
      await admin.query(
        `DELETE FROM role_permissions rp USING roles r WHERE rp.role_id = r.id AND r.organization_id = $1 AND r.key = 'employee' AND rp.permission_key = 'photo_comments.create'`,
        [ORG_A],
      );
      expect((await comment("dev-eli-employee", photo, { body: "x" })).status).toBe(403);
      expect((await t.as("dev-eli-employee").get(`${A}/photos/${photo}/comments`)).status).toBe(200); // can still read
    } finally {
      await admin.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_key) SELECT organization_id, id, 'photo_comments.create' FROM roles WHERE organization_id = $1 AND key = 'employee' ON CONFLICT DO NOTHING`,
        [ORG_A],
      );
      await admin.end();
    }
  });

  it("a deleted photo can't get new comments, and deleting it forever removes its comments too", async () => {
    const photo = await newPhoto();
    const top = await comment("dev-morgan-manager", photo, { body: "top", mentionIds: [ELI] });
    const reply = await comment("dev-eli-employee", photo, { body: "reply", parentId: top.body.id });
    await t.as("dev-eli-employee").patch(`${A}/photo-comments/${reply.body.id}`, { body: "reply 2" });
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${photo}`)).status).toBe(204);
    expect((await comment("dev-eli-employee", photo, { body: "late" })).status).toBe(404);
    expect((await t.as("dev-avery-owner").get(`${A}/photos/${photo}/comments`)).status).toBe(200); // owner can still review it
    expect((await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [photo] })).status).toBe(204);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query(
        `SELECT (SELECT count(*)::int FROM photo_comments WHERE photo_id = $1) AS c,
                (SELECT count(*)::int FROM photo_comment_revisions WHERE comment_id = ANY($2::uuid[])) AS r,
                (SELECT count(*)::int FROM photo_comment_mentions WHERE comment_id = ANY($2::uuid[])) AS m`,
        [photo, [top.body.id, reply.body.id]],
      );
      expect(rows[0]).toEqual({ c: 0, r: 0, m: 0 });
    } finally {
      await admin.end();
    }
  });
});
