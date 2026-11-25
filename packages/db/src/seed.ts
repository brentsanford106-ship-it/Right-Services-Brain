import type pg from "pg";
import { PERMISSIONS } from "@rsb/contracts";
import * as f from "../seed/fixtures.js";

/**
 * Loads SYNTHETIC demo data. Must run with the admin/owner connection
 * (local development and tests only). Refuses to run outside development/test.
 */
export async function seed(client: pg.ClientBase, appEnv: string): Promise<void> {
  if (appEnv !== "development" && appEnv !== "test") {
    throw new Error(`Refusing to load synthetic seed data when APP_ENV=${appEnv}`);
  }
  await client.query("BEGIN");
  try {
    for (const o of f.organizations) {
      await client.query("INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)", [o.id, o.name, o.slug]);
    }
    for (const u of f.users) {
      await client.query(
        "INSERT INTO users (id, idp_issuer, idp_subject, email, display_name, status) VALUES ($1, $2, $3, $4, $5, $6)",
        [u.id, f.DEV_AUTH_ISSUER, u.subject, u.email, u.displayName, u.status ?? "active"],
      );
    }

    const roleIds = new Map<string, string>(); // `${orgId}:${roleKey}` -> role id
    for (const o of f.organizations) {
      for (const [key, tpl] of Object.entries(f.ROLE_TEMPLATES)) {
        const { rows } = await client.query<{ id: string }>(
          "INSERT INTO roles (organization_id, key, name, is_system) VALUES ($1, $2, $3, true) RETURNING id",
          [o.id, key, tpl.name],
        );
        const roleId = rows[0]!.id;
        roleIds.set(`${o.id}:${key}`, roleId);
        for (const perm of tpl.permissions) {
          if (!(PERMISSIONS as readonly string[]).includes(perm)) throw new Error(`Unknown permission ${perm}`);
          await client.query(
            "INSERT INTO role_permissions (organization_id, role_id, permission_key) VALUES ($1, $2, $3)",
            [o.id, roleId, perm],
          );
        }
      }
    }

    for (const u of f.users) {
      for (const m of u.memberships) {
        await client.query(
          "INSERT INTO organization_memberships (id, organization_id, user_id, status, job_title) VALUES ($1, $2, $3, $4, $5)",
          [m.membershipId, m.orgId, u.id, m.status ?? "active", m.jobTitle],
        );
        await client.query(
          "INSERT INTO membership_roles (organization_id, membership_id, role_id) VALUES ($1, $2, $3)",
          [m.orgId, m.membershipId, roleIds.get(`${m.orgId}:${m.role}`)],
        );
      }
    }

    for (const c of f.customers) {
      await client.query(
        "INSERT INTO customers (id, organization_id, name, contact_name, contact_email, contact_phone) VALUES ($1, $2, $3, $4, $5, $6)",
        [c.id, c.orgId, c.name, c.contactName, c.contactEmail, c.contactPhone],
      );
    }
    for (const j of f.jobs) {
      await client.query(
        `INSERT INTO jobs (id, organization_id, customer_id, job_number, title, site_name, site_address, status, scheduled_start)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, DATE '2026-11-01')`,
        [j.id, j.orgId, j.customerId, j.jobNumber, j.title, j.siteName, j.siteAddress, j.status],
      );
      for (const membershipId of j.assigned) {
        await client.query("INSERT INTO job_assignments (organization_id, job_id, membership_id) VALUES ($1, $2, $3)", [
          j.orgId,
          j.id,
          membershipId,
        ]);
      }
    }
    for (const p of f.photos) {
      await client.query(
        `INSERT INTO photos (id, organization_id, job_id, content_type, stage, caption, captured_at, upload_status, uploaded_by_membership_id)
         VALUES ($1, $2, $3, 'image/jpeg', $4, $5, TIMESTAMPTZ '2026-11-02 15:00:00+00', 'pending', $6)`,
        [p.id, p.orgId, p.jobId, p.stage, p.caption, p.by],
      );
    }
    for (const pf of f.photoFlags) {
      await client.query(
        "INSERT INTO photo_flags (id, organization_id, photo_id, flagged_by_membership_id, reason) VALUES ($1, $2, $3, $4, $5)",
        [pf.id, pf.orgId, pf.photoId, pf.by, pf.reason],
      );
    }
    for (const r of f.receipts) {
      await client.query(
        `INSERT INTO receipts (id, organization_id, job_id, submitted_by_membership_id, vendor, amount_cents, purchased_on, category)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [r.id, r.orgId, r.jobId, r.by, r.vendor, r.amountCents, r.purchasedOn, r.category],
      );
    }
    for (const v of f.vehicles) {
      await client.query(
        `INSERT INTO vehicles (id, organization_id, unit_number, make, model, model_year, vin, license_plate, current_odometer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [v.id, v.orgId, v.unitNumber, v.make, v.model, v.modelYear, v.vin, v.plate, v.odometer],
      );
      for (const membershipId of v.assigned) {
        await client.query(
          "INSERT INTO vehicle_assignments (organization_id, vehicle_id, membership_id, starts_at) VALUES ($1, $2, $3, TIMESTAMPTZ '2026-10-01 00:00:00+00')",
          [v.orgId, v.id, membershipId],
        );
      }
    }
    for (const m of f.mileage) {
      await client.query(
        `INSERT INTO mileage_records (id, organization_id, vehicle_id, membership_id, job_id, trip_date, odometer_start, odometer_end, purpose)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [m.id, m.orgId, m.vehicleId, m.by, m.jobId, m.tripDate, m.start, m.end, m.purpose],
      );
    }
    for (const m of f.maintenance) {
      await client.query(
        `INSERT INTO maintenance_records (id, organization_id, vehicle_id, reported_by_membership_id, kind, description, odometer)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.id, m.orgId, m.vehicleId, m.by, m.kind, m.description, m.odometer],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
