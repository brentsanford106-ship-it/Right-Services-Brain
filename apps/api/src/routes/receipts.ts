import type { FastifyInstance } from "fastify";
import { CreateReceiptRequest, OrgParams, PageQuery, type Receipt } from "@rsb/contracts";
import { inOrg } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess } from "../lib/access.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import type { RouteDeps } from "./index.js";

interface ReceiptRow {
  id: string;
  job_id: string | null;
  job_number: string | null;
  vendor: string;
  amount_cents: number;
  currency: string;
  purchased_on: string;
  category: Receipt["category"];
  status: Receipt["status"];
  submitted_by: string;
}

const RECEIPT_SELECT = `SELECT r.id, r.job_id, j.job_number, r.vendor, r.amount_cents, r.currency, r.purchased_on, r.category, r.status,
                               u.display_name AS submitted_by
                          FROM receipts r
                          LEFT JOIN jobs j ON j.organization_id = r.organization_id AND j.id = r.job_id
                          JOIN organization_memberships m ON m.organization_id = r.organization_id AND m.id = r.submitted_by_membership_id
                          JOIN users u ON u.id = m.user_id`;

const toReceipt = (r: ReceiptRow): Receipt => ({
  id: r.id,
  jobId: r.job_id,
  jobNumber: r.job_number,
  vendor: r.vendor,
  amountCents: r.amount_cents,
  currency: r.currency,
  purchasedOn: r.purchased_on,
  category: r.category,
  status: r.status,
  submittedBy: r.submitted_by,
});

export async function receiptRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/orgs/:orgId/receipts", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    const { limit } = parse(PageQuery, req.query);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("receipts.read_all", "receipts.read_own");
      // Members without receipts.read_all only ever see their own receipts.
      const ownOnly = !ctx.has("receipts.read_all");
      const { rows } = await tx.query<ReceiptRow>(
        `${RECEIPT_SELECT}
          WHERE r.deleted_at IS NULL AND ($1::boolean = false OR r.submitted_by_membership_id = $2)
          ORDER BY r.purchased_on DESC, r.created_at DESC LIMIT $3`,
        [ownOnly, ctx.membershipId, limit],
      );
      return { items: rows.map(toReceipt), scope: ownOnly ? "own" : "all" };
    });
  });

  app.post("/v1/orgs/:orgId/receipts", async (req, reply) => {
    const { orgId } = parse(OrgParams, req.params);
    const body = parse(CreateReceiptRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("receipts.submit");
      if (body.jobId) await assertJobAccess(tx, ctx, body.jobId);
      const { id, created } = await insertIdempotent(
        tx, "receipts", body.clientRef, ctx.membershipId,
        `INSERT INTO receipts (organization_id, job_id, submitted_by_membership_id, vendor, amount_cents, currency, purchased_on, category, notes, client_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, body.jobId ?? null, ctx.membershipId, body.vendor, body.amountCents, body.currency, body.purchasedOn,
         body.category, body.notes ?? null, body.clientRef],
      );
      if (created) await recordAudit(tx, ctx, "receipt.submitted", "receipt", id, body.jobId ? { jobId: body.jobId } : {});
      const { rows } = await tx.query<ReceiptRow>(`${RECEIPT_SELECT} WHERE r.id = $1`, [id]);
      return { receipt: toReceipt(rows[0]!), created };
    });
    return reply.status(result.created ? 201 : 200).send(result.receipt);
  });
}
