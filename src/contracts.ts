import { z } from "zod";

export const BackendNameSchema = z.enum(["controller", "worker", "cluster"]);
export type BackendName = z.infer<typeof BackendNameSchema>;

export const BackendSelectionSchema = z.enum(["auto", ...BackendNameSchema.options]);
export type BackendSelection = z.infer<typeof BackendSelectionSchema>;

export const AvailabilitySchema = z.enum([
  "offline",
  "ready",
  "busy",
  "queued",
  "cooldown",
  "degraded",
]);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const QualityClassSchema = z.enum(["fast", "deep", "unknown"]);
export type QualityClass = z.infer<typeof QualityClassSchema>;

export const RequestedQualitySchema = z.enum(["auto", "fast", "deep"]);
export type RequestedQuality = z.infer<typeof RequestedQualitySchema>;

export const ModelMetadataSchema = z
  .object({
    id: z.string().min(1).max(1024),
    object: z.string().max(128).nullable(),
    created: z.number().int().nonnegative().nullable(),
    owned_by: z.string().max(1024).nullable(),
  })
  .strict();
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;

export const ContextManifestEntrySchema = z
  .object({
    relative_path: z.string().min(1),
    byte_count: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    truncated: z.boolean(),
    omitted: z.boolean(),
    reason: z.string().max(512).nullable(),
  })
  .strict();
export type ContextManifestEntry = z.infer<typeof ContextManifestEntrySchema>;

export const StableErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "INVALID_WORKSPACE",
  "PATH_OUTSIDE_WORKSPACE",
  "SENSITIVE_PATH",
  "INPUT_LIMIT_EXCEEDED",
  "BACKEND_UNAVAILABLE",
  "MODEL_NOT_LOADED",
  "QUALITY_MISMATCH",
  "BACKEND_BUSY",
  "BACKEND_COOLDOWN",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_PROTOCOL_ERROR",
  "INTERNAL_ERROR",
]);
export type StableErrorCode = z.infer<typeof StableErrorCodeSchema>;

export const SafePrimitiveSchema = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
  z.null(),
]);
export type SafePrimitive = z.infer<typeof SafePrimitiveSchema>;

export const StableErrorSchema = z
  .object({
    code: StableErrorCodeSchema,
    message: z.string().min(1).max(1024),
    retryable: z.boolean(),
    backend: BackendNameSchema.nullable(),
    startup_hint: z.string().max(1024).nullable(),
    details: z.record(z.string().max(128), SafePrimitiveSchema),
  })
  .strict();
export type StableError = z.infer<typeof StableErrorSchema>;

export const ResourceAvailabilitySchema = z
  .object({
    resource_group: z.string().min(1).max(128),
    availability: AvailabilitySchema,
    lease_id: z.uuid().nullable(),
    backend: BackendNameSchema.nullable(),
    model: z.string().min(1).max(1024).nullable(),
    lease_age_seconds: z.number().nonnegative().nullable(),
    cooldown_remaining_seconds: z.number().nonnegative().nullable(),
    queue_depth: z.number().int().nonnegative(),
  })
  .strict();
export type ResourceAvailability = z.infer<typeof ResourceAvailabilitySchema>;

export const ConfiguredBackendStatusSchema = z
  .object({
    backend: BackendNameSchema,
    enabled: z.boolean(),
    health: z.boolean(),
    availability: AvailabilitySchema,
    /** Models visible through the backend's OpenAI-compatible catalog. */
    models: z.array(ModelMetadataSchema),
    /** Loaded generative models that are safe delegation candidates. */
    loaded_models: z.array(ModelMetadataSchema),
    endpoint: z.url(),
    latency_ms: z.number().int().nonnegative().nullable(),
    resource_groups: z.array(z.string().min(1).max(128)),
    resource_states: z.array(ResourceAvailabilitySchema),
    queue_depth: z.number().int().nonnegative(),
    lease_age_seconds: z.number().nonnegative().nullable(),
    cooldown_remaining_seconds: z.number().nonnegative().nullable(),
    warnings: z.array(z.string().max(1024)),
    startup_hint: z.string().max(1024),
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type ConfiguredBackendStatus = z.infer<typeof ConfiguredBackendStatusSchema>;

export const StatusResultSchema = z
  .object({
    ok: z.boolean(),
    request_id: z.uuid(),
    configured_backends: z.array(ConfiguredBackendStatusSchema),
    healthy_backends: z.array(BackendNameSchema),
    selected_backend: BackendNameSchema.nullable(),
    endpoint: z.url().nullable(),
    model: ModelMetadataSchema.nullable(),
    quality_class: QualityClassSchema,
    availability: AvailabilitySchema,
    resource_groups: z.array(z.string().min(1).max(128)),
    resource_states: z.array(ResourceAvailabilitySchema),
    queue_depth: z.number().int().nonnegative(),
    lease_age_seconds: z.number().nonnegative().nullable(),
    cooldown_remaining_seconds: z.number().nonnegative().nullable(),
    startup_hint: z.string().max(1024).nullable(),
    warnings: z.array(z.string().max(1024)),
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type StatusResult = z.infer<typeof StatusResultSchema>;

export const StatusInputSchema = z
  .object({
    backend: BackendSelectionSchema.default("auto"),
  })
  .strict();
export type StatusInput = z.infer<typeof StatusInputSchema>;

export const BusyBehaviorSchema = z.enum(["fail", "wait"]);

export const DelegateInputSchema = z
  .object({
    task: z.string().trim().min(1).max(20_000),
    cwd: z.string().min(1),
    paths: z.array(z.string().min(1).max(4_096)).max(256).default([]),
    include_diff: z.boolean().default(false),
    quality: RequestedQualitySchema.default("auto"),
    backend: BackendSelectionSchema.default("auto"),
    busy_behavior: BusyBehaviorSchema.default("fail"),
    max_wait_seconds: z.number().int().min(0).max(3_600).default(0),
    max_input_chars: z.number().int().min(1_000).max(500_000).default(120_000),
    max_output_tokens: z.number().int().min(1).max(32_768).default(4_096),
  })
  .strict();
export type DelegateInput = z.infer<typeof DelegateInputSchema>;

export const DelegateResultSchema = z
  .object({
    ok: z.boolean(),
    request_id: z.uuid(),
    backend: BackendNameSchema.nullable(),
    endpoint: z.url().nullable(),
    model: ModelMetadataSchema.nullable(),
    requested_quality: RequestedQualitySchema,
    actual_quality: QualityClassSchema,
    availability: AvailabilitySchema,
    answer: z.string().nullable(),
    context_manifest: z.array(ContextManifestEntrySchema),
    elapsed_seconds: z.number().nonnegative(),
    queue_seconds: z.number().nonnegative(),
    input_characters: z.number().int().nonnegative(),
    truncated: z.boolean(),
    warnings: z.array(z.string().max(1_024)),
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type DelegateResult = z.infer<typeof DelegateResultSchema>;

export const LeaseStateSchema = z.enum(["active", "cooldown"]);
export const LeaseRecordSchema = z
  .object({
    lease_id: z.uuid(),
    request_id: z.uuid(),
    owner_pid: z.number().int().positive(),
    owner_instance_id: z.uuid(),
    backend: BackendNameSchema,
    resource_groups: z.array(z.string().min(1).max(128)).min(1),
    model: z.string().min(1).max(1024),
    started_at: z.iso.datetime(),
    heartbeat_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
    state: LeaseStateSchema,
  })
  .strict();
export type LeaseRecord = z.infer<typeof LeaseRecordSchema>;

export const WaitTicketSchema = z
  .object({
    ticket_id: z.uuid(),
    request_id: z.uuid(),
    owner_pid: z.number().int().positive(),
    owner_instance_id: z.uuid(),
    backend: BackendNameSchema,
    resource_groups: z.array(z.string().min(1).max(128)).min(1),
    model: z.string().min(1).max(1024),
    created_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .strict();
export type WaitTicket = z.infer<typeof WaitTicketSchema>;

export const LeaseInspectionSchema = z
  .object({
    schema_version: z.literal(1),
    healthy: z.boolean(),
    leases: z.array(LeaseRecordSchema),
    queue: z.array(WaitTicketSchema),
    rate_limit_count: z.number().int().nonnegative(),
    rate_limit_maximum: z.number().int().positive(),
    rate_limit_window_seconds: z.number().positive(),
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type LeaseInspection = z.infer<typeof LeaseInspectionSchema>;

export const LeaseCommandResultSchema = z
  .object({
    request_id: z.uuid(),
    ok: z.boolean(),
    action: z.enum(["inspect", "clear"]),
    cleared_lease_id: z.uuid().nullable(),
    state: LeaseInspectionSchema,
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type LeaseCommandResult = z.infer<typeof LeaseCommandResultSchema>;

export const DoctorCheckStateSchema = z.enum(["pass", "warn", "fail", "skip"]);
export const DoctorCheckSchema = z
  .object({
    name: z.string().min(1).max(128),
    status: DoctorCheckStateSchema,
    message: z.string().min(1).max(1024),
    error: StableErrorSchema.nullable(),
  })
  .strict();
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

export const DoctorResultSchema = z
  .object({
    request_id: z.uuid(),
    ok: z.boolean(),
    checks: z.array(DoctorCheckSchema),
    status: StatusResultSchema,
  })
  .strict();
export type DoctorResult = z.infer<typeof DoctorResultSchema>;
