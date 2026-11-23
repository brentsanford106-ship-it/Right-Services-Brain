import type { Tx } from "./db.js";
import { HttpError } from "./errors.js";

type IdempotentTable = "photos" | "photo_comments" | "photo_markups" | "receipts" | "mileage_records" | "maintenance_records";
const OWNER_COLUMN: Record<IdempotentTable, string> = {
  photos: "uploaded_by_membership_id",
  photo_comments: "author_membership_id",
  photo_markups: "author_membership_id",
  receipts: "submitted_by_membership_id",
  mileage_records: "membership_id",
  maintenance_records: "reported_by_membership_id",
};

/**
 * Offline submissions carry a device-generated clientRef. Re-sending the same
 * submission (e.g. after a dropped connection) returns the original record
 * instead of creating a duplicate. A clientRef that belongs to someone else's
 * record is rejected with 409 and reveals nothing about that record.
 *
 * `insertSql` must be an INSERT ... ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id.
 */
export async function insertIdempotent(
  tx: Tx,
  table: IdempotentTable,
  clientRef: string,
  membershipId: string,
  insertSql: string,
  params: unknown[],
): Promise<{ id: string; created: boolean }> {
  const { rows } = await tx.query<{ id: string }>(insertSql, params);
  if (rows[0]) return { id: rows[0].id, created: true };
  // Table and column names are fixed constants above, never user input.
  const { rows: existing } = await tx.query<{ id: string; owner: string }>(
    `SELECT id, ${OWNER_COLUMN[table]} AS owner FROM ${table} WHERE client_ref = $1`,
    [clientRef],
  );
  const row = existing[0];
  if (!row || row.owner !== membershipId) throw new HttpError("conflict", "This submission id has already been used.");
  return { id: row.id, created: false };
}
