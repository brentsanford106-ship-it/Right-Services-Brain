import type { FastifyInstance } from "fastify";
import {
  CreatePhotoIssueRequest,
  IssueActionRequest,
  IssueListQuery,
  IssueParams,
  JobParams,
  OrgParams,
  PhotoParams,
  type IssueStatus,
  type PhotoIssue,
  type PhotoIssueEvent,
} from "@rsb/contracts";
import { inOrg, type OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess, JOB_PEOPLE_SQL, jobVisibilitySql } from "../lib/access.js";
import { jobIssueManagers, notify } from "../lib/notify.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import { HttpError, notFound } from "../lib/errors.js";
import { loadVisiblePhoto } from "./photos.js";
import type { RouteDeps } from "./index.js";

/**
 * Issues to fix on photos (step 4). Status lives on each issue; every change is kept in an add-only history.
 * Managers assign and approve; nobody approves their own fix (except an issue they assigned to themselves).
 */

interface IssueRow {
  id: string;
  job_id: string;
  job_number: string;
  photo_id: string;
  photo_deleted: boolean;
  markup_id: string | null;
  title: string;
  details: string | null;
  status: IssueStatus;
  assignee_membership_id: string | null;
  assignee: string | null;
  created_by_membership_id: string;
  created_by: string;
  submitted_by_membership_id: string | null;
  submitted_by: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
  last_event: string;
  fix_photo_ids: string[] | null;
  fix_photo_roles: string[] | null;
}

const ISSUE_SELECT = `
  SELECT i.id, i.job_id, j.job_number, i.photo_id, (p.deleted_at IS NOT NULL) AS photo_deleted, i.markup_id, i.title, i.details, i.status,
         i.assignee_membership_id, au.display_name AS assignee, i.created_by_membership_id, cu.display_name AS created_by,
         i.submitted_by_membership_id, su.display_name AS submitted_by, ru.display_name AS resolved_by, i.resolved_at, i.created_at, i.updated_at,
         (SELECT e.kind FROM photo_issue_events e WHERE e.organization_id = i.organization_id AND e.issue_id = i.id AND e.kind <> 'fix_photo_added'
           ORDER BY e.created_at DESC LIMIT 1) AS last_event,
         fx.fix_photo_ids, fx.fix_photo_roles
    FROM photo_issues i
    -- The Before/After photos of the latest fix sent for review only (a fix that was sent back stays in the history,
    -- but its photos no longer show as "the fix"). A fix's photos are written right after its "submitted" event.
    LEFT JOIN LATERAL (
      SELECT array_agg(e.photo_id ORDER BY e.created_at, e.id) AS fix_photo_ids,
             array_agg(COALESCE(e.photo_role, 'after') ORDER BY e.created_at, e.id) AS fix_photo_roles
        FROM photo_issue_events e
        JOIN photos fp ON fp.organization_id = e.organization_id AND fp.id = e.photo_id AND fp.deleted_at IS NULL
       WHERE e.organization_id = i.organization_id AND e.issue_id = i.id AND e.kind = 'fix_photo_added'
         AND e.created_at >= COALESCE((SELECT max(se.created_at) FROM photo_issue_events se
                                        WHERE se.organization_id = i.organization_id AND se.issue_id = i.id AND se.kind = 'submitted'), '-infinity')
    ) fx ON true
    JOIN jobs j ON j.organization_id = i.organization_id AND j.id = i.job_id
    JOIN photos p ON p.organization_id = i.organization_id AND p.id = i.photo_id
    JOIN organization_memberships cm ON cm.organization_id = i.organization_id AND cm.id = i.created_by_membership_id
    JOIN users cu ON cu.id = cm.user_id
    LEFT JOIN organization_memberships am ON am.organization_id = i.organization_id AND am.id = i.assignee_membership_id
    LEFT JOIN users au ON au.id = am.user_id
    LEFT JOIN organization_memberships sm ON sm.organization_id = i.organization_id AND sm.id = i.submitted_by_membership_id
    LEFT JOIN users su ON su.id = sm.user_id
    LEFT JOIN organization_memberships rm ON rm.organization_id = i.organization_id AND rm.id = i.resolved_by_membership_id
    LEFT JOIN users ru ON ru.id = rm.user_id`;

/** An issue a manager assigned to themselves: they may approve their own fix (JB, 2026-11-23). */
const selfAssigned = (r: Pick<IssueRow, "created_by_membership_id" | "assignee_membership_id">, me: string) =>
  r.created_by_membership_id === me && r.assignee_membership_id === me;

function allowed(r: IssueRow, ctx: OrgContext) {
  const me = ctx.membershipId;
  const manage = ctx.has("photo_issues.manage");
  const assignee = r.assignee_membership_id === me;
  const ownFix = r.submitted_by_membership_id === me && !selfAssigned(r, me);
  return {
    assign: manage && r.status !== "resolved",
    start: assignee && r.status === "open",
    submit: assignee && (r.status === "open" || r.status === "in_progress"),
    approve: manage && r.status === "awaiting_review" && !ownFix,
    sendBack: manage && r.status === "awaiting_review" && !ownFix,
    reopen: manage && r.status === "resolved",
    edit: r.status !== "resolved" && (manage || (r.created_by_membership_id === me && ctx.has("photo_issues.create") && r.assignee_membership_id === null)),
  };
}

const toIssue = (r: IssueRow, ctx: OrgContext): PhotoIssue => ({
  id: r.id,
  jobId: r.job_id,
  jobNumber: r.job_number,
  photoId: r.photo_id,
  photoDeleted: r.photo_deleted,
  markupId: r.markup_id,
  title: r.title,
  details: r.details,
  status: r.status,
  assigneeId: r.assignee_membership_id,
  assignee: r.assignee,
  createdById: r.created_by_membership_id,
  createdBy: r.created_by,
  submittedBy: r.submitted_by,
  resolvedBy: r.resolved_by,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  lastEvent: r.last_event,
  fixPhotoIds: r.fix_photo_ids ?? [],
  fixPhotoRoles: (r.fix_photo_roles ?? []) as ("before" | "after")[],
  can: allowed(r, ctx),
});

const STATUS_LABEL: Record<IssueStatus, string> = { open: "Open", in_progress: "In progress", awaiting_review: "Waiting for review", resolved: "Resolved" };

async function loadIssue(tx: Tx, ctx: OrgContext, issueId: string): Promise<IssueRow> {
  const { rows } = await tx.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1`, [issueId]);
  const r = rows[0];
  if (!r) throw notFound();
  await assertJobAccess(tx, ctx, r.job_id);
  return r;
}

async function assertOnJob(tx: Tx, ctx: OrgContext, jobId: string, membershipId: string) {
  const { rowCount } = await tx.query(`SELECT 1 FROM (${JOB_PEOPLE_SQL}) p WHERE p.id = $3`, [ctx.orgId, jobId, membershipId]);
  if (!rowCount) throw new HttpError("validation_failed", "You can only assign an issue to someone who can see this job.", [{ path: "assigneeId", issue: "not on this job" }]);
}

async function addEvent(tx: Tx, ctx: OrgContext, issueId: string, e: { kind: string; from?: IssueStatus | null; to?: IssueStatus | null; note?: string | null; assignee?: string | null; photoId?: string | null; clientRef?: string | null; role?: "before" | "after" | null }) {
  await tx.query(
    `INSERT INTO photo_issue_events (organization_id, issue_id, actor_membership_id, kind, from_status, to_status, note, assignee_membership_id, photo_id, client_ref, photo_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [ctx.orgId, issueId, ctx.membershipId, e.kind, e.from ?? null, e.to ?? null, e.note ?? null, e.assignee ?? null, e.photoId ?? null, e.clientRef ?? null, e.role ?? null],
  );
}

function listWhere(q: { status?: string; assigned?: string }, ctx: OrgContext, params: unknown[]): string[] {
  const where: string[] = [];
  if (q.status === "active") where.push("i.status <> 'resolved'");
  else if (q.status) { params.push(q.status); where.push(`i.status = $${params.length}`); }
  if (q.assigned === "me") { params.push(ctx.membershipId); where.push(`i.assignee_membership_id = $${params.length}`); }
  if (q.assigned === "none") where.push("i.assignee_membership_id IS NULL");
  return where;
}

const ORDER = `ORDER BY CASE i.status WHEN 'awaiting_review' THEN 0 WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END, i.updated_at DESC LIMIT 500`;

export async function issueRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  // ------------------------------------------------------------ on one photo
  app.get("/v1/orgs/:orgId/photos/:photoId/issues", async (req) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await loadVisiblePhoto(tx, ctx, photoId, ctx.has("photos.delete_any"));
      const { rows } = await tx.query<IssueRow>(`${ISSUE_SELECT} WHERE i.photo_id = $1 ORDER BY i.created_at`, [photoId]);
      return { items: rows.map((r) => toIssue(r, ctx)) };
    });
  });

  app.post("/v1/orgs/:orgId/photos/:photoId/issues", async (req, reply) => {
    const { orgId, photoId } = parse(PhotoParams, req.params);
    const body = parse(CreatePhotoIssueRequest, req.body);
    const out = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("photo_issues.create", "photo_issues.manage");
      const photo = await loadVisiblePhoto(tx, ctx, photoId);
      // Only managers assign. Everyone else's report goes to the job's Issues list unassigned.
      if (body.assigneeId) {
        if (!ctx.has("photo_issues.manage")) throw new HttpError("forbidden", "A manager assigns issues. Report it without choosing a person.");
        await assertOnJob(tx, ctx, photo.job_id, body.assigneeId);
      }
      if (body.markupId) {
        const { rowCount } = await tx.query("SELECT 1 FROM photo_markups WHERE id = $1 AND photo_id = $2 AND removed_at IS NULL", [body.markupId, photoId]);
        if (!rowCount) throw new HttpError("validation_failed", "That mark is not on this photo.", [{ path: "markupId", issue: "not found" }]);
      }
      const { id, created } = await insertIdempotent(
        tx, "photo_issues", body.clientRef, ctx.membershipId,
        `INSERT INTO photo_issues (organization_id, job_id, photo_id, markup_id, title, details, assignee_membership_id, created_by_membership_id, client_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, photo.job_id, photoId, body.markupId ?? null, body.title, body.details || null, body.assigneeId ?? null, ctx.membershipId, body.clientRef],
      );
      if (created) {
        await addEvent(tx, ctx, id, { kind: "reported", to: "open", note: body.details || null });
        if (body.assigneeId) await addEvent(tx, ctx, id, { kind: "assigned", assignee: body.assigneeId });
        const base = { jobId: photo.job_id, photoId, issueId: id };
        if (body.assigneeId) await notify(tx, ctx, { ...base, kind: "issue_assigned", recipients: [body.assigneeId] });
        else await notify(tx, ctx, { ...base, kind: "issue_reported", recipients: await jobIssueManagers(tx, ctx, photo.job_id) });
        await recordAudit(tx, ctx, "photo_issue.reported", "photo_issue", id, { photoId, jobId: photo.job_id, assigned: !!body.assigneeId });
      }
      return { issue: toIssue(await loadIssue(tx, ctx, id), ctx), created };
    });
    return reply.status(out.created ? 201 : 200).send(out.issue);
  });

  // ------------------------------------------------------------ lists: one job, or "assigned to me" everywhere
  app.get("/v1/orgs/:orgId/jobs/:jobId/issues", async (req) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    const q = parse(IssueListQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await assertJobAccess(tx, ctx, jobId);
      const params: unknown[] = [jobId];
      const where = ["i.job_id = $1", ...listWhere(q, ctx, params)];
      const { rows } = await tx.query<IssueRow>(`${ISSUE_SELECT} WHERE ${where.join(" AND ")} ${ORDER}`, params);
      return { items: rows.map((r) => toIssue(r, ctx)) };
    });
  });

  app.get("/v1/orgs/:orgId/photo-issues", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const q = parse(IssueListQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const vis = jobVisibilitySql(ctx); // only issues on jobs this person can see
      const params: unknown[] = [ctx.membershipId];
      const where = [`(${vis.where})`, "j.deleted_at IS NULL", ...listWhere(q, ctx, params)];
      const { rows } = await tx.query<IssueRow>(`${ISSUE_SELECT} WHERE ${where.join(" AND ")} ${ORDER}`, params);
      return { items: rows.map((r) => toIssue(r, ctx)) };
    });
  });

  app.get("/v1/orgs/:orgId/photo-issues/:issueId", async (req) => {
    const { orgId, issueId } = parse(IssueParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const r = await loadIssue(tx, ctx, issueId);
      const { rows } = await tx.query<{ id: string; kind: string; actor: string; from_status: IssueStatus | null; to_status: IssueStatus | null; note: string | null; assignee: string | null; photo_id: string | null; created_at: Date }>(
        `SELECT e.id, e.kind, u.display_name AS actor, e.from_status, e.to_status, e.note, au.display_name AS assignee, e.photo_id, e.created_at
           FROM photo_issue_events e
           JOIN organization_memberships m ON m.organization_id = e.organization_id AND m.id = e.actor_membership_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN organization_memberships am ON am.organization_id = e.organization_id AND am.id = e.assignee_membership_id
           LEFT JOIN users au ON au.id = am.user_id
          WHERE e.issue_id = $1 ORDER BY e.created_at, e.id`,
        [issueId],
      );
      const history: PhotoIssueEvent[] = rows.map((e) => ({
        id: e.id, kind: e.kind, actor: e.actor, fromStatus: e.from_status, toStatus: e.to_status, note: e.note,
        assignee: e.assignee, photoId: e.photo_id, createdAt: e.created_at.toISOString(),
      }));
      return { issue: toIssue(r, ctx), history };
    });
  });

  // ------------------------------------------------------------ everything that changes an issue
  app.post("/v1/orgs/:orgId/photo-issues/:issueId/actions", async (req) => {
    const { orgId, issueId } = parse(IssueParams, req.params);
    const body = parse(IssueActionRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      // Lock the issue so two people acting at once are handled one after the other.
      await tx.query("SELECT 1 FROM photo_issues WHERE id = $1 FOR UPDATE", [issueId]);
      const r = await loadIssue(tx, ctx, issueId);

      // The same action sent twice (weak signal): the first one counts, the repeat changes nothing.
      const { rows: seen } = await tx.query<{ actor_membership_id: string; issue_id: string }>(
        "SELECT actor_membership_id, issue_id FROM photo_issue_events WHERE client_ref = $1",
        [body.clientRef],
      );
      if (seen[0]) {
        if (seen[0].actor_membership_id !== ctx.membershipId || seen[0].issue_id !== issueId) throw new HttpError("conflict", "This submission id has already been used.");
        return toIssue(r, ctx);
      }
      // Made on a phone that hadn't seen a later change: don't apply it, say what happened instead.
      if (body.expectedStatus && body.expectedStatus !== r.status) {
        throw new HttpError("conflict", `This issue changed while you were away: it is now "${STATUS_LABEL[r.status]}". Nothing was changed. Have a look and try again.`);
      }
      const can = allowed(r, ctx);
      const deny = (why: string) => { throw new HttpError("forbidden", why); };
      const me = ctx.membershipId;
      const note = body.note?.trim() || null;
      const ref = body.clientRef;
      const set = async (sql: string, params: unknown[]) => tx.query(`UPDATE photo_issues SET ${sql} WHERE id = $1`, [issueId, ...params]);

      switch (body.action) {
        case "assign": {
          if (!can.assign) deny(r.status === "resolved" ? "Reopen the issue before assigning it." : "A manager assigns issues.");
          const to = body.assigneeId ?? null;
          if (to) await assertOnJob(tx, ctx, r.job_id, to);
          if (to === r.assignee_membership_id) return toIssue(r, ctx);
          // A new person starts fresh: back to Open (their own "Start" moves it on).
          const back = r.status === "in_progress" ? "open" : r.status;
          await set("assignee_membership_id = $2, status = $3", [to, back]);
          await addEvent(tx, ctx, issueId, { kind: to ? "assigned" : "unassigned", assignee: to, from: r.status, to: back, note, clientRef: ref });
          break;
        }
        case "start":
          if (!can.start) deny(r.assignee_membership_id === me ? "This issue isn't open." : "Only the person it's assigned to can start it.");
          await set("status = 'in_progress'", []);
          await addEvent(tx, ctx, issueId, { kind: "started", from: r.status, to: "in_progress", note, clientRef: ref });
          break;
        case "submit": {
          if (!can.submit) deny(r.assignee_membership_id === me ? "This issue isn't waiting for a fix." : "Only the person it's assigned to can send a fix.");
          ctx.require("photos.upload");
          // The After box (needed) and the Before box (optional). Any photo on the job may go in either box: its own
          // Before/During/After tag doesn't matter, because people forget to change it (JB, 2026-11-24).
          const afters = [...new Set(body.fixPhotoIds)];
          const before = body.beforePhotoId && !afters.includes(body.beforePhotoId) ? body.beforePhotoId : null;
          if (!afters.length) throw new HttpError("validation_failed", "Add an After photo of the fix before sending it for review.", [{ path: "fixPhotoIds", issue: "needs an after photo" }]);
          for (const pid of [...afters, ...(before ? [before] : [])]) {
            const p = await loadVisiblePhoto(tx, ctx, pid);
            if (p.job_id !== r.job_id) throw new HttpError("validation_failed", "Fix photos must be on the same job.", [{ path: "fixPhotoIds", issue: "other job" }]);
          }
          await set("status = 'awaiting_review', submitted_by_membership_id = $2", [me]);
          await addEvent(tx, ctx, issueId, { kind: "submitted", from: r.status, to: "awaiting_review", note, clientRef: ref });
          for (const pid of afters) await addEvent(tx, ctx, issueId, { kind: "fix_photo_added", photoId: pid, role: "after" });
          if (before) await addEvent(tx, ctx, issueId, { kind: "fix_photo_added", photoId: before, role: "before" });
          break;
        }
        case "approve":
          if (!can.approve) deny(r.submitted_by_membership_id === me && r.status === "awaiting_review" ? "Someone else has to approve your own fix." : "Only a manager can approve a fix that is waiting for review.");
          await set("status = 'resolved', resolved_by_membership_id = $2, resolved_at = clock_timestamp()", [me]);
          await addEvent(tx, ctx, issueId, { kind: "approved", from: r.status, to: "resolved", note, clientRef: ref });
          break;
        case "send_back":
          if (!can.sendBack) deny("Only a manager can send back a fix that is waiting for review (and not their own).");
          if (!note) throw new HttpError("validation_failed", "Say what still needs fixing.", [{ path: "note", issue: "required" }]);
          await set("status = 'open', submitted_by_membership_id = NULL", []);
          await addEvent(tx, ctx, issueId, { kind: "sent_back", from: r.status, to: "open", note, clientRef: ref });
          break;
        case "reopen":
          if (!can.reopen) deny("Only a manager can reopen a resolved issue.");
          await set("status = 'open', resolved_by_membership_id = NULL, resolved_at = NULL, submitted_by_membership_id = NULL", []);
          await addEvent(tx, ctx, issueId, { kind: "reopened", from: r.status, to: "open", note, clientRef: ref });
          break;
        case "edit":
          if (!can.edit) deny("You can't change this issue.");
          if (body.title === undefined && body.details === undefined) throw new HttpError("validation_failed", "Nothing to change.");
          await set("title = COALESCE($2, title), details = CASE WHEN $3::boolean THEN $4 ELSE details END", [body.title ?? null, body.details !== undefined, body.details || null]);
          await addEvent(tx, ctx, issueId, { kind: "edited", note, clientRef: ref });
          break;
      }
      // Alerts for the people this change is for.
      const base = { jobId: r.job_id, photoId: r.photo_id, issueId };
      if (body.action === "assign" && body.assigneeId) await notify(tx, ctx, { ...base, kind: "issue_assigned", recipients: [body.assigneeId] });
      if (body.action === "submit") await notify(tx, ctx, { ...base, kind: "issue_submitted", recipients: await jobIssueManagers(tx, ctx, r.job_id) });
      if (body.action === "approve") await notify(tx, ctx, { ...base, kind: "issue_approved", recipients: [r.submitted_by_membership_id, r.assignee_membership_id] });
      if (body.action === "send_back") await notify(tx, ctx, { ...base, kind: "issue_sent_back", recipients: [r.assignee_membership_id, r.submitted_by_membership_id] });
      if (body.action === "reopen") await notify(tx, ctx, { ...base, kind: "issue_reopened", recipients: [r.assignee_membership_id] });
      await recordAudit(tx, ctx, `photo_issue.${body.action}`, "photo_issue", issueId, { from: r.status, jobId: r.job_id });
      return toIssue(await loadIssue(tx, ctx, issueId), ctx);
    });
  });
}
