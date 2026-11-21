/**
 * Granular permissions. The database catalog (migration 0005) must match this
 * list exactly; a test enforces it. Roles are bundles of these permissions.
 * Authorization is always decided on the server; clients may use this list
 * only to hide buttons, never to grant access.
 */
export const PERMISSIONS = [
  "org.read",
  "org.manage",
  "members.read",
  "members.manage",
  "customers.read",
  "customers.manage",
  "jobs.read_all",
  "jobs.read_assigned",
  "jobs.manage",
  "job_assignments.manage",
  "photos.upload",
  "photo_flags.create",
  "photo_flags.manage",
  "receipts.submit",
  "receipts.read_own",
  "receipts.read_all",
  "financials.read",
  "vehicles.read_all",
  "vehicles.read_assigned",
  "vehicles.manage",
  "mileage.submit",
  "mileage.read_all",
  "maintenance.report",
  "maintenance.manage",
  "audit.read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type RoleKey = "owner" | "manager" | "employee";

/**
 * Default role templates copied into each new organization.
 * Based on the Phase 1 requirements. Items marked "assumption" in
 * docs/REQUIREMENTS.md need confirmation from the business.
 */
export const ROLE_TEMPLATES: Record<RoleKey, { name: string; permissions: readonly Permission[] }> = {
  owner: { name: "Organization Owner", permissions: PERMISSIONS },
  manager: {
    name: "Manager",
    permissions: [
      "org.read",
      "members.read",
      "customers.read",
      "jobs.read_all",
      "jobs.manage",
      "job_assignments.manage",
      "photos.upload",
      "photo_flags.create",
      "photo_flags.manage",
      "receipts.submit",
      "receipts.read_own",
      "vehicles.read_all",
      "vehicles.manage",
      "mileage.submit",
      "mileage.read_all",
      "maintenance.report",
      "maintenance.manage",
    ],
  },
  employee: {
    name: "Employee",
    permissions: [
      "org.read",
      "jobs.read_assigned",
      "photos.upload",
      "photo_flags.create",
      "receipts.submit",
      "receipts.read_own",
      "vehicles.read_assigned",
      "mileage.submit",
      "maintenance.report",
    ],
  },
};
