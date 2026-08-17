import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { BackendNameSchema, StableErrorCodeSchema } from "./contracts.js";

const SafeEvidenceTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\r\n]/u.test(value), "evidence text must be one line")
  .refine(
    (value) =>
      !/(?:\/Users\/|\/home\/|\/private\/var\/|[A-Za-z]:\\Users\\|password\s*[:=]|credential\s*[:=]|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9])/iu.test(
        value,
      ),
    "evidence text contains path or credential-like material",
  );

export const ReleaseProfileSchema = z.enum([
  "single-fast",
  "single-deep",
  "worker-fast",
  "worker-deep",
  "cluster-fast",
  "cluster-deep",
]);
export type ReleaseProfile = z.infer<typeof ReleaseProfileSchema>;

export const ReleaseCheckStateSchema = z.enum(["pass", "warn", "fail", "skip"]);

export const ReleaseCheckSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9_.-]+$/u),
    status: ReleaseCheckStateSchema,
    message: SafeEvidenceTextSchema,
    error_code: StableErrorCodeSchema.nullable(),
  })
  .strict();

export const WorkloadMeasurementSchema = z
  .object({
    workload: z.enum(["summary-2k", "diff-review-10k", "analysis-25k", "structured", "bug-find"]),
    ok: z.boolean(),
    backend: BackendNameSchema.nullable(),
    model: z.string().min(1).max(1_024).nullable(),
    actual_quality: z.enum(["fast", "deep", "unknown"]),
    elapsed_seconds: z.number().nonnegative(),
    queue_seconds: z.number().nonnegative(),
    input_characters: z.number().int().nonnegative(),
    output_characters: z.number().int().nonnegative(),
    answer_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    correctness_score: z.number().min(0).max(1),
    response_valid: z.boolean(),
    error_code: StableErrorCodeSchema.nullable(),
  })
  .strict();
export type WorkloadMeasurement = z.infer<typeof WorkloadMeasurementSchema>;

export const StreamMeasurementSchema = z
  .object({
    available: z.boolean(),
    time_to_first_text_seconds: z.number().nonnegative().nullable(),
    total_seconds: z.number().nonnegative().nullable(),
    prompt_tokens: z.number().int().nonnegative().nullable(),
    completion_tokens: z.number().int().nonnegative().nullable(),
    effective_prefill_tokens_per_second: z.number().nonnegative().nullable(),
    decode_tokens_per_second: z.number().nonnegative().nullable(),
    startup_seconds: z.number().nonnegative().nullable(),
    peak_memory_bytes: z.number().int().nonnegative().nullable(),
    unavailable_reason: SafeEvidenceTextSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.available) {
      if (value.time_to_first_text_seconds === null || value.total_seconds === null) {
        context.addIssue({
          code: "custom",
          message: "available stream measurements require TTFT and total time",
        });
      }
    } else if (
      value.time_to_first_text_seconds !== null ||
      value.total_seconds !== null ||
      value.prompt_tokens !== null ||
      value.completion_tokens !== null ||
      value.effective_prefill_tokens_per_second !== null ||
      value.decode_tokens_per_second !== null ||
      value.startup_seconds !== null ||
      value.peak_memory_bytes !== null ||
      value.unavailable_reason === null
    ) {
      context.addIssue({
        code: "custom",
        message: "unavailable stream measurements require null metrics and a safe reason",
      });
    }
  });
export type StreamMeasurement = z.infer<typeof StreamMeasurementSchema>;

export const HostTranscriptSchema = z
  .object({
    host: z.enum(["codex", "claude", "copilot-cli", "vscode"]),
    status: ReleaseCheckStateSchema,
    command_label: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9_.-]+$/u),
    exit_code: z.number().int().nullable(),
    stdout_bytes: z.number().int().nonnegative(),
    stdout_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    stderr_bytes: z.number().int().nonnegative(),
    stderr_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    tool_invoked: z.boolean(),
    structured_result_ok: z.boolean().nullable(),
    error_code: StableErrorCodeSchema.nullable(),
    message: SafeEvidenceTextSchema,
  })
  .strict();
export type HostTranscript = z.infer<typeof HostTranscriptSchema>;

export const ReleaseEvidenceSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.uuid(),
    created_at: z.iso.datetime(),
    kind: z.enum(["live-backend", "evaluation", "behavior"]),
    profile: ReleaseProfileSchema.nullable(),
    scenario: z.enum(["ready", "offline", "containment", "capacity"]).nullable(),
    git_commit: z.string().regex(/^[a-f0-9]{7,64}$/),
    package_version: z.string().min(1).max(64),
    node_version: z.string().min(1).max(64),
    platform: z.string().min(1).max(64),
    architecture: z.string().min(1).max(64),
    status: z.enum(["pass", "fail", "partial"]),
    backend: BackendNameSchema.nullable(),
    model: z.string().min(1).max(1_024).nullable(),
    checks: z.array(ReleaseCheckSchema),
    workloads: z.array(WorkloadMeasurementSchema),
    stream: StreamMeasurementSchema.nullable(),
    host_transcripts: z.array(HostTranscriptSchema),
    log_events: z.array(
      z
        .object({
          event: z.string().min(1).max(128),
          request_id: z.uuid().nullable(),
          command: z.string().min(1).max(128).nullable(),
          backend: BackendNameSchema.nullable(),
          model: z.string().min(1).max(1_024).nullable(),
          duration_ms: z.number().int().nonnegative().nullable(),
          outcome: z.string().min(1).max(128).nullable(),
          error_code: StableErrorCodeSchema.nullable(),
        })
        .strict(),
    ),
    warnings: z.array(SafeEvidenceTextSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "behavior") {
      if (value.scenario === null) {
        context.addIssue({ code: "custom", message: "behavior evidence requires a scenario" });
      }
    } else {
      if (value.profile === null) {
        context.addIssue({ code: "custom", message: `${value.kind} evidence requires a profile` });
      }
      if (value.backend === null || value.model === null) {
        context.addIssue({
          code: "custom",
          message: `${value.kind} evidence requires an observed backend and model`,
        });
      }
      if (value.scenario !== null) {
        context.addIssue({
          code: "custom",
          message: `${value.kind} evidence must not declare a behavior scenario`,
        });
      }
      const expectedQuality = value.profile?.endsWith("-fast") === true ? "fast" : "deep";
      for (const workload of value.workloads) {
        if (
          workload.backend !== value.backend ||
          workload.model !== value.model ||
          workload.actual_quality !== expectedQuality
        ) {
          context.addIssue({
            code: "custom",
            message: "workload identity must match the observed release profile",
          });
          break;
        }
      }
    }
  });
export type ReleaseEvidence = z.infer<typeof ReleaseEvidenceSchema>;

export const RoutingRecommendationSchema = z
  .object({
    complete: z.boolean(),
    fast_profile: ReleaseProfileSchema.nullable(),
    deep_profile: ReleaseProfileSchema.nullable(),
    cluster_fast_diagnostic_only: z.boolean().nullable(),
    rationale: z.array(SafeEvidenceTextSchema),
  })
  .strict();
export type RoutingRecommendation = z.infer<typeof RoutingRecommendationSchema>;

export class ReleaseEvidenceLoadError extends Error {
  override name = "ReleaseEvidenceLoadError";
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function transcriptSummary(options: {
  host: HostTranscript["host"];
  status: HostTranscript["status"];
  commandLabel: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  toolInvoked: boolean;
  structuredResultOk: boolean | null;
  errorCode?: z.infer<typeof StableErrorCodeSchema> | null;
  message: string;
}): HostTranscript {
  return HostTranscriptSchema.parse({
    host: options.host,
    status: options.status,
    command_label: options.commandLabel,
    exit_code: options.exitCode,
    stdout_bytes: Buffer.byteLength(options.stdout),
    stdout_sha256: options.stdout.length === 0 ? null : sha256(options.stdout),
    stderr_bytes: Buffer.byteLength(options.stderr),
    stderr_sha256: options.stderr.length === 0 ? null : sha256(options.stderr),
    tool_invoked: options.toolInvoked,
    structured_result_ok: options.structuredResultOk,
    error_code: options.errorCode ?? null,
    message: options.message,
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) return Number.POSITIVE_INFINITY;
  if (sorted.length % 2 === 1) return value;
  const previous = sorted[middle - 1];
  return previous === undefined ? value : (previous + value) / 2;
}

function profileMetrics(evidence: ReleaseEvidence): { score: number; latency: number } {
  const completed = evidence.workloads.filter((workload) => workload.ok);
  const score =
    evidence.workloads.length === 0
      ? 0
      : evidence.workloads.reduce((sum, workload) => sum + workload.correctness_score, 0) /
        evidence.workloads.length;
  return { score, latency: median(completed.map((workload) => workload.elapsed_seconds)) };
}

function chooseProfile(
  left: ReleaseEvidence,
  right: ReleaseEvidence,
): { selected: ReleaseProfile; reason: string } {
  const leftMetrics = profileMetrics(left);
  const rightMetrics = profileMetrics(right);
  if (Math.abs(leftMetrics.score - rightMetrics.score) > 0.05) {
    const winner = leftMetrics.score > rightMetrics.score ? left : right;
    const metrics = winner === left ? leftMetrics : rightMetrics;
    return {
      selected: ReleaseProfileSchema.parse(winner.profile),
      reason: `Selected ${winner.profile ?? "unknown"} for its higher measured correctness score (${metrics.score.toFixed(3)}).`,
    };
  }
  const winner = leftMetrics.latency <= rightMetrics.latency ? left : right;
  const metrics = winner === left ? leftMetrics : rightMetrics;
  return {
    selected: ReleaseProfileSchema.parse(winner.profile),
    reason: `Correctness was within 0.05; selected ${winner.profile ?? "unknown"} for lower median delegation latency (${metrics.latency.toFixed(3)} seconds).`,
  };
}

export function deriveRoutingRecommendation(evidence: ReleaseEvidence[]): RoutingRecommendation {
  const evaluations = new Map<ReleaseProfile, ReleaseEvidence>();
  const requiredWorkloads = new Set(WorkloadMeasurementSchema.shape.workload.options);
  const ordered = [...evidence].sort(
    (left, right) =>
      left.created_at.localeCompare(right.created_at) || left.run_id.localeCompare(right.run_id),
  );
  for (const item of ordered) {
    const workloads = new Set(item.workloads.map((workload) => workload.workload));
    const comparable =
      workloads.size === requiredWorkloads.size &&
      [...requiredWorkloads].every((workload) => workloads.has(workload)) &&
      item.workloads.every((workload) => workload.ok && workload.response_valid);
    if (
      item.kind === "evaluation" &&
      item.profile !== null &&
      item.status === "pass" &&
      comparable
    ) {
      evaluations.set(item.profile, item);
    }
  }
  const required = ["single-fast", "single-deep", "cluster-fast", "cluster-deep"] as const;
  const missing = required.filter((profile) => !evaluations.has(profile));
  if (missing.length > 0) {
    return RoutingRecommendationSchema.parse({
      complete: false,
      fast_profile: null,
      deep_profile: null,
      cluster_fast_diagnostic_only: null,
      rationale: [`Comparable passing evidence is still required for: ${missing.join(", ")}.`],
    });
  }
  const singleFast = evaluations.get("single-fast");
  const clusterFast = evaluations.get("cluster-fast");
  const singleDeep = evaluations.get("single-deep");
  const clusterDeep = evaluations.get("cluster-deep");
  if (
    singleFast === undefined ||
    clusterFast === undefined ||
    singleDeep === undefined ||
    clusterDeep === undefined
  ) {
    throw new Error("Evaluation map changed unexpectedly.");
  }
  const fast = chooseProfile(singleFast, clusterFast);
  const deep = chooseProfile(singleDeep, clusterDeep);
  const singleFastMetrics = profileMetrics(singleFast);
  const clusterFastMetrics = profileMetrics(clusterFast);
  const diagnosticOnly =
    clusterFastMetrics.score <= singleFastMetrics.score + 0.05 &&
    clusterFastMetrics.latency >= singleFastMetrics.latency;
  return RoutingRecommendationSchema.parse({
    complete: true,
    fast_profile: fast.selected,
    deep_profile: deep.selected,
    cluster_fast_diagnostic_only: diagnosticOnly,
    rationale: [
      fast.reason,
      deep.reason,
      diagnosticOnly
        ? "Cluster fast did not improve correctness by more than 0.05 and was not faster, so keep it diagnostic-only."
        : "Cluster fast demonstrated a material correctness or latency advantage and need not remain diagnostic-only.",
    ],
  });
}

function missingDirectory(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function loadReleaseEvidence(directory: string): Promise<ReleaseEvidence[]> {
  const canonicalDirectory = resolve(directory);
  let names: string[];
  try {
    names = (await readdir(canonicalDirectory))
      .filter((name) => name.endsWith(".json") && name !== "routing-recommendation-v1.json")
      .sort();
  } catch (error) {
    if (missingDirectory(error)) return [];
    throw new ReleaseEvidenceLoadError("The release evidence directory is not readable.");
  }
  const evidence: ReleaseEvidence[] = [];
  for (const name of names) {
    const path = join(canonicalDirectory, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2_097_152) {
        throw new Error("unsafe evidence entry");
      }
      evidence.push(
        ReleaseEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown),
      );
    } catch {
      throw new ReleaseEvidenceLoadError(
        "The release evidence directory contains an invalid or unsafe JSON entry.",
      );
    }
  }
  return evidence;
}

async function durableWrite(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeReleaseEvidence(
  directory: string,
  evidence: ReleaseEvidence,
): Promise<string> {
  const parsed = ReleaseEvidenceSchema.parse(evidence);
  const canonicalDirectory = resolve(directory);
  await mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
  const name = `${parsed.created_at.replaceAll(":", "").replaceAll("-", "")}-${parsed.kind}-${parsed.profile ?? parsed.scenario ?? "run"}-${parsed.run_id}.json`;
  const target = join(canonicalDirectory, name);
  const temporary = join(canonicalDirectory, `.${randomUUID()}.tmp`);
  try {
    await durableWrite(temporary, `${JSON.stringify(parsed, null, 2)}\n`);
    await rename(temporary, target);
    const handle = await open(canonicalDirectory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return target;
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
