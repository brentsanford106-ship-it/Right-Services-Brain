import type pg from "pg";
import { PERMISSIONS, ROLE_TEMPLATES } from "@rsb/contracts";

export interface SetupPerson {
  email: string;
  displayName: string;
}

/**
 * Creates a REAL company (with the Owner / Manager / Employee roles) and adds its first owners by email.
 * Nobody gets an account here: each owner signs in with Microsoft using that email and presses Accept
 * (see app.respond_to_invite). The invite works for 14 days; running the tool again renews an expired one.
 *
 * Company walls: a company whose name matches an existing one (same web-address name, e.g. "Acme Co" and
 * "ACME, Co.") is NEVER reused silently, because that would make the new owners owners of someone else's company.
 * To add owners to an existing company on purpose, pass `{ addToExisting: true }` (CLI: --add-to-existing);
 * then an email that already has an open invite or membership is skipped, so running it again is safe.
 *
 * Runs with the database admin connection, so only someone with the admin password (Azure Key Vault) can run it.
 */
export class CompanyExistsError extends Error {}

export async function setupCompany(
  client: pg.ClientBase,
  name: string,
  owners: SetupPerson[],
  opts: { addToExisting?: boolean } = {},
): Promise<{ orgId: string; created: boolean; invited: string[] }> {
  const cleanName = name.trim();
  if (cleanName.length < 2 || cleanName.length > 200) throw new Error("Company name must be 2 to 200 characters.");
  if (owners.length === 0) throw new Error("Add at least one owner (--owner email:Name).");
  for (const o of owners) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email) || o.email.length > 320) throw new Error(`Not a valid email address: ${o.email}`);
    if (!o.displayName.trim()) throw new Error(`Missing a name for ${o.email}`);
  }
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "company";

  await client.query("BEGIN");
  try {
    let created = false;
    let { rows } = await client.query<{ id: string; name: string }>("SELECT id, name FROM organizations WHERE slug = $1", [slug]);
    if (rows[0] && !opts.addToExisting) {
      throw new CompanyExistsError(
        `A company called "${rows[0].name}" already exists (${rows[0].id}). Nothing was changed. ` +
          "To add these owners to THAT company, run again with --add-to-existing. For a different company, use a different name.",
      );
    }
    if (!rows[0]) {
      ({ rows } = await client.query<{ id: string; name: string }>("INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name", [cleanName, slug]));
      created = true;
    }
    const orgId = rows[0]!.id;

    for (const [key, tpl] of Object.entries(ROLE_TEMPLATES)) {
      const existing = await client.query<{ id: string }>("SELECT id FROM roles WHERE organization_id = $1 AND key = $2", [orgId, key]);
      if (existing.rows[0]) continue;
      const { rows: r } = await client.query<{ id: string }>(
        "INSERT INTO roles (organization_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id",
        [orgId, key, tpl.name],
      );
      for (const perm of tpl.permissions) {
        if (!(PERMISSIONS as readonly string[]).includes(perm)) throw new Error(`Unknown permission ${perm}`);
        await client.query("INSERT INTO role_permissions (organization_id, role_id, permission_key) VALUES ($1, $2, $3)", [orgId, r[0]!.id, perm]);
      }
    }
    const { rows: ownerRole } = await client.query<{ id: string }>("SELECT id FROM roles WHERE organization_id = $1 AND key = 'owner'", [orgId]);

    const invited: string[] = [];
    for (const o of owners) {
      const email = o.email.trim().toLowerCase();
      // An expired or declined invite doesn't count: running the tool again sends a fresh one.
      await client.query(
        `UPDATE member_invites SET revoked_at = now() WHERE organization_id = $1 AND email = $2::citext
            AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL AND expires_at <= now()`,
        [orgId, email],
      );
      const { rows: already } = await client.query(
        `SELECT 1 FROM member_invites WHERE organization_id = $1 AND email = $2::citext AND accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL
         UNION ALL
         SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND u.email = $2::citext AND m.status <> 'removed'`,
        [orgId, email],
      );
      if (already.length > 0) continue;
      const { rows: inv } = await client.query<{ id: string }>(
        "INSERT INTO member_invites (organization_id, email, display_name, job_title, role_ids) VALUES ($1, $2, $3, 'Owner', ARRAY[$4::uuid]) RETURNING id",
        [orgId, email, o.displayName.trim(), ownerRole[0]!.id],
      );
      await client.query(
        "INSERT INTO audit_events (organization_id, action, outcome, target_type, target_id, metadata) VALUES ($1, 'member.invited', 'success', 'invite', $2, $3)",
        [orgId, inv[0]!.id, JSON.stringify({ by: "setup-tool", roleIds: [ownerRole[0]!.id] })],
      );
      invited.push(email);
    }
    await client.query("COMMIT");
    return { orgId, created, invited };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

/** Reads `--owner "email:Full Name"` arguments. */
export function parseOwners(args: string[]): SetupPerson[] {
  const out: SetupPerson[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--owner") continue;
    const v = args[i + 1] ?? "";
    const at = v.indexOf(":");
    out.push(at > 0 ? { email: v.slice(0, at).trim(), displayName: v.slice(at + 1).trim() } : { email: v.trim(), displayName: "" });
  }
  return out;
}
