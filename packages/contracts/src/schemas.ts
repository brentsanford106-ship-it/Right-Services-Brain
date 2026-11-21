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

export const UpdateJobRequest = z
  .strictObject({
    title: Text(200).optional(),
    siteName: z.string().trim().max(200).nullable().optional(),
    siteAddress: z.string().trim().max(500).nullable().optional(),
    status: JobStatus.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });
export type UpdateJobRequest = z.infer<typeof UpdateJobRequest>;

export const JobListQuery = z.strictObject({
  /** Matches job number, job name, or site name. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const CreateAssignmentRequest = z.strictObject({ membershipId: Uuid });

// ---------------------------------------------------------------- photos
export const PhotoStage = z.enum(["before", "during", "after", "issue", "other"]);
/** Categories offered when taking photos. ("issue"/"other" exist only for older records.) */
export const CaptureStage = z.enum(["before", "during", "after"]);

/** Flag/unflag, edit note, or recategorise a photo. Works for queued offline edits too. */
export const UpdatePhotoRequest = z
  .strictObject({
    flagged: z.boolean().optional(),
    note: z.string().trim().max(2000).nullable().optional(),
    stage: CaptureStage.optional(),
  })
  .refine((v) => v.flagged !== undefined || v.note !== undefined || v.stage !== undefined, { message: "nothing to update" });
export type UpdatePhotoRequest = z.infer<typeof UpdatePhotoRequest>;
export const Photo = z.object({
  id: Uuid,
  jobId: Uuid,
  jobNumber: z.string(),
  siteName: z.string().nullable(),
  stage: PhotoStage,
  note: z.string().nullable(),
  flagged: z.boolean(),
  flaggedAt: z.string().nullable(),
  capturedAt: z.string(),
  uploadStatus: z.enum(["pending", "stored", "rejected"]),
  uploadedBy: z.string(),
  openFlags: z.number().int(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  widthPx: z.number().int().nullable(),
  heightPx: z.number().int().nullable(),
  hasPreview: z.boolean(),
  storedAt: z.string().nullable(),
});
export type Photo = z.infer<typeof Photo>;

/**
 * Step 1 of an upload: record the photo's details. Step 2 sends the image bytes
 * to PUT /photos/:photoId/content. Splitting the two lets the phone queue both
 * steps offline and retry each safely.
 */
export const CreatePhotoRequest = z
  .strictObject({
    clientRef: Uuid,
    stage: CaptureStage,
    note: OptionalText(2000),
    flagged: z.boolean().default(false),
    capturedAt: z.iso.datetime({ offset: true }),
    contentType: z.enum(["image/jpeg", "image/png", "image/heic"]),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    locationAccuracyM: z.number().min(0).max(100_000).optional(),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    path: ["longitude"],
    message: "latitude and longitude must be sent together",
  });
export type CreatePhotoRequest = z.infer<typeof CreatePhotoRequest>;

export const PHOTO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Photo files are downloaded only through authenticated API requests
 * (Authorization header required on every download). There are no bearer
 * URLs: a copied link without the caller's token returns 401.
 */
export const PhotoContentQuery = z.strictObject({ variant: z.enum(["preview", "original"]).default("preview") });

/** Search/recall photos. All filters are optional and combine with AND. */
export const PhotoSearchQuery = z
  .strictObject({
    jobNumber: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/).optional(),
    site: z.string().trim().min(2).max(100).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusM: z.coerce.number().min(10).max(50_000).default(500),
    stage: PhotoStage.optional(),
    flagged: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), { path: ["lng"], message: "lat and lng must be sent together" })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { path: ["to"], message: "must be on or after from" });
export type PhotoSearchQuery = z.input<typeof PhotoSearchQuery>;

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
  photosLast7Days: z.number().int(),
  flaggedPhotos: z.number().int(),
  /** Photo records whose file hasn't arrived yet (still on someone's phone). */
  photosAwaitingUpload: z.number().int(),
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
