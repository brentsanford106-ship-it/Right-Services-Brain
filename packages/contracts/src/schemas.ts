import { z } from "zod";

/**
 * Shared API contracts. Request schemas are STRICT: unknown fields are
 * rejected, so a client can never smuggle in organization_id, role, owner, or
 * similar fields. The organization always comes from the URL and is verified
 * against the caller's membership on the server.
 */

export const Uuid = z.uuid();
const Text = (max: number) => z.string().trim().min(1).max(max);
const OptionalText = (max: number) => z.string().trim().max(max).optional();
const IsoDate = z.iso.date();

// ---------------------------------------------------------------- errors
export const ErrorCode = z.enum([
  "unauthenticated",
  "forbidden",
  "not_found",
  "validation_failed",
  "conflict",
  "rate_limited",
  "payload_too_large",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.object({ path: z.string(), issue: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------------------------------------------------------------- params
export const OrgParams = z.strictObject({ orgId: Uuid });
export const JobParams = z.strictObject({ orgId: Uuid, jobId: Uuid });
export const PhotoParams = z.strictObject({ orgId: Uuid, photoId: Uuid });
export const FlagParams = z.strictObject({ orgId: Uuid, flagId: Uuid });
export const VehicleParams = z.strictObject({ orgId: Uuid, vehicleId: Uuid });

export const PageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------- me
export const MembershipSummary = z.object({
  organizationId: Uuid,
  organizationName: z.string(),
  membershipId: Uuid,
});
export const MeResponse = z.object({
  user: z.object({ id: Uuid, displayName: z.string(), email: z.string() }),
  memberships: z.array(MembershipSummary),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const OrgContextResponse = z.object({
  organization: z.object({ id: Uuid, name: z.string(), slug: z.string() }),
  membershipId: Uuid,
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
});
export type OrgContextResponse = z.infer<typeof OrgContextResponse>;

// ---------------------------------------------------------------- jobs
export const JobStatus = z.enum(["planned", "active", "on_hold", "completed", "cancelled"]);
export const Job = z.object({
  id: Uuid,
  jobNumber: z.string(),
  title: z.string(),
  status: JobStatus,
  siteName: z.string().nullable(),
  siteAddress: z.string().nullable(),
  customerName: z.string().nullable(),
  scheduledStart: z.string().nullable(),
  scheduledEnd: z.string().nullable(),
});
export type Job = z.infer<typeof Job>;

export const CreateJobRequest = z.strictObject({
  jobNumber: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, "letters, numbers, - and _ only"),
  title: Text(200),
  customerId: Uuid.optional(),
  siteName: OptionalText(200),
  siteAddress: OptionalText(500),
  status: JobStatus.default("planned"),
  scheduledStart: IsoDate.optional(),
  scheduledEnd: IsoDate.optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequest>;

export const CreateAssignmentRequest = z.strictObject({ membershipId: Uuid });

// ---------------------------------------------------------------- photos
export const PhotoStage = z.enum(["before", "during", "after", "issue", "other"]);
export const Photo = z.object({
  id: Uuid,
  jobId: Uuid,
  stage: PhotoStage,
  caption: z.string().nullable(),
  capturedAt: z.string(),
  uploadStatus: z.enum(["pending", "stored", "rejected"]),
  uploadedBy: z.string(),
  openFlags: z.number().int(),
});
export type Photo = z.infer<typeof Photo>;

/** Phase 1 records photo METADATA only. Binary upload (short-lived signed URL, server-side type sniffing, malware scan) is Phase 2. */
export const CreatePhotoRequest = z.strictObject({
  clientRef: Uuid,
  stage: PhotoStage,
  caption: OptionalText(500),
  capturedAt: z.iso.datetime({ offset: true }),
  contentType: z.enum(["image/jpeg", "image/png", "image/heic"]),
});
export type CreatePhotoRequest = z.infer<typeof CreatePhotoRequest>;

export const CreatePhotoFlagRequest = z.strictObject({ reason: Text(1000) });
export const ResolvePhotoFlagRequest = z.strictObject({ resolutionNote: OptionalText(1000) });

// ---------------------------------------------------------------- receipts
export const ReceiptCategory = z.enum(["materials", "fuel", "tools", "equipment_rental", "meals", "lodging", "permits", "other"]);
export const Receipt = z.object({
  id: Uuid,
  jobId: Uuid.nullable(),
  jobNumber: z.string().nullable(),
  vendor: z.string(),
  amountCents: z.number().int(),
  currency: z.string(),
  purchasedOn: z.string(),
  category: ReceiptCategory,
  status: z.enum(["submitted", "approved", "rejected"]),
  submittedBy: z.string(),
});
export type Receipt = z.infer<typeof Receipt>;

export const CreateReceiptRequest = z.strictObject({
  clientRef: Uuid,
  jobId: Uuid.optional(),
  vendor: Text(200),
  amountCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  purchasedOn: IsoDate,
  category: ReceiptCategory,
  notes: OptionalText(1000),
});
export type CreateReceiptRequest = z.infer<typeof CreateReceiptRequest>;

// ---------------------------------------------------------------- vehicles
export const Vehicle = z.object({
  id: Uuid,
  unitNumber: z.string(),
  make: z.string(),
  model: z.string(),
  modelYear: z.number().int().nullable(),
  licensePlate: z.string().nullable(),
  status: z.enum(["active", "in_shop", "retired"]),
  currentOdometer: z.number().int().nullable(),
  openIssues: z.number().int(),
});
export type Vehicle = z.infer<typeof Vehicle>;

export const CreateMileageRequest = z
  .strictObject({
    clientRef: Uuid,
    tripDate: IsoDate,
    odometerStart: z.number().int().min(0).max(10_000_000),
    odometerEnd: z.number().int().min(0).max(10_000_000),
    jobId: Uuid.optional(),
    purpose: OptionalText(300),
  })
  .refine((v) => v.odometerEnd >= v.odometerStart, { path: ["odometerEnd"], message: "must be at least odometerStart" });
export type CreateMileageRequest = z.infer<typeof CreateMileageRequest>;

export const CreateMaintenanceRequest = z.strictObject({
  clientRef: Uuid,
  kind: z.enum(["issue", "service"]),
  description: Text(2000),
  odometer: z.number().int().min(0).max(10_000_000).optional(),
});
export type CreateMaintenanceRequest = z.infer<typeof CreateMaintenanceRequest>;

// ---------------------------------------------------------------- members
export const Member = z.object({
  membershipId: Uuid,
  displayName: z.string(),
  jobTitle: z.string().nullable(),
  status: z.enum(["active", "suspended", "removed"]),
  roles: z.array(z.string()),
});
export type Member = z.infer<typeof Member>;

// ---------------------------------------------------------------- dashboard
export const DashboardResponse = z.object({
  activeJobs: z.number().int(),
  openPhotoFlags: z.number().int().nullable(),
  openMaintenanceIssues: z.number().int().nullable(),
  /** null when the caller lacks financials.read */
  receiptsTotalCents: z.number().int().nullable(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

// ---------------------------------------------------------------- audit
export const AuditEvent = z.object({
  id: Uuid,
  action: z.string(),
  outcome: z.enum(["success", "denied", "error"]),
  actorUserId: Uuid.nullable(),
  targetType: z.string().nullable(),
  targetId: Uuid.nullable(),
  occurredAt: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

// ---------------------------------------------------------------- dev auth
export const DevLoginRequest = z.strictObject({ subject: z.string().regex(/^dev-[a-z0-9-]{1,60}$/) });
export const DevLoginResponse = z.object({ accessToken: z.string(), expiresIn: z.number().int(), tokenType: z.literal("Bearer") });
export const DevUser = z.object({ subject: z.string(), displayName: z.string(), description: z.string() });
export type DevUser = z.infer<typeof DevUser>;
