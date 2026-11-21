/**
 * SYNTHETIC DEMONSTRATION DATA ONLY.
 * Every company, person, address, phone number, VIN and amount below is
 * fictional. Emails use the reserved example.com domain and phone numbers use
 * the reserved 555-01xx range. Never replace these with real records.
 */
import { DEV_AUTH_ISSUER, ROLE_TEMPLATES, type RoleKey } from "@rsb/contracts";

export const ORG_A = "0a000000-0000-4800-8000-000000000001";
export const ORG_B = "0b000000-0000-4800-8000-000000000002";

export interface SeedUser {
  id: string;
  subject: string;
  email: string;
  displayName: string;
  status?: "active" | "disabled";
  memberships: { orgId: string; membershipId: string; role: RoleKey; jobTitle: string; status?: "active" | "suspended" }[];
}

export const users: SeedUser[] = [
  {
    id: "00000000-0000-4a00-8000-00000000a001",
    subject: "dev-avery-owner",
    email: "avery.owner@harborpine.example.com",
    displayName: "Avery Owner",
    memberships: [{ orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000a001", role: "owner", jobTitle: "Owner" }],
  },
  {
    id: "00000000-0000-4a00-8000-00000000a002",
    subject: "dev-morgan-manager",
    email: "morgan.manager@harborpine.example.com",
    displayName: "Morgan Manager",
    memberships: [{ orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000a002", role: "manager", jobTitle: "Field Manager" }],
  },
  {
    id: "00000000-0000-4a00-8000-00000000a003",
    subject: "dev-eli-employee",
    email: "eli.employee@harborpine.example.com",
    displayName: "Eli Employee",
    memberships: [{ orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000a003", role: "employee", jobTitle: "Technician" }],
  },
  {
    id: "00000000-0000-4a00-8000-00000000a004",
    subject: "dev-ezra-field",
    email: "ezra.field@harborpine.example.com",
    displayName: "Ezra Field",
    memberships: [{ orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000a004", role: "employee", jobTitle: "Technician" }],
  },
  {
    id: "00000000-0000-4a00-8000-00000000a005",
    subject: "dev-sam-suspended",
    email: "sam.suspended@harborpine.example.com",
    displayName: "Sam Suspended",
    memberships: [
      { orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000a005", role: "employee", jobTitle: "Former Technician", status: "suspended" },
    ],
  },
  {
    id: "00000000-0000-4a00-8000-00000000a006",
    subject: "dev-dana-disabled",
    email: "dana.disabled@harborpine.example.com",
    displayName: "Dana Disabled",
    status: "disabled",
    memberships: [{ orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000a006", role: "manager", jobTitle: "Manager (offboarded)" }],
  },
  {
    id: "00000000-0000-4a00-8000-00000000b001",
    subject: "dev-riley-owner",
    email: "riley.owner@redstone.example.com",
    displayName: "Riley Owner",
    memberships: [{ orgId: ORG_B, membershipId: "00000000-0000-4b00-8000-00000000b001", role: "owner", jobTitle: "Owner" }],
  },
  {
    id: "00000000-0000-4a00-8000-00000000b002",
    subject: "dev-blake-employee",
    email: "blake.employee@redstone.example.com",
    displayName: "Blake Employee",
    memberships: [{ orgId: ORG_B, membershipId: "00000000-0000-4b00-8000-00000000b002", role: "employee", jobTitle: "Installer" }],
  },
  {
    // Belongs to BOTH companies with different roles: used to prove a role in one
    // organization grants nothing in the other.
    id: "00000000-0000-4a00-8000-00000000c001",
    subject: "dev-casey-both",
    email: "casey.contractor@example.com",
    displayName: "Casey Contractor",
    memberships: [
      { orgId: ORG_A, membershipId: "00000000-0000-4b00-8000-00000000c0a1", role: "employee", jobTitle: "Subcontractor" },
      { orgId: ORG_B, membershipId: "00000000-0000-4b00-8000-00000000c0b1", role: "manager", jobTitle: "Site Lead" },
    ],
  },
];

export const organizations = [
  { id: ORG_A, name: "Harbor Pine Construction (DEMO)", slug: "harbor-pine-demo" },
  { id: ORG_B, name: "Redstone Site Services (DEMO)", slug: "redstone-demo" },
];

export const customers = [
  { id: "00000000-0000-4c00-8000-00000000a001", orgId: ORG_A, name: "Demo Fuel Mart #12", contactName: "Pat Example", contactEmail: "pat@fuelmart.example.com", contactPhone: "555-0100" },
  { id: "00000000-0000-4c00-8000-00000000a002", orgId: ORG_A, name: "Sample Gas & Go", contactName: "Jordan Sample", contactEmail: "jordan@gasandgo.example.com", contactPhone: "555-0101" },
  { id: "00000000-0000-4c00-8000-00000000b001", orgId: ORG_B, name: "Fictional Petro Stop", contactName: "Lee Fiction", contactEmail: "lee@petrostop.example.com", contactPhone: "555-0150" },
];

export const jobs = [
  { id: "00000000-0000-4d00-8000-00000000a001", orgId: ORG_A, customerId: "00000000-0000-4c00-8000-00000000a001", jobNumber: "HP-1001", title: "Canopy LED retrofit", siteName: "Demo Fuel Mart #12", siteAddress: "100 Example Rd, Demo City", status: "active", assigned: ["00000000-0000-4b00-8000-00000000a003", "00000000-0000-4b00-8000-00000000c0a1"] },
  { id: "00000000-0000-4d00-8000-00000000a002", orgId: ORG_A, customerId: "00000000-0000-4c00-8000-00000000a002", jobNumber: "HP-1002", title: "Dispenser island concrete repair", siteName: "Sample Gas & Go", siteAddress: "200 Sample Ave, Demo City", status: "planned", assigned: ["00000000-0000-4b00-8000-00000000a004"] },
  { id: "00000000-0000-4d00-8000-00000000a003", orgId: ORG_A, customerId: "00000000-0000-4c00-8000-00000000a001", jobNumber: "HP-1003", title: "Underground tank inspection prep", siteName: "Demo Fuel Mart #12", siteAddress: "100 Example Rd, Demo City", status: "on_hold", assigned: [] },
  { id: "00000000-0000-4d00-8000-00000000b001", orgId: ORG_B, customerId: "00000000-0000-4c00-8000-00000000b001", jobNumber: "RS-2001", title: "Signage replacement", siteName: "Fictional Petro Stop", siteAddress: "300 Fiction Blvd, Sampletown", status: "active", assigned: ["00000000-0000-4b00-8000-00000000b002", "00000000-0000-4b00-8000-00000000c0b1"] },
  // Same job number pattern as org A on purpose: numbers are unique per organization only.
  { id: "00000000-0000-4d00-8000-00000000b002", orgId: ORG_B, customerId: null, jobNumber: "HP-1001", title: "Internal yard cleanup", siteName: "Redstone yard", siteAddress: null, status: "planned", assigned: [] },
] as const;

export const photos = [
  { id: "00000000-0000-4e00-8000-00000000a001", orgId: ORG_A, jobId: jobs[0].id, stage: "before", caption: "Canopy before retrofit (synthetic)", by: "00000000-0000-4b00-8000-00000000a003" },
  { id: "00000000-0000-4e00-8000-00000000a002", orgId: ORG_A, jobId: jobs[0].id, stage: "after", caption: "Canopy after retrofit (synthetic)", by: "00000000-0000-4b00-8000-00000000a003" },
  { id: "00000000-0000-4e00-8000-00000000a003", orgId: ORG_A, jobId: jobs[1].id, stage: "issue", caption: "Cracked slab near pump 3 (synthetic)", by: "00000000-0000-4b00-8000-00000000a004" },
  { id: "00000000-0000-4e00-8000-00000000b001", orgId: ORG_B, jobId: jobs[3].id, stage: "before", caption: "Old sign (synthetic)", by: "00000000-0000-4b00-8000-00000000b002" },
] as const;

export const photoFlags = [
  { id: "00000000-0000-4e10-8000-00000000a001", orgId: ORG_A, photoId: photos[2].id, by: "00000000-0000-4b00-8000-00000000a004", reason: "Possible trip hazard; needs manager review" },
];

export const receipts = [
  { id: "00000000-0000-4f00-8000-00000000a001", orgId: ORG_A, jobId: jobs[0].id, by: "00000000-0000-4b00-8000-00000000a003", vendor: "Example Electric Supply", amountCents: 48250, purchasedOn: "2026-11-02", category: "materials" },
  { id: "00000000-0000-4f00-8000-00000000a002", orgId: ORG_A, jobId: null, by: "00000000-0000-4b00-8000-00000000a004", vendor: "Demo Fuel Co.", amountCents: 7315, purchasedOn: "2026-11-03", category: "fuel" },
  { id: "00000000-0000-4f00-8000-00000000b001", orgId: ORG_B, jobId: jobs[3].id, by: "00000000-0000-4b00-8000-00000000b002", vendor: "Sample Sign Shop", amountCents: 120000, purchasedOn: "2026-11-04", category: "materials" },
] as const;

export const vehicles = [
  { id: "00000000-0000-4900-8000-00000000a001", orgId: ORG_A, unitNumber: "HP-T1", make: "DemoMotors", model: "Utility 2500", modelYear: 2022, vin: "1HGBH41JXMN109186", plate: "DEMO 101", odometer: 48210, assigned: ["00000000-0000-4b00-8000-00000000a003"] },
  { id: "00000000-0000-4900-8000-00000000a002", orgId: ORG_A, unitNumber: "HP-T2", make: "DemoMotors", model: "Crew Van", modelYear: 2020, vin: null, plate: "DEMO 102", odometer: 91033, assigned: ["00000000-0000-4b00-8000-00000000a004"] },
  { id: "00000000-0000-4900-8000-00000000b001", orgId: ORG_B, unitNumber: "RS-01", make: "SampleTruck", model: "Box 16", modelYear: 2021, vin: null, plate: "SAMPLE 1", odometer: 30500, assigned: ["00000000-0000-4b00-8000-00000000b002"] },
] as const;

export const mileage = [
  { id: "00000000-0000-4910-8000-00000000a001", orgId: ORG_A, vehicleId: vehicles[0].id, by: "00000000-0000-4b00-8000-00000000a003", jobId: jobs[0].id, tripDate: "2026-11-02", start: 48150, end: 48210, purpose: "Shop to HP-1001 and back" },
];

export const maintenance = [
  { id: "00000000-0000-4920-8000-00000000a001", orgId: ORG_A, vehicleId: vehicles[1].id, by: "00000000-0000-4b00-8000-00000000a004", kind: "issue", description: "Check engine light on (synthetic)", odometer: 91000 },
];

export { DEV_AUTH_ISSUER, ROLE_TEMPLATES };
