import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { MemberParams, OrgParams } from "@rsb/contracts";
import { inOrg } from "../lib/context.js";
import type { OrgContext } from "../lib/context.js";
import type { Tx } from "../lib/db.js";
import { parse } from "../lib/validate.js";
import { recordAudit } from "../lib/audit.js";
import { HttpError, notFound } from "../lib/errors.js";
import { sniff } from "../lib/image.js";
import { avatarKey } from "../storage/types.js";
import type { RouteDeps } from "./index.js";

/** Largest picture accepted from a phone or browser before it is shrunk. */
export const AVATAR_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const AVATAR_EDGE = 256;

/**
 * Profile pictures (JB, 2026-11-23). One small square picture per person per company.
 * The uploaded file is never stored: it is shrunk to 256 x 256 and re-encoded, which also removes any
 * embedded location or other metadata. Anyone in the company can see the pictures (they already see
 * names on photos); only the person themselves can change theirs, and team managers can remove one.
 */
export async function avatarRoutes(app: FastifyInstance, { db, storage }: RouteDeps): Promise<void> {
  for (const type of ["image/jpeg", "image/png"]) {
    app.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: AVATAR_MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));
  }

  app.put("/v1/orgs/:orgId/me/avatar", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new HttpError("validation_failed", "Send the picture as the request body with Content-Type image/jpeg or image/png.");
    }
    const declared = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();
    const actual = sniff(req.body);
    if (!actual || actual !== declared || actual === "image/heic") throw new HttpError("validation_failed", "The file is not a valid JPEG or PNG picture.");
    // Make sure the person is a member before doing any image work.
    const membershipId = await inOrg(db, req, orgId, async (_tx, ctx) => ctx.membershipId);
    let small: Buffer;
    try {
      small = await sharp(req.body, { limitInputPixels: 50_000_000, failOn: "error", animated: false })
        .rotate()
        .resize({ width: AVATAR_EDGE, height: AVATAR_EDGE, fit: "cover" })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      throw new HttpError("validation_failed", "The picture could not be read.");
    }
    const key = avatarKey(orgId, membershipId);
    await storage.put(key, small, "image/jpeg");
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const { rows } = await tx.query<{ at: Date }>(
        "UPDATE organization_memberships SET avatar_storage_key = $2, avatar_updated_at = clock_timestamp() WHERE id = $1 RETURNING avatar_updated_at AS at",
        [ctx.membershipId, key],
      );
      await recordAudit(tx, ctx, "avatar.changed", "membership", ctx.membershipId);
      return { avatarAt: rows[0]!.at.toISOString() };
    });
  });

  app.delete("/v1/orgs/:orgId/me/avatar", async (req, reply) => {
    const { orgId } = parse(OrgParams, req.params);
    const key = await inOrg(db, req, orgId, (tx, ctx) => clearAvatar(tx, ctx, ctx.membershipId));
    if (key) await storage.delete(key);
    return reply.status(204).send();
  });

  // Team managers can take down someone's picture (for example, if it isn't appropriate).
  app.delete("/v1/orgs/:orgId/members/:membershipId/avatar", async (req, reply) => {
    const { orgId, membershipId } = parse(MemberParams, req.params);
    const key = await inOrg(db, req, orgId, async (tx, ctx) => {
      if (membershipId !== ctx.membershipId) ctx.require("members.manage");
      const { rowCount } = await tx.query("SELECT 1 FROM organization_memberships WHERE id = $1", [membershipId]);
      if (!rowCount) throw notFound();
      return clearAvatar(tx, ctx, membershipId);
    });
    if (key) await storage.delete(key);
    return reply.status(204).send();
  });

  app.get("/v1/orgs/:orgId/members/:membershipId/avatar", async (req, reply) => {
    const { orgId, membershipId } = parse(MemberParams, req.params);
    const key = await inOrg(db, req, orgId, async (tx) => {
      // Company walls: the database only shows memberships of this company.
      const { rows } = await tx.query<{ k: string | null }>("SELECT avatar_storage_key AS k FROM organization_memberships WHERE id = $1", [membershipId]);
      if (!rows[0]?.k) throw notFound();
      return rows[0].k;
    });
    const data = await storage.get(key);
    if (!data) throw notFound();
    return reply
      .header("content-type", "image/jpeg")
      .header("cache-control", "private, no-store")
      .header("cross-origin-resource-policy", "same-site")
      .send(data);
  });
}

async function clearAvatar(tx: Tx, ctx: OrgContext, membershipId: string): Promise<string | null> {
  const { rows } = await tx.query<{ k: string | null }>(
    `UPDATE organization_memberships m SET avatar_storage_key = NULL, avatar_updated_at = NULL
       FROM organization_memberships old WHERE m.id = $1 AND old.id = m.id
     RETURNING old.avatar_storage_key AS k`,
    [membershipId],
  );
  if (rows[0]?.k) await recordAudit(tx, ctx, "avatar.removed", "membership", membershipId, membershipId === ctx.membershipId ? {} : { byManager: true });
  return rows[0]?.k ?? null;
}
