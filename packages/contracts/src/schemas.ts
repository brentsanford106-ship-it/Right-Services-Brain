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
/** A company that added this person by email. They join only when they press Accept. */
export const PendingInvite = z.object({
  inviteId: Uuid,
  organizationId: Uuid,
  organizationName: z.string(),
  roles: z.array(z.string()),
  invitedBy: z.string(),
  expiresAt: z.string(),
});
export type PendingInvite = z.infer<typeof PendingInvite>;
export const MeResponse = z.object({
  user: z.object({ id: Uuid, displayName: z.string(), email: z.string() }),
  memberships: z.array(MembershipSummary),
  /** Invites waiting for Accept or Decline. */
  invites: z.array(PendingInvite),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const OrgContextResponse = z.object({
  organization: z.object({ id: Uuid, name: z.string(), slug: z.string() }),
  membershipId: Uuid,
  roles: z.array(z.string()),
  permissions: z.array(z.string()),
  /** People must sign in again after this many days (real sign-in; enforced by the apps when online). */
  signInEveryDays: z.number().int(),
  /** Your display name and profile picture in this company (null = none, initials are shown). */
  displayName: z.string(),
  avatarAt: z.string().nullable(),
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
  /** Name of the person who uploaded the photo. */
  uploadedBy: z.string(),
  /** The person who took the photo. null = unknown (e.g. an imported photo). Kept after they leave the company. */
  photographerId: Uuid.nullable(),
  photographer: z.string().nullable(),
  /** True when the person asking took this photo ("Photos I took"). */
  takenByMe: z.boolean(),
  /** True when the person asking uploaded this photo (they may edit and delete their own uploads). */
  uploadedByMe: z.boolean(),
  /** How the photo got into the app. */
  captureSource: z.enum(["in_app_camera", "imported", "web_upload"]),
  /** false = the file had no "date taken"; capturedAt is when it was added to the app. */
  capturedAtKnown: z.boolean(),
  /** When the photographer last changed their profile picture; null = no picture (show initials). */
  photographerAvatarAt: z.string().nullable(),
  openFlags: z.number().int(),
  /** Comments and replies that are not deleted. */
  commentCount: z.number().int(),
  lastCommentAt: z.string().nullable(),
  /** Marks drawn on the photo (not removed). */
  markupCount: z.number().int(),
  /** Issues on this photo that aren't resolved yet ("To fix"). */
  openIssueCount: z.number().int(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  widthPx: z.number().int().nullable(),
  heightPx: z.number().int().nullable(),
  hasPreview: z.boolean(),
  storedAt: z.string().nullable(),
  /** Whether the person asking may delete this photo (own photo, or photos.delete_any). For hiding buttons only. */
  canDelete: z.boolean(),
});
export type Photo = z.infer<typeof Photo>;

export const PhotoIdsRequest = z.strictObject({ photoIds: z.array(Uuid).min(1).max(200) });
export type PhotoIdsRequest = z.infer<typeof PhotoIdsRequest>;
export const ExportPhotosRequest = PhotoIdsRequest.extend({ channel: z.enum(["share_sheet", "download"]) });
export type ExportPhotosRequest = z.infer<typeof ExportPhotosRequest>;

export const DeletedPhoto = Photo.extend({
  deletedAt: z.string(),
  deletedBy: z.string(),
  /** When the scheduled clean-up will remove it for good (company setting, Settings > Recently Deleted). */
  purgeAfter: z.string(),
});
export type DeletedPhoto = z.infer<typeof DeletedPhoto>;

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
    /** "imported" = added from the phone's photo library (needs photos.import). Default: taken in the app's camera. */
    captureSource: z.enum(["in_app_camera", "imported"]).default("in_app_camera"),
    /** Imported photos only: false when the file had no "date taken" and capturedAt is just when it was added. */
    capturedAtKnown: z.boolean().default(true),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    locationAccuracyM: z.number().min(0).max(100_000).optional(),
  })
  .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), {
    path: ["longitude"],
    message: "latitude and longitude must be sent together",
  })
  .refine((v) => v.captureSource === "imported" || v.capturedAtKnown, {
    path: ["capturedAtKnown"],
    message: "photos taken in the app always know when they were taken",
  });
export type CreatePhotoRequest = z.infer<typeof CreatePhotoRequest>;

export const PHOTO_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Photo files are downloaded only through authenticated API requests
 * (Authorization header required on every download). There are no bearer
 * URLs: a copied link without the caller's token returns 401.
 */
/** "annotated": a copy with the drawings burned in, made on request for sharing (the stored photo never changes). */
export const PhotoContentQuery = z.strictObject({ variant: z.enum(["thumb", "preview", "original", "annotated"]).default("preview") });

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

// ---------------------------------------------------------------- photo comments (step 2)
export const CommentParams = z.strictObject({ orgId: Uuid, commentId: Uuid });
export const COMMENT_MAX = 2000;
const CommentBody = z.string().trim().min(1, "write something").max(COMMENT_MAX);
export const CreatePhotoCommentRequest = z.strictObject({
  /** Made on the phone so a comment sent twice (weak signal) is only saved once. */
  clientRef: Uuid,
  body: CommentBody,
  /** Reply to this top-level comment. Replies are one level deep. */
  parentId: Uuid.nullable().optional(),
  /** People @mentioned. Each must be someone who can see the job. */
  mentionIds: z.array(Uuid).max(20).default([]),
  /** Comment on one mark drawn on this photo. */
  markupId: Uuid.nullable().optional(),
});
export type CreatePhotoCommentRequest = z.infer<typeof CreatePhotoCommentRequest>;
export const UpdatePhotoCommentRequest = z.strictObject({ body: CommentBody, mentionIds: z.array(Uuid).max(20).default([]) });
export type UpdatePhotoCommentRequest = z.infer<typeof UpdatePhotoCommentRequest>;
export const PhotoComment = z.object({
  id: Uuid,
  photoId: Uuid,
  parentId: Uuid.nullable(),
  authorId: Uuid,
  author: z.string(),
  authorAvatarAt: z.string().nullable(),
  /** null when the comment was deleted ("Comment deleted"). */
  body: z.string().nullable(),
  mentions: z.array(z.object({ id: Uuid, name: z.string() })),
  /** The mark this comment is about, if any. */
  markupId: Uuid.nullable(),
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().nullable(),
  mine: z.boolean(),
  /** For hiding buttons only; the server decides. */
  canEdit: z.boolean(),
  canDelete: z.boolean(),
});
export type PhotoComment = z.infer<typeof PhotoComment>;
// ---------------------------------------------------------------- drawing on photos (step 3)
export const MarkupKind = z.enum(["circle", "arrow", "pen", "rect", "text", "pin"]);
export const MarkupColor = z.enum(["red", "yellow", "green", "blue", "white", "black"]);
const Fraction = z.number().finite().min(0).max(1);
export const MarkupShapeInput = z
  .strictObject({
    clientRef: Uuid,
    kind: MarkupKind,
    color: MarkupColor,
    size: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    points: z.array(z.tuple([Fraction, Fraction])).min(1).max(2000),
    label: z.string().trim().max(200).nullable().optional(),
  })
  .superRefine((s, ctx) => {
    const n = s.points.length;
    const ok = s.kind === "pen" ? n >= 2 : s.kind === "text" || s.kind === "pin" ? n === 1 : n === 2;
    if (!ok) ctx.addIssue({ code: "custom", path: ["points"], message: `wrong number of points for a ${s.kind}` });
    const label = s.label?.trim() ?? "";
    if (s.kind === "text" && !label) ctx.addIssue({ code: "custom", path: ["label"], message: "text needs words" });
    if (s.kind !== "text" && s.kind !== "pin" && label) ctx.addIssue({ code: "custom", path: ["label"], message: "only text and pins have words" });
  });
export const MarkupChangesRequest = z
  .strictObject({
    add: z.array(MarkupShapeInput).max(200).default([]),
    remove: z.array(Uuid).max(500).default([]),
  })
  .refine((v) => v.add.length + v.remove.length > 0, { message: "nothing to save" });
export type MarkupChangesRequest = z.infer<typeof MarkupChangesRequest>;
export const PhotoMarkup = z.object({
  id: Uuid,
  kind: MarkupKind,
  color: MarkupColor,
  size: z.number().int(),
  points: z.array(z.tuple([z.number(), z.number()])),
  label: z.string().nullable(),
  authorId: Uuid,
  author: z.string(),
  createdAt: z.string(),
  mine: z.boolean(),
  /** For hiding buttons only; the server decides. */
  canRemove: z.boolean(),
});
export type PhotoMarkup = z.infer<typeof PhotoMarkup>;

// ---------------------------------------------------------------- issues to fix (step 4)
export const IssueParams = z.strictObject({ orgId: Uuid, issueId: Uuid });
export const IssueStatus = z.enum(["open", "in_progress", "awaiting_review", "resolved"]);
export type IssueStatus = z.infer<typeof IssueStatus>;
export const CreatePhotoIssueRequest = z.strictObject({
  clientRef: Uuid,
  title: z.string().trim().min(1, "say what needs fixing").max(200),
  details: z.string().trim().max(2000).nullable().optional(),
  /** The mark on the photo this issue is about (for example, a red circle). */
  markupId: Uuid.nullable().optional(),
  /** Managers may assign it straight away. Reports from others go to the job's Issues list unassigned. */
  assigneeId: Uuid.nullable().optional(),
});
export type CreatePhotoIssueRequest = z.infer<typeof CreatePhotoIssueRequest>;
export const IssueAction = z.enum(["assign", "start", "submit", "approve", "send_back", "reopen", "edit"]);
export type IssueAction = z.infer<typeof IssueAction>;
export const IssueActionRequest = z.strictObject({
  /** Made on the phone so the same action sent twice is only applied once. */
  clientRef: Uuid,
  action: IssueAction,
  /** The status the person saw. If the issue has changed since, nothing happens and the answer says so. */
  expectedStatus: IssueStatus.optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  assigneeId: Uuid.nullable().optional(),
  /** Photos of the fix (on the same job): at least one "After" photo, and optionally a "Before" photo. */
  fixPhotoIds: z.array(Uuid).max(20).default([]),
  title: z.string().trim().min(1).max(200).optional(),
  details: z.string().trim().max(2000).nullable().optional(),
});
export type IssueActionRequest = z.infer<typeof IssueActionRequest>;
export const IssueListQuery = z.strictObject({
  /** "active" = everything not resolved yet. */
  status: z.enum(["open", "in_progress", "awaiting_review", "resolved", "active"]).optional(),
  assigned: z.enum(["me", "none"]).optional(),
});
export const PhotoIssue = z.object({
  id: Uuid,
  jobId: Uuid,
  jobNumber: z.string(),
  photoId: Uuid,
  photoDeleted: z.boolean(),
  markupId: Uuid.nullable(),
  title: z.string(),
  details: z.string().nullable(),
  status: IssueStatus,
  assigneeId: Uuid.nullable(),
  assignee: z.string().nullable(),
  createdById: Uuid,
  createdBy: z.string(),
  submittedBy: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** The last thing that happened (for example "sent_back"), for showing "Sent back". */
  lastEvent: z.string(),
  fixPhotoIds: z.array(Uuid),
  /** The stage of each fix photo, in the same order ("before" or "after"), for the Before / After boxes. */
  fixPhotoStages: z.array(z.string()).default([]),
  /** What the person asking may do. For hiding buttons only; the server decides. */
  can: z.object({ assign: z.boolean(), start: z.boolean(), submit: z.boolean(), approve: z.boolean(), sendBack: z.boolean(), reopen: z.boolean(), edit: z.boolean() }),
});
export type PhotoIssue = z.infer<typeof PhotoIssue>;
export const PhotoIssueEvent = z.object({
  id: Uuid,
  kind: z.string(),
  actor: z.string(),
  fromStatus: IssueStatus.nullable(),
  toStatus: IssueStatus.nullable(),
  note: z.string().nullable(),
  assignee: z.string().nullable(),
  photoId: Uuid.nullable(),
  createdAt: z.string(),
});
export type PhotoIssueEvent = z.infer<typeof PhotoIssueEvent>;

export const JobPerson = z.object({ id: Uuid, name: z.string(), avatarAt: z.string().nullable(), me: z.boolean() });
export type JobPerson = z.infer<typeof JobPerson>;

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

// ---------------------------------------------------------------- company settings
export const RETENTION_DAY_OPTIONS = [7, 14, 30, 60, 90] as const;
export const SIGN_IN_DAY_OPTIONS = [1, 7, 14, 30, 60, 90] as const;
export const OrgSettings = z.object({
  deletedPhotoRetentionDays: z.number().int(),
  signInEveryDays: z.number().int(),
  canEdit: z.boolean(),
});
export type OrgSettings = z.infer<typeof OrgSettings>;
export const UpdateOrgSettingsRequest = z
  .strictObject({
    deletedPhotoRetentionDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)]).optional(),
    signInEveryDays: z.union([z.literal(1), z.literal(7), z.literal(14), z.literal(30), z.literal(60), z.literal(90)]).optional(),
  })
  .refine((b) => b.deletedPhotoRetentionDays !== undefined || b.signInEveryDays !== undefined, { message: "Nothing to change." });
export type UpdateOrgSettingsRequest = z.infer<typeof UpdateOrgSettingsRequest>;

// ---------------------------------------------------------------- team & roles
export const RoleParams = z.strictObject({ orgId: Uuid, roleId: Uuid });
export const MemberParams = z.strictObject({ orgId: Uuid, membershipId: Uuid });

export const TeamRole = z.object({
  id: Uuid,
  key: z.string(),
  name: z.string(),
  builtIn: z.boolean(),
  /** The Owner role always has every permission and can't be edited. */
  locked: z.boolean(),
  permissions: z.array(z.string()),
  memberCount: z.number().int(),
});
export type TeamRole = z.infer<typeof TeamRole>;

export const TeamMember = z.object({
  membershipId: Uuid,
  displayName: z.string(),
  jobTitle: z.string().nullable(),
  status: z.enum(["active", "suspended", "removed"]),
  isYou: z.boolean(),
  roles: z.array(z.object({ id: Uuid, key: z.string(), name: z.string() })),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const PermissionInfo = z.object({ key: z.string(), group: z.string(), label: z.string(), inUse: z.boolean() });
export type PermissionInfo = z.infer<typeof PermissionInfo>;

const RoleName = z.string().trim().min(1).max(60);
const PermissionKeys = z.array(z.string().regex(/^[a-z_]+\.[a-z_]+$/)).max(100);
export const CreateRoleRequest = z.strictObject({ name: RoleName, permissions: PermissionKeys });
export type CreateRoleRequest = z.infer<typeof CreateRoleRequest>;
export const UpdateRoleRequest = z.strictObject({ name: RoleName.optional(), permissions: PermissionKeys.optional() });
export type UpdateRoleRequest = z.infer<typeof UpdateRoleRequest>;
export const SetMemberRolesRequest = z.strictObject({ roleIds: z.array(Uuid).min(1, "Everyone needs at least one role.").max(20) });
export type SetMemberRolesRequest = z.infer<typeof SetMemberRolesRequest>;

export const InviteParams = z.strictObject({ orgId: Uuid, inviteId: Uuid });
export const MyInviteParams = z.strictObject({ inviteId: Uuid });
/** Days an invite stays usable (it can be renewed by the owner). */
export const INVITE_VALID_DAYS = 14;
export const CreateInviteRequest = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email address.").max(320)),
  displayName: z.string().trim().min(1).max(200),
  jobTitle: z.string().trim().max(120).nullable().optional(),
  roleIds: z.array(Uuid).min(1, "Choose at least one role.").max(20),
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequest>;
export const TeamInvite = z.object({
  id: Uuid,
  email: z.string(),
  displayName: z.string(),
  jobTitle: z.string().nullable(),
  roles: z.array(z.object({ id: Uuid, name: z.string() })),
  invitedBy: z.string(),
  createdAt: z.string(),
  /** After this, the person can no longer accept it; an owner can renew it. */
  expiresAt: z.string(),
  expired: z.boolean(),
});
export type TeamInvite = z.infer<typeof TeamInvite>;
export const SetMemberStatusRequest = z.strictObject({ status: z.enum(["active", "suspended", "removed"]) });
export type SetMemberStatusRequest = z.infer<typeof SetMemberStatusRequest>;

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

// ---------------------------------------------------------------- in-app alerts (step 5)
export const NotificationKind = z.enum([
  "mention", "reply", "photo_comment",
  "issue_assigned", "issue_reported", "issue_submitted", "issue_approved", "issue_sent_back", "issue_reopened",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;
export const NotificationListQuery = z.strictObject({
  unread: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const Notification = z.object({
  id: Uuid,
  kind: NotificationKind,
  actor: z.string(),
  actorId: Uuid,
  actorAvatarAt: z.string().nullable(),
  jobId: Uuid,
  jobNumber: z.string(),
  photoId: Uuid,
  commentId: Uuid.nullable(),
  issueId: Uuid.nullable(),
  issueTitle: z.string().nullable(),
  /** The start of the comment, or null when it was deleted. */
  snippet: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type Notification = z.infer<typeof Notification>;
export const MarkNotificationsReadRequest = z.strictObject({
  ids: z.array(Uuid).max(200).optional(),
  all: z.boolean().optional(),
}).refine((v) => !!v.all !== !!v.ids?.length, "send either ids or all: true");
export const NotificationSettings = z.strictObject({
  /** Alert kinds this person switched off. */
  muted: z.array(NotificationKind).max(20),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;
