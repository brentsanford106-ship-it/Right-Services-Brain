import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * In-app alerts (JB's spec, step 5): mentions, replies, comments on your photo, and every issue step,
 * only to the people they're for, never to yourself, respecting each person's alert settings.
 */
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const A = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id;
const MORGAN = "00000000-0000-4b00-8000-00000000a002";
const ELI = "00000000-0000-4b00-8000-00000000a003";
const EZRA = "00000000-0000-4b00-8000-00000000a004";

type Alert = { id: string; kind: string; actor: string; photoId: string; issueId: string | null; commentId: string | null; snippet: string | null; issueTitle: string | null; readAt: string | null };

async function newPhoto(who = "dev-eli-employee") {
  const r = await t.as(who).post(`${A}/jobs/${hp1001}/photos`, { clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg" });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
/** One person's alerts about one photo (other tests write alerts too). */
async function alerts(who: string, photo: string, org = ORG_A): Promise<Alert[]> {
  const r = await t.as(who).get(`/v1/orgs/${org}/notifications?limit=100`);
  expect(r.status).toBe(200);
  return (r.body.items as Alert[]).filter((a) => a.photoId === photo);
}
const kinds = async (who: string, photo: string) => (await alerts(who, photo)).map((a) => a.kind).sort();
const comment = (who: string, photo: string, body: Record<string, unknown>) =>
  t.as(who).post(`${A}/photos/${photo}/comments`, { clientRef: uuid(), mentionIds: [], parentId: null, ...body });
// Sending a fix needs an "After" photo: when a test doesn't give one, the person takes one on the issue's job first.
async function act(who: string, issue: string, action: string, body: Record<string, unknown> = {}) {
  if (action === "submit" && !("fixPhotoIds" in body)) {
    const g = await t.as(who).get(`${A}/photo-issues/${issue}`);
    const jobId = g.body.issue?.jobId ?? g.body.jobId;
    if (jobId) {
      const p = await t.as(who).post(`${A}/jobs/${jobId}/photos`, { clientRef: uuid(), stage: "after", capturedAt: "2026-11-12T11:00:00Z", contentType: "image/jpeg" });
      if (p.status === 201) body = { ...body, fixPhotoIds: [p.body.id] };
    }
  }
  return t.as(who).post(`${A}/photo-issues/${issue}/actions`, { clientRef: uuid(), action, ...body });
}

describe("in-app alerts", () => {
  it("comments: whoever took the photo, people @mentioned, and the person replied to (once each, never yourself)", async () => {
    const photo = await newPhoto(); // Eli took it
    const c1 = await comment("dev-morgan-manager", photo, { body: "Strap is loose" });
    expect(c1.status).toBe(201);
    const a = await alerts("dev-eli-employee", photo);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ kind: "photo_comment", actor: "Morgan Manager", commentId: c1.body.id, snippet: "Strap is loose", readAt: null });
    expect(await kinds("dev-morgan-manager", photo)).toEqual([]); // not about your own comment
    expect(await kinds("dev-avery-owner", photo)).toEqual([]); // not involved

    // Eli replies and mentions Morgan: Morgan gets one alert (the mention), not two.
    const c2 = await comment("dev-eli-employee", photo, { body: "Fixed @Morgan Manager", parentId: c1.body.id, mentionIds: [MORGAN] });
    expect(c2.status).toBe(201);
    expect(await kinds("dev-morgan-manager", photo)).toEqual(["mention"]);
    // A plain reply from Avery tells Morgan (the comment's writer).
    await comment("dev-avery-owner", photo, { body: "Thanks", parentId: c1.body.id });
    expect(await kinds("dev-morgan-manager", photo)).toEqual(["mention", "reply"]);
    // A deleted comment's alert stays, but without the words.
    expect((await t.as("dev-morgan-manager").del(`${A}/photo-comments/${c1.body.id}`)).status).toBe(204);
    expect((await alerts("dev-eli-employee", photo))[0]!.snippet).toBeNull();
  });

  it("issues: each step tells the right people", async () => {
    const photo = await newPhoto();
    // Eli reports it unassigned: the managers on the job hear about it.
    const r = await t.as("dev-eli-employee").post(`${A}/photos/${photo}/issues`, { clientRef: uuid(), title: "Missing bolt" });
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect(await kinds("dev-morgan-manager", photo)).toEqual(["issue_reported"]);
    expect(await kinds("dev-avery-owner", photo)).toEqual(["issue_reported"]);
    expect(await kinds("dev-eli-employee", photo)).toEqual([]);
    expect((await alerts("dev-morgan-manager", photo))[0]!.issueTitle).toBe("Missing bolt");

    expect((await act("dev-morgan-manager", id, "assign", { assigneeId: ELI })).status).toBe(200);
    expect(await kinds("dev-eli-employee", photo)).toEqual(["issue_assigned"]);
    expect((await act("dev-eli-employee", id, "submit")).status).toBe(200);
    expect(await kinds("dev-morgan-manager", photo)).toEqual(["issue_reported", "issue_submitted"]);
    expect((await act("dev-morgan-manager", id, "send_back", { note: "Still loose" })).status).toBe(200);
    expect(await kinds("dev-eli-employee", photo)).toEqual(["issue_assigned", "issue_sent_back"]);
    expect((await act("dev-eli-employee", id, "submit")).status).toBe(200);
    expect((await act("dev-avery-owner", id, "approve")).status).toBe(200);
    expect(await kinds("dev-eli-employee", photo)).toEqual(["issue_approved", "issue_assigned", "issue_sent_back"]);
    expect((await act("dev-morgan-manager", id, "reopen")).status).toBe(200);
    expect(await kinds("dev-eli-employee", photo)).toEqual(["issue_approved", "issue_assigned", "issue_reopened", "issue_sent_back"]);
    // People not on the job never get one, even when named.
    expect(await t.as("dev-ezra-field").get(`${A}/notifications`).then((x) => (x.body.items as Alert[]).filter((a) => a.photoId === photo))).toEqual([]);
    expect((await act("dev-morgan-manager", id, "assign", { assigneeId: EZRA })).status).toBe(400);
  });

  it("alert settings: switched-off kinds aren't sent; only known kinds; settings are per person", async () => {
    const put = await t.as("dev-eli-employee").patch(`${A}/notification-settings`, { muted: ["issue_assigned", "photo_comment"] });
    expect(put.body).toEqual({ muted: ["issue_assigned", "photo_comment"] });
    expect((await t.as("dev-eli-employee").get(`${A}/notification-settings`)).body).toEqual({ muted: ["issue_assigned", "photo_comment"] });
    expect((await t.as("dev-morgan-manager").get(`${A}/notification-settings`)).body).toEqual({ muted: [] });
    try {
      const photo = await newPhoto();
      await comment("dev-morgan-manager", photo, { body: "Look here" });
      await t.as("dev-morgan-manager").post(`${A}/photos/${photo}/issues`, { clientRef: uuid(), title: "Fix it", assigneeId: ELI });
      expect(await kinds("dev-eli-employee", photo)).toEqual([]);
      await comment("dev-morgan-manager", photo, { body: "@Eli Employee please", mentionIds: [ELI] });
      expect(await kinds("dev-eli-employee", photo)).toEqual(["mention"]); // mentions are still on
      expect((await t.as("dev-eli-employee").patch(`${A}/notification-settings`, { muted: ["everything"] })).status).toBe(400);
    } finally {
      await t.as("dev-eli-employee").patch(`${A}/notification-settings`, { muted: [] });
    }
  });

  it("marking read: only your own, one by one or all; unread count", async () => {
    const photo = await newPhoto();
    await comment("dev-morgan-manager", photo, { body: "One" });
    await comment("dev-morgan-manager", photo, { body: "Two @Eli Employee", mentionIds: [ELI] });
    const mine = await alerts("dev-eli-employee", photo);
    expect(mine).toHaveLength(2);
    const before = (await t.as("dev-eli-employee").get(`${A}/notifications/unread-count`)).body.unreadCount as number;
    expect(before).toBeGreaterThanOrEqual(2);
    // Morgan can't mark Eli's alert read.
    await t.as("dev-morgan-manager").post(`${A}/notifications/read`, { ids: [mine[0]!.id] });
    expect((await alerts("dev-eli-employee", photo)).every((a) => a.readAt === null)).toBe(true);
    const one = await t.as("dev-eli-employee").post(`${A}/notifications/read`, { ids: [mine[0]!.id] });
    expect(one.status).toBe(200);
    expect(one.body.unreadCount).toBe(before - 1);
    expect((await t.as("dev-eli-employee").get(`${A}/notifications?unread=true&limit=100`)).body.items.some((a: Alert) => a.id === mine[0]!.id)).toBe(false);
    expect((await t.as("dev-eli-employee").post(`${A}/notifications/read`, { all: true })).body.unreadCount).toBe(0);
    expect((await t.as("dev-eli-employee").post(`${A}/notifications/read`, {})).status).toBe(400);
  });

  it("company walls and deleted photos: alerts hide with the photo, other companies see nothing, purge still works", async () => {
    const photo = await newPhoto();
    await comment("dev-morgan-manager", photo, { body: "Here" });
    expect(await kinds("dev-eli-employee", photo)).toEqual(["photo_comment"]);
    expect((await alerts("dev-riley-owner", photo, ORG_B))).toEqual([]);
    expect((await t.as("dev-riley-owner").get(`${A}/notifications`)).status).toBe(404);
    // Deleted photo: its alerts disappear from the list. Delete forever removes them.
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${photo}`)).status).toBe(204);
    expect(await kinds("dev-eli-employee", photo)).toEqual([]);
    expect((await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [photo] })).status).toBe(204);
    // The database only lets the app add alerts and mark them read.
    const app = await appRoleClient();
    try {
      for (const sql of [
        "UPDATE notifications SET kind = 'reply'",
        "UPDATE notifications SET recipient_membership_id = actor_membership_id",
        "DELETE FROM notifications",
      ]) {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_A]);
        await expect(app.query(sql)).rejects.toThrow(/permission denied/);
        await app.query("ROLLBACK");
      }
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await app.end();
    }
  });
  it("a role that can't see jobs has no alerts (and no errors)", async () => {
    const { adminClient } = await import("./helpers.js");
    const admin = await adminClient();
    try {
      await admin.query(`DELETE FROM role_permissions rp USING roles r WHERE rp.role_id = r.id AND r.organization_id = $1 AND r.key = 'employee' AND rp.permission_key = 'jobs.read_assigned'`, [ORG_A]);
      const r = await t.as("dev-eli-employee").get(`${A}/notifications`);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ items: [], unreadCount: 0 });
    } finally {
      await admin.query(`INSERT INTO role_permissions (organization_id, role_id, permission_key)
        SELECT organization_id, id, 'jobs.read_assigned' FROM roles WHERE organization_id = $1 AND key = 'employee' ON CONFLICT DO NOTHING`, [ORG_A]);
      await admin.end();
    }
  });
});
