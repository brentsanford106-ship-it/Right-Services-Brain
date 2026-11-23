import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sharp from "sharp";
import { adminClient, appRoleClient, createTestApp, F, ORG_A, ORG_B, uuid, type TestApp } from "./helpers.js";

/**
 * Drawing on photos (JB's spec, step 3): owners and managers draw, employees see the marks; marks are shape data
 * next to the photo and never change the photo file; removed marks are kept; comments can point at a mark.
 */
let t: TestApp;
let jpeg: Buffer;
beforeAll(async () => {
  t = await createTestApp();
  jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 200, b: 200 } } }).jpeg().toBuffer();
});
afterAll(async () => { await t.close(); });

const A = `/v1/orgs/${ORG_A}`;
const hp1001 = F.jobs[0].id;
const MORGAN = "00000000-0000-4b00-8000-00000000a002";

async function newPhoto(upload = false) {
  const r = await t.as("dev-eli-employee").post(`${A}/jobs/${hp1001}/photos`, {
    clientRef: uuid(), stage: "during", capturedAt: "2026-11-12T10:00:00Z", contentType: "image/jpeg",
  });
  if (upload) expect((await t.as("dev-eli-employee").put(`${A}/photos/${r.body.id}/content`, jpeg, "image/jpeg")).status).toBe(200);
  return r.body.id as string;
}
const circle = () => ({ clientRef: uuid(), kind: "circle", color: "red", size: 2, points: [[0.1, 0.1], [0.4, 0.5]] });
const save = (who: string, photo: string, body: unknown) => t.as(who).post(`${A}/photos/${photo}/markups/changes`, body);

describe("drawing on photos", () => {
  it("a manager circles something; the employee sees it; the photo file is unchanged", async () => {
    const photo = await newPhoto(true);
    const before = await t.as("dev-morgan-manager").raw(`${A}/photos/${photo}/content?variant=original`);
    const r = await save("dev-morgan-manager", photo, {
      add: [circle(), { clientRef: uuid(), kind: "arrow", color: "yellow", size: 1, points: [[0.9, 0.9], [0.5, 0.5]] },
        { clientRef: uuid(), kind: "text", color: "white", size: 2, points: [[0.1, 0.8]], label: " Fix this strap " },
        { clientRef: uuid(), kind: "pin", color: "red", size: 1, points: [[0.3, 0.3]] },
        { clientRef: uuid(), kind: "pen", color: "blue", size: 3, points: [[0.1, 0.1], [0.2, 0.15], [0.3, 0.2]] }],
    });
    expect(r.status).toBe(200);
    expect(r.body.items.map((m: { kind: string }) => m.kind)).toEqual(["circle", "arrow", "text", "pin", "pen"]);
    expect(r.body.items[2]).toMatchObject({ label: "Fix this strap", author: "Morgan Manager", authorId: MORGAN, mine: true, canRemove: true });

    const asEli = await t.as("dev-eli-employee").get(`${A}/photos/${photo}/markups`);
    expect(asEli.body.items).toHaveLength(5);
    expect(asEli.body.items[0]).toMatchObject({ mine: false, canRemove: false });
    const p = (await t.as("dev-eli-employee").get(`${A}/jobs/${hp1001}/photos`)).body.items.find((x: { id: string }) => x.id === photo);
    expect(p.markupCount).toBe(5);
    const after = await t.as("dev-morgan-manager").raw(`${A}/photos/${photo}/content?variant=original`);
    expect(Buffer.compare(before.data, after.data)).toBe(0);
  });

  it("employees can't draw (JB's decision), and an owner can switch drawing on for a role", async () => {
    const photo = await newPhoto();
    expect((await save("dev-eli-employee", photo, { add: [circle()] })).status).toBe(403);
    const admin = await adminClient();
    try {
      await admin.query(`INSERT INTO role_permissions (organization_id, role_id, permission_key)
        SELECT organization_id, id, 'photo_markups.create' FROM roles WHERE organization_id = $1 AND key = 'employee'`, [ORG_A]);
      expect((await save("dev-eli-employee", photo, { add: [circle()] })).status).toBe(200);
    } finally {
      await admin.query(`DELETE FROM role_permissions rp USING roles r WHERE rp.role_id = r.id AND r.organization_id = $1 AND r.key = 'employee' AND rp.permission_key = 'photo_markups.create'`, [ORG_A]);
      await admin.end();
    }
  });

  it("rejects marks that are off the photo, the wrong shape, or too big", async () => {
    const photo = await newPhoto();
    const bad = [
      { ...circle(), points: [[0.1, 0.1], [1.5, 0.5]] },
      { ...circle(), points: [[0.1, 0.1]] },
      { ...circle(), color: "pink" },
      { clientRef: uuid(), kind: "text", color: "red", size: 1, points: [[0.5, 0.5]], label: "  " },
      { ...circle(), label: "words" },
      { ...circle(), size: 7 },
    ];
    for (const s of bad) expect((await save("dev-morgan-manager", photo, { add: [s] })).status).toBe(400);
    expect((await save("dev-morgan-manager", photo, {})).status).toBe(400);
    // A long pen line fits.
    const pen = { clientRef: uuid(), kind: "pen", color: "red", size: 1, points: Array.from({ length: 2000 }, (_, i) => [i / 2000, 0.123456]) };
    expect((await save("dev-morgan-manager", photo, { add: [pen] })).status).toBe(200);
  });

  it("Save tapped twice (or resent after a dropped connection) saves each mark once", async () => {
    const photo = await newPhoto();
    const body = { add: [circle()] };
    await save("dev-morgan-manager", photo, body);
    const again = await save("dev-morgan-manager", photo, body);
    expect(again.status).toBe(200);
    expect(again.body.items).toHaveLength(1);
    // The same id on a different photo is refused.
    expect((await save("dev-morgan-manager", await newPhoto(), body)).status).toBe(409);
  });

  it("people remove their own marks; only an owner removes someone else's; removed marks are kept for the record", async () => {
    const photo = await newPhoto();
    const r = await save("dev-morgan-manager", photo, { add: [circle(), circle()] });
    const [m1, m2] = r.body.items.map((m: { id: string }) => m.id);
    const av = await save("dev-avery-owner", photo, { add: [circle()] });
    const mine = av.body.items.find((m: { mine: boolean }) => m.mine).id;
    expect((await save("dev-morgan-manager", photo, { remove: [mine] })).status).toBe(403); // a manager can't remove the owner's
    expect((await save("dev-morgan-manager", photo, { remove: [m1] })).status).toBe(200);
    expect((await save("dev-avery-owner", photo, { remove: [m2] })).status).toBe(200); // the owner can remove anyone's
    const left = await t.as("dev-eli-employee").get(`${A}/photos/${photo}/markups`);
    expect(left.body.items.map((m: { id: string }) => m.id)).toEqual([mine]);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT id, removed_by_membership_id FROM photo_markups WHERE photo_id = $1 AND removed_at IS NOT NULL ORDER BY created_at", [photo]);
      expect(rows.map((x) => x.id)).toEqual([m1, m2]);
      const { rows: a } = await admin.query("SELECT metadata FROM audit_events WHERE target_id = $1 AND action = 'photo_markup.changed' ORDER BY occurred_at", [photo]);
      expect(a.map((x) => x.metadata)).toEqual([
        { added: 2, removed: 0, removedOthers: 0 }, { added: 1, removed: 0, removedOthers: 0 },
        { added: 0, removed: 1, removedOthers: 0 }, { added: 0, removed: 1, removedOthers: 1 },
      ]);
    } finally {
      await admin.end();
    }
  });

  it("a saved mark can never be changed, even through the database login the app uses", async () => {
    const photo = await newPhoto();
    const r = await save("dev-morgan-manager", photo, { add: [circle()] });
    const app = await appRoleClient();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.current_org_id', $1, true)", [ORG_A]);
      await expect(app.query("UPDATE photo_markups SET points = '[[0,0],[1,1]]' WHERE id = $1", [r.body.items[0].id])).rejects.toThrow(/permission denied/);
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await app.end();
    }
  });

  it("a comment can point at a mark on the same photo only", async () => {
    const photo = await newPhoto();
    const other = await newPhoto();
    const r = await save("dev-morgan-manager", photo, { add: [circle()] });
    const mark = r.body.items[0].id;
    const c = await t.as("dev-morgan-manager").post(`${A}/photos/${photo}/comments`, { clientRef: uuid(), body: "Fix this", markupId: mark });
    expect(c.status).toBe(201);
    expect(c.body.markupId).toBe(mark);
    expect((await t.as("dev-morgan-manager").post(`${A}/photos/${other}/comments`, { clientRef: uuid(), body: "x", markupId: mark })).status).toBe(400);
  });

  it("company walls: other companies and people not on the job see and change nothing", async () => {
    const photo = await newPhoto();
    await save("dev-morgan-manager", photo, { add: [circle()] });
    expect((await t.as("dev-ezra-field").get(`${A}/photos/${photo}/markups`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").get(`${A}/photos/${photo}/markups`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").get(`/v1/orgs/${ORG_B}/photos/${photo}/markups`)).status).toBe(404);
    expect((await t.as("dev-riley-owner").post(`/v1/orgs/${ORG_B}/photos/${photo}/markups/changes`, { add: [circle()] })).status).toBe(404);
  });

  it("deleting a photo forever removes its marks and the comments on them", async () => {
    const photo = await newPhoto();
    const r = await save("dev-morgan-manager", photo, { add: [circle()] });
    await t.as("dev-morgan-manager").post(`${A}/photos/${photo}/comments`, { clientRef: uuid(), body: "x", markupId: r.body.items[0].id });
    expect((await t.as("dev-avery-owner").del(`${A}/photos/${photo}`)).status).toBe(204);
    expect((await save("dev-morgan-manager", photo, { add: [circle()] })).status).toBe(404); // no drawing on deleted photos
    expect((await t.as("dev-avery-owner").post(`${A}/photos/purge`, { photoIds: [photo] })).status).toBe(204);
    const admin = await adminClient();
    try {
      const { rows } = await admin.query("SELECT count(*)::int AS n FROM photo_markups WHERE photo_id = $1", [photo]);
      expect(rows[0].n).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
