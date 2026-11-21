import type { DevUser } from "@rsb/contracts";

/**
 * Synthetic users offered on the DEVELOPMENT login screen. Must match the
 * seed fixtures (a test checks this). Includes deliberately broken accounts so
 * the rejection paths can be demonstrated.
 */
export const DEV_LOGIN_USERS: DevUser[] = [
  { subject: "dev-avery-owner", displayName: "Avery Owner", description: "Owner, Harbor Pine (DEMO)" },
  { subject: "dev-morgan-manager", displayName: "Morgan Manager", description: "Manager, Harbor Pine (DEMO)" },
  { subject: "dev-eli-employee", displayName: "Eli Employee", description: "Employee, Harbor Pine (DEMO): assigned HP-1001, truck HP-T1" },
  { subject: "dev-ezra-field", displayName: "Ezra Field", description: "Employee, Harbor Pine (DEMO): assigned HP-1002, van HP-T2" },
  { subject: "dev-riley-owner", displayName: "Riley Owner", description: "Owner, Redstone (DEMO)" },
  { subject: "dev-blake-employee", displayName: "Blake Employee", description: "Employee, Redstone (DEMO)" },
  { subject: "dev-casey-both", displayName: "Casey Contractor", description: "Employee at Harbor Pine AND Manager at Redstone" },
  { subject: "dev-sam-suspended", displayName: "Sam Suspended", description: "Suspended membership: should see no company data" },
  { subject: "dev-dana-disabled", displayName: "Dana Disabled", description: "Disabled account: sign-in should be refused" },
];
