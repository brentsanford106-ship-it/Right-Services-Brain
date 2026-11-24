import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Issues to fix (JB's spec, step 4): report, assign, In Progress, send a fix with an "after" photo, approve,
 * send back, reopen; nobody approves their own fix; history kept; photos with issue history are never purged.
 */
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const A = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id;
const hp1002 = F.jobs[1].id;
const MORGAN = "00000000-0000-4b00-8000-00000000a002";
const ELI = "00000000-0000-4b00-8000-00000000a003";
const EZRA = "00000000-0000-4b00-8000-00000000a004";

async function newPhoto(who = "dev-eli-employee", job: string = hp1001, stage = "during") {
  const r = await t.as(who).post(`${A}/jobs/${job}/photos`, { clientRef: uuid(), stage, capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg" });
  expect(r.status).toBe(201);
  return r.body.id as string;
}
const report = (who: string, photo: string, body: Record<string, unknown> = {}) =>
  t.as(who).post(`${A}/photos/${photo}/issues`, { clientRef: uuid(), title: "Conduit strap loose", ...body });
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

describe("issues to fix", () => {
  it("the whole loop: manager assigns, employee starts and sends a fix photo, manager approves; history is kept", async () => {
    const photo = await newPhoto();
    const r = await report("dev-morgan-manager", photo, { assigneeId: ELI, details: "Top left corner" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "open", assigneeId: ELI, assignee: "Eli Employee", createdBy: "Morgan Manager", lastEvent: "assigned" });
    const id = r.body.id;

    const p = (await t.as("dev-eli-employee").get(`${A}/jobs/${hp1001}/photos`)).body.items.find((x: { id: string }) => x.id === photo);
    expect(p.openIssueCount).toBe(1);
    const mine = await t.as("dev-eli-employee").get(`${A}/photo-issues?assigned=me&status=active`);
    expect(mine.body.items.map((i: { id: string }) => i.id)).toContain(id);
    expect(mine.body.items.find((i: { id: string }) => i.id === id).can).toMatchObject({ start: true, submit: true, approve: false });

    expect((await act("dev-eli-employee", id, "start")).body.status).toBe("in_progress");
    // The After box is needed; the Before box is optional. Any photo can go in either box, whatever its own tag
    // (people forget to change it), and each comes back with the box it was put in.
    const before = await newPhoto("dev-eli-employee", hp1001, "during");
    const noAfter = await act("dev-eli-employee", id, "submit", { fixPhotoIds: [], beforePhotoId: before, expectedStatus: "in_progress" });
    expect(noAfter.status).toBe(400);
    expect(noAfter.body.error.message).toMatch(/Add an After photo/);
    const fix = await newPhoto("dev-eli-employee", hp1001, "during"); // tagged During, but put in the After box
    const s = await act("dev-eli-employee", id, "submit", { note: "Re-strapped it", fixPhotoIds: [fix], beforePhotoId: before, expectedStatus: "in_progress" });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: "awaiting_review", submittedBy: "Eli Employee", fixPhotoIds: [fix, before], fixPhotoRoles: ["after", "before"] });
    expect((await act("dev-eli-employee", id, "approve")).status).toBe(403); // employees can't approve
    const ok = await act("dev-morgan-manager", id, "approve");
    expect(ok.body).toMatchObject({ status: "resolved", resolvedBy: "Morgan Manager" });

    const h = await t.as("dev-eli-employee").get(`${A}/photo-issues/${id}`);
    expect(h.body.history.map((e: { kind: string }) => e.kind)).toEqual(["reported", "assigned", "started", "submitted", "fix_photo_added", "fix_photo_added", "approved"]);
    expect(h.body.history.find((e: { kind: string }) => e.kind === "submitted")).toMatchObject({ actor: "Eli Employee", note: "Re-strapped it", fromStatus: "in_progress", toStatus: "awaiting_review" });
  });

  it("an employee's report goes to the job's Issues list unassigned; only a manager assigns", async () => {
    const photo = await newPhoto();
    expect((await report("dev-eli-employee", photo, { assigneeId: ELI })).status).toBe(403);
    const r = await report("dev-eli-employee", photo, { title: "Cracked lens on fixture 3" });
    expect(r.body).toMatchObject({ status: "open", assigneeId: null, createdBy: "Eli Employee" });
    const unassigned = await t.as("dev-morgan-manager").get(`${A}/jobs/${hp1001}/issues?assigned=none&status=active`);
    expect(unassigned.body.items.map((i: { id: string }) => i.id)).toContain(r.body.id);
    expect((await act("dev-eli-employee", r.body.id, "assign", { assigneeId: ELI })).status).toBe(403);
    expect((await act("dev-morgan-manager", r.body.id, "assign", { assigneeId: EZRA })).status).toBe(400); // Ezra isn't on this job
    expect((await act("dev-morgan-manager", r.body.id, "assign", { assigneeId: ELI })).body.assignee).toBe("Eli Employee");
  });

  it("send back needs a note and returns it to the fixer; reopen brings a resolved issue back", async () => {
    const photo = await newPhoto();
    const id = (await report("dev-morgan-manager", photo, { assigneeId: ELI })).body.id;
    await act("dev-eli-employee", id, "submit", { note: "done" });
    expect((await act("dev-morgan-manager", id, "send_back")).status).toBe(400);
    const back = await act("dev-morgan-manager", id, "send_back", { note: "Still loose on the right side" });
    expect(back.body).toMatchObject({ status: "open", lastEvent: "sent_back", submittedBy: null });
    await act("dev-eli-employee", id, "submit", { note: "really done" });
    await act("dev-morgan-manager", id, "approve");
    expect((await act("dev-eli-employee", id, "reopen")).status).toBe(403);
    const re = await act("dev-avery-owner", id, "reopen", { note: "Came loose again" });
    expect(re.body).toMatchObject({ status: "open", resolvedBy: null, resolvedAt: null, lastEvent: "reopened" });
  });

  it("after a fix is sent back, the issue shows the newest fix's Before and After, not the one that was sent back", async () => {
    const photo = await newPhoto();
    const id = (await report("dev-morgan-manager", photo, { assigneeId: ELI })).body.id;
    const oldBefore = await newPhoto();
    const oldAfter = await newPhoto("dev-eli-employee", hp1001, "after");
    expect((await act("dev-eli-employee", id, "submit", { fixPhotoIds: [oldAfter], beforePhotoId: oldBefore })).body)
      .toMatchObject({ fixPhotoIds: [oldAfter, oldBefore], fixPhotoRoles: ["after", "before"] });
    await act("dev-morgan-manager", id, "send_back", { note: "Still loose" });
    // Second try with only an After photo: no Before box from the first try leaks in.
    const newAfter = await newPhoto("dev-eli-employee", hp1001, "after");
    const s = await act("dev-eli-employee", id, "submit", { fixPhotoIds: [newAfter] });
    expect(s.body).toMatchObject({ status: "awaiting_review", fixPhotoIds: [newAfter], fixPhotoRoles: ["after"] });
    // The history still records every fix photo ever sent.
    const h = await t.as("dev-morgan-manager").get(`${A}/photo-issues/${id}`);
    expect(h.body.history.filter((e: { kind: string }) => e.kind === "fix_photo_added")).toHaveLength(3);
  });

  it("nobody approves their own fix, except an issue they assigned to themselves", async () => {
    const photo = await newPhoto();
    // Avery assigns Morgan; Morgan (a manager) fixes it and can't approve it.
    const a = (await report("dev-avery-owner", photo, { assigneeId: MORGAN })).body.id;
    await act("dev-morgan-manager", a, "submit");
    const own = await act("dev-morgan-manager", a, "approve");
    expect(own.status).toBe(403);
    expect(own.body.error.message).toMatch(/Someone else has to approve/);
    expect((await act("dev-avery-owner", a, "approve")).body.status).toBe("resolved");
    // Morgan assigns it to themselves: allowed to approve their own fix (JB, 2026-11-23).
    const b = (await report("dev-morgan-manager", photo, { assigneeId: MORGAN })).body.id;
    await act("dev-morgan-manager", b, "submit");
    expect((await act("dev-morgan-manager", b, "approve")).body.status).toBe("resolved");
  });

  it("only the assignee works on it, only real status changes happen, and fix photos must be on the same job", async () => {
    const photo = await newPhoto();
    const id = (await report("dev-morgan-manager", photo, { assigneeId: ELI })).body.id;
    expect((await act("dev-morgan-manager", id, "start")).status).toBe(403);
    expect((await act("dev-morgan-manager", id, "approve")).status).toBe(403); // not waiting for review yet
    const other = await newPhoto("dev-ezra-field", hp1002);
    expect((await act("dev-eli-employee", id, "submit", { fixPhotoIds: [other] })).status).toBe(404); // Eli can't even see it
    const otherJobOwn = await newPhoto("dev-avery-owner", hp1002);
    expect((await act("dev-avery-owner", id, "assign", { assigneeId: MORGAN })).status).toBe(200);
    expect((await act("dev-morgan-manager", id, "submit", { fixPhotoIds: [otherJobOwn] })).status).toBe(400);
    // The database itself refuses a jump it doesn't allow.
    const admin = await adminClient();
    try {
      await admin.query("UPDATE photo_issues SET status = 'resolved', resolved_at = now(), resolved_by_membership_id = $2 WHERE id = $1", [id, MORGAN]);
      await expect(admin.query("UPDATE photo_issues SET status = 'awaiting_review' WHERE id = $1", [id])).rejects.toThrow(/cannot go from resolved to awaiting_review/);
      await expect(admin.query("UPDATE photo_issues SET photo_id = $2 WHERE id = $1", [id, other])).rejects.toThrow();
    } finally {
      await admin.end();
    }
  });

  it("an action made on a phone that hadn't seen a newer change is not applied; the same action sent twice counts once", async () => {
    const photo = await newPhoto();
    const id = (await report("dev-morgan-manager", photo, { assigneeId: ELI })).body.id;
    const clientRef = uuid();
    const first = await t.as("dev-eli-employee").post(`${A}/photo-issues/${id}/actions`, { clientRef, action: "start", expectedStatus: "open" });
    const again = await t.as("dev-eli-employee").post(`${A}/photo-issues/${id}/actions`, { clientRef, action: "start", expectedStatus: "open" });
    expect([first.status, again.status]).toEqual([200, 200]);
    const h = await t.as("dev-eli-employee").get(`${A}/photo-issues/${id}`);
    expect(h.body.history.filter((e: { kind: string }) => e.kind === "started")).toHaveLength(1);
    // Meanwhile the manager unassigned and re-assigned it (back to Open). A stale "submit" from the phone says so.
    await act("dev-morgan-manager", id, "assign", { assigneeId: null });
    await act("dev-morgan-manager", id, "assign", { assigneeId: ELI });
    const stale = await act("dev-eli-employee", id, "submit", { expectedStatus: "in_progress" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/changed while you were away: it is now "Open"/);
  });

  it("history can't be rewritten, and a photo with issue history is never deleted forever", async () => {
    const photo = await newPhoto();
    const id = (await report("dev-morgan-manager", photo)).body.id;
    const app = await appRoleClient();
    try {
      for (const [sql, params] of [
        ["UPDATE photo_issue_events SET note = 'x' WHERE issue_id = $1", [id]],
        ["DELETE FROM photo_issue_events WHERE issue_id = $1", [id]],
        ["UPDATE photo_issues SET created_by_membership_id = $2 WHERE id = $1", [id, ELI]],
      ] as const) {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_A]);
        await expect(app.query(sql, [...params])).rejects.toThrow(/permission denied/);
        await app.query("ROLLBACK");
      }
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await app.end();
    }
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${photo}`)).status).toBe(204); // Recently Deleted is fine
    const purge = await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [photo] });
    expect(purge.status).toBe(409);
    expect(purge.body.error.message).toMatch(/part of an issue's history/);
    // The issue still shows, marked as being on a deleted photo.
    const list = await t.as("dev-morgan-manager").get(`${A}/jobs/${hp1001}/issues`);
    expect(list.body.items.find((i: { id: string }) => i.id === id).photoDeleted).toBe(true);
    // The scheduled clean-up skips it too.
    const admin = await adminClient();
    try {
      await admin.query("UPDATE photos SET deleted_at = now() - interval '400 days' WHERE id = $1", [photo]);
      const { rows } = await admin.query("SELECT photo_id FROM app.photos_past_retention(1000) WHERE photo_id = $1", [photo]);
      expect(rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("company walls: other companies and people not on the job see and change nothing", async () => {
    const photo = await newPhoto();
    const id = (await report("dev-morgan-manager", photo, { assigneeId: ELI })).body.id;
    for (const who of ["dev-ezra-field", "dev-riley-owner"]) {
      expect((await t.as(who).get(`${A}/photo-issues/${id}`)).status).toBe(404);
      expect((await t.as(who).get(`${A}/photos/${photo}/issues`)).status).toBe(404);
      expect((await act(who, id, "approve")).status).toBe(404);
      expect((await t.as(who).get(`${A}/photo-issues?status=active`)).body.items?.some((i: { id: string }) => i.id === id) ?? false).toBe(false);
    }
    expect((await t.as("dev-riley-owner").get(`/v1/orgs/${ORG_B}/photo-issues/${id}`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").post(`/v1/orgs/${ORG_B}/photos/${photo}/issues`, { clientRef: uuid(), title: "x" })).status).toBe(404);
  });

  it("an owner can switch reporting off for a role", async () => {
    const photo = await newPhoto();
    const admin = await adminClient();
    try {
      await admin.query(`DELETE FROM role_permissions rp USING roles r WHERE rp.role_id = r.id AND r.organization_id = $1 AND r.key = 'employee' AND rp.permission_key = 'photo_issues.create'`, [ORG_A]);
      expect((await report("dev-eli-employee", photo)).status).toBe(403);
    } finally {
      await admin.query(`INSERT INTO role_permissions (organization_id, role_id, permission_key) SELECT organization_id, id, 'photo_issues.create' FROM roles WHERE organization_id = $1 AND key = 'employee' ON CONFLICT DO NOTHING`, [ORG_A]);
      await admin.end();
    }
  });
});
