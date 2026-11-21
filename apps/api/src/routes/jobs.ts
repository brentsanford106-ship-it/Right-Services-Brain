import type { FastifyInstance } from "fastify";
import { CreateAssignmentRequest, CreateJobRequest, JobListQuery, JobParams, OrgParams, UpdateJobRequest, type Job } from "@rsb/contracts";
import { inOrg } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess, jobVisibilitySql } from "../lib/access.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError, notFound } from "../lib/errors.js";
import type { RouteDeps } from "./index.js";

interface JobRow {
  id: string;
  job_number: string;
  title: string;
  status: Job["status"];
  site_name: string | null;
  site_address: string | null;
  customer_name: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
}

const JOB_SELECT = `SELECT j.id, j.job_number, j.title, j.status, j.site_name, j.site_address,
                           c.name AS customer_name, j.scheduled_start, j.scheduled_end
                      FROM jobs j
                      LEFT JOIN customers c ON c.organization_id = j.organization_id AND c.id = j.customer_id`;

function toJob(r: JobRow, includeCustomer: boolean): Job {
  return {
    id: r.id,
    jobNumber: r.job_number,
    title: r.title,
    status: r.status,
    siteName: r.site_name,
    siteAddress: r.site_address,
    // Customer details are only shown to members allowed to read customers.
    customerName: includeCustomer ? r.customer_name : null,
    scheduledStart: r.scheduled_start,
    scheduledEnd: r.scheduled_end,
  };
}

export async function jobRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/orgs/:orgId/jobs", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { limit, q } = parse(JobListQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const vis = jobVisibilitySql(ctx);
      // Search by job number, job name, or site name. LIKE wildcards in the input are escaped.
      const pattern = q ? `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await tx.query<JobRow>(
        `${JOB_SELECT} WHERE j.deleted_at IS NULL AND (${vis.where})
           AND ($3::text IS NULL OR lower(j.job_number) LIKE $3 OR lower(j.title) LIKE $3 OR lower(coalesce(j.site_name, '')) LIKE $3)
         ORDER BY j.job_number LIMIT $2`,
        [ctx.membershipId, limit, pattern],
      );
      return { items: rows.map((r) => toJob(r, ctx.has("customers.read"))) };
    });
  });

  app.get("/v1/orgs/:orgId/jobs/:jobId", async (req) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await assertJobAccess(tx, ctx, jobId);
      const { rows } = await tx.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [jobId]);
      const job = rows[0];
      if (!job) throw notFound();
      const assignees = ctx.has("members.read") || ctx.has("job_assignments.manage")
        ? (await tx.query<{ membership_id: string; display_name: string }>(
            `SELECT ja.membership_id, u.display_name
               FROM job_assignments ja
               JOIN organization_memberships m ON m.organization_id = ja.organization_id AND m.id = ja.membership_id
               JOIN users u ON u.id = m.user_id
              WHERE ja.job_id = $1 AND ja.ended_at IS NULL ORDER BY u.display_name`,
            [jobId],
          )).rows.map((r) => ({ membershipId: r.membership_id, displayName: r.display_name }))
        : null;
      return { ...toJob(job, ctx.has("customers.read")), assignees };
    });
  });

  app.post("/v1/orgs/:orgId/jobs", async (req, reply) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(CreateJobRequest, req.body);
    const job = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("jobs.manage");
      if (body.scheduledStart && body.scheduledEnd && body.scheduledEnd < body.scheduledStart) {
        throw new HttpError("validation_failed", undefined, [{ path: "scheduledEnd", issue: "must be on or after scheduledStart" }]);
      }
      // organization_id comes from the verified context, never from the request body.
      // The composite FK (organization_id, customer_id) rejects customers from other organizations.
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO jobs (organization_id, customer_id, job_number, title, site_name, site_address, status,
                           scheduled_start, scheduled_end, created_by_membership_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [ctx.orgId, body.customerId ?? null, body.jobNumber, body.title, body.siteName ?? null, body.siteAddress ?? null,
         body.status, body.scheduledStart ?? null, body.scheduledEnd ?? null, ctx.membershipId],
      );
      const id = rows[0]!.id;
      await recordAudit(tx, ctx, "job.created", "job", id);
      const { rows: created } = await tx.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
      return toJob(created[0]!, ctx.has("customers.read"));
    });
    return reply.status(201).send(job);
  });

  app.patch("/v1/orgs/:orgId/jobs/:jobId", async (req) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    const body = parse(UpdateJobRequest, req.body);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("jobs.manage");
      await assertJobAccess(tx, ctx, jobId);
      await tx.query(
        `UPDATE jobs SET
            title = COALESCE($2, title),
            site_name = CASE WHEN $3::boolean THEN NULLIF($4::text, '') ELSE site_name END,
            site_address = CASE WHEN $5::boolean THEN NULLIF($6::text, '') ELSE site_address END,
            status = COALESCE($7, status)
          WHERE id = $1`,
        [jobId, body.title ?? null, body.siteName !== undefined, body.siteName ?? null,
         body.siteAddress !== undefined, body.siteAddress ?? null, body.status ?? null],
      );
      await recordAudit(tx, ctx, "job.updated", "job", jobId, { fields: Object.keys(body).sort() });
      const { rows } = await tx.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [jobId]);
      return toJob(rows[0]!, ctx.has("customers.read"));
    });
  });

  app.post("/v1/orgs/:orgId/jobs/:jobId/assignments", async (req, reply) => {
    const { orgId, jobId } = parse(JobParams, req.params);
    const body = parse(CreateAssignmentRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("job_assignments.manage");
      await assertJobAccess(tx, ctx, jobId);
      const { rowCount } = await tx.query(
        "SELECT 1 FROM organization_memberships WHERE id = $1 AND organization_id = $2 AND status = 'active'",
        [body.membershipId, ctx.orgId],
      );
      if (!rowCount) throw new HttpError("validation_failed", undefined, [{ path: "membershipId", issue: "not an active member of this organization" }]);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO job_assignments (organization_id, job_id, membership_id, assigned_by_membership_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [ctx.orgId, jobId, body.membershipId, ctx.membershipId],
      );
      const id = rows[0]!.id;
      await recordAudit(tx, ctx, "job_assignment.created", "job_assignment", id, { jobId, membershipId: body.membershipId });
      return { id, jobId, membershipId: body.membershipId };
    });
    return reply.status(201).send(result);
  });
}
