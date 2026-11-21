import type { FastifyInstance } from "fastify";
import { CreateMaintenanceRequest, CreateMileageRequest, OrgParams, VehicleParams, type Vehicle } from "@rsb/contracts";
import { inOrg } from "../lib/context.js";
import { parse } from "../lib/validate.js";
import { assertJobAccess, assertVehicleAccess, vehicleVisibilitySql } from "../lib/access.js";
import { recordAudit } from "../lib/audit.js";
import { insertIdempotent } from "../lib/idempotency.js";
import { notFound } from "../lib/errors.js";
import type { RouteDeps } from "./index.js";

interface VehicleRow {
  id: string;
  unit_number: string;
  make: string;
  model: string;
  model_year: number | null;
  license_plate: string | null;
  status: Vehicle["status"];
  current_odometer: number | null;
  open_issues: number;
}

const VEHICLE_SELECT = `SELECT v.id, v.unit_number, v.make, v.model, v.model_year, v.license_plate, v.status, v.current_odometer,
                               (SELECT count(*)::int FROM maintenance_records mr
                                 WHERE mr.organization_id = v.organization_id AND mr.vehicle_id = v.id
                                   AND mr.kind = 'issue' AND mr.status <> 'done' AND mr.deleted_at IS NULL) AS open_issues
                          FROM vehicles v`;

const toVehicle = (r: VehicleRow): Vehicle => ({
  id: r.id,
  unitNumber: r.unit_number,
  make: r.make,
  model: r.model,
  modelYear: r.model_year,
  licensePlate: r.license_plate,
  status: r.status,
  currentOdometer: r.current_odometer,
  openIssues: r.open_issues,
});

export async function vehicleRoutes(app: FastifyInstance, { db }: RouteDeps): Promise<void> {
  app.get("/v1/orgs/:orgId/vehicles", async (req) => {
    const { orgId } = parse(OrgParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      const { rows } = await tx.query<VehicleRow>(
        `${VEHICLE_SELECT} WHERE v.deleted_at IS NULL AND (${vehicleVisibilitySql(ctx)}) ORDER BY v.unit_number`,
        [ctx.membershipId],
      );
      return { items: rows.map(toVehicle) };
    });
  });

  app.get("/v1/orgs/:orgId/vehicles/:vehicleId", async (req) => {
    const { orgId, vehicleId } = parse(VehicleParams, req.params);
    return inOrg(db, req, orgId, async (tx, ctx) => {
      await assertVehicleAccess(tx, ctx, vehicleId);
      const { rows } = await tx.query<VehicleRow>(`${VEHICLE_SELECT} WHERE v.id = $1`, [vehicleId]);
      if (!rows[0]) throw notFound();
      // Members see all mileage only with mileage.read_all; otherwise just their own trips.
      const ownOnly = !ctx.has("mileage.read_all");
      const { rows: trips } = await tx.query<{ id: string; trip_date: string; odometer_start: number; odometer_end: number; purpose: string | null }>(
        `SELECT id, trip_date, odometer_start, odometer_end, purpose FROM mileage_records
          WHERE vehicle_id = $1 AND deleted_at IS NULL AND ($2::boolean = false OR membership_id = $3)
          ORDER BY trip_date DESC LIMIT 50`,
        [vehicleId, ownOnly, ctx.membershipId],
      );
      const { rows: maint } = await tx.query<{ id: string; kind: string; description: string; status: string; created_at: Date }>(
        `SELECT id, kind, description, status, created_at FROM maintenance_records
          WHERE vehicle_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`,
        [vehicleId],
      );
      return {
        ...toVehicle(rows[0]),
        mileage: trips.map((t) => ({ id: t.id, tripDate: t.trip_date, odometerStart: t.odometer_start, odometerEnd: t.odometer_end, purpose: t.purpose })),
        maintenance: maint.map((m) => ({ id: m.id, kind: m.kind, description: m.description, status: m.status, createdAt: m.created_at.toISOString() })),
      };
    });
  });

  app.post("/v1/orgs/:orgId/vehicles/:vehicleId/mileage", async (req, reply) => {
    const { orgId, vehicleId } = parse(VehicleParams, req.params);
    const body = parse(CreateMileageRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("mileage.submit");
      await assertVehicleAccess(tx, ctx, vehicleId);
      if (body.jobId) await assertJobAccess(tx, ctx, body.jobId);
      const r = await insertIdempotent(
        tx, "mileage_records", body.clientRef, ctx.membershipId,
        `INSERT INTO mileage_records (organization_id, vehicle_id, membership_id, job_id, trip_date, odometer_start, odometer_end, purpose, client_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, vehicleId, ctx.membershipId, body.jobId ?? null, body.tripDate, body.odometerStart, body.odometerEnd, body.purpose ?? null, body.clientRef],
      );
      if (r.created) await recordAudit(tx, ctx, "mileage.submitted", "mileage_record", r.id, { vehicleId });
      return r;
    });
    return reply.status(result.created ? 201 : 200).send({ id: result.id });
  });

  app.post("/v1/orgs/:orgId/vehicles/:vehicleId/maintenance", async (req, reply) => {
    const { orgId, vehicleId } = parse(VehicleParams, req.params);
    const body = parse(CreateMaintenanceRequest, req.body);
    const result = await inOrg(db, req, orgId, async (tx, ctx) => {
      ctx.require("maintenance.report");
      await assertVehicleAccess(tx, ctx, vehicleId);
      const r = await insertIdempotent(
        tx, "maintenance_records", body.clientRef, ctx.membershipId,
        `INSERT INTO maintenance_records (organization_id, vehicle_id, reported_by_membership_id, kind, description, odometer, client_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (organization_id, client_ref) DO NOTHING RETURNING id`,
        [ctx.orgId, vehicleId, ctx.membershipId, body.kind, body.description, body.odometer ?? null, body.clientRef],
      );
      if (r.created) await recordAudit(tx, ctx, "maintenance.reported", "maintenance_record", r.id, { vehicleId });
      return r;
    });
    return reply.status(result.created ? 201 : 200).send({ id: result.id });
  });
}
