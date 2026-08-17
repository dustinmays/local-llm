import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReleaseEvidenceSchema,
  StreamMeasurementSchema,
  deriveRoutingRecommendation,
  loadReleaseEvidence,
  transcriptSummary,
  writeReleaseEvidence,
  type ReleaseEvidence,
  type ReleaseProfile,
  type WorkloadMeasurement,
} from "../src/release-evidence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const workloadNames = [
  "summary-2k",
  "diff-review-10k",
  "analysis-25k",
  "structured",
  "bug-find",
] as const;

function workloads(profile: ReleaseProfile, score: number, latency: number): WorkloadMeasurement[] {
  const backend = profile.startsWith("cluster-") ? "cluster" : "controller";
  const quality = profile.endsWith("-fast") ? "fast" : "deep";
  return workloadNames.map((workload) => ({
    workload,
    ok: true,
    backend,
    model: "safe-model-id",
    actual_quality: quality,
    elapsed_seconds: latency,
    queue_seconds: 0,
    input_characters: 2_000,
    output_characters: 100,
    answer_sha256: "a".repeat(64),
    correctness_score: score,
    response_valid: true,
    error_code: null,
  }));
}

function evaluation(profile: ReleaseProfile, score: number, latency: number): ReleaseEvidence {
  return ReleaseEvidenceSchema.parse({
    schema_version: 1,
    run_id: "123e4567-e89b-42d3-a456-426614174000",
    created_at: "2026-08-17T12:00:00.000Z",
    kind: "evaluation",
    profile,
    scenario: null,
    git_commit: "abcdef1",
    package_version: "0.1.0",
    node_version: "24.19.0",
    platform: "darwin",
    architecture: "arm64",
    status: "pass",
    backend: profile.startsWith("cluster-") ? "cluster" : "controller",
    model: "safe-model-id",
    checks: [],
    workloads: workloads(profile, score, latency),
    stream: null,
    host_transcripts: [],
    log_events: [],
    warnings: [],
  });
}

describe("release evidence", () => {
  it("enforces kind/profile/scenario and complete stream invariants", () => {
    expect(() =>
      ReleaseEvidenceSchema.parse({
        ...evaluation("single-fast", 1, 1),
        profile: null,
      }),
    ).toThrow();
    expect(() =>
      StreamMeasurementSchema.parse({
        available: false,
        time_to_first_text_seconds: 1,
        total_seconds: null,
        prompt_tokens: null,
        completion_tokens: null,
        effective_prefill_tokens_per_second: null,
        decode_tokens_per_second: null,
        startup_seconds: null,
        peak_memory_bytes: null,
        unavailable_reason: "not available",
      }),
    ).toThrow();
  });

  it("summarizes transcripts without retaining raw source, paths, or credentials", () => {
    const secret = "credential=release-secret";
    const absolutePath = "/private/release-fixture/source.ts";
    const summary = transcriptSummary({
      host: "codex",
      status: "pass",
      commandLabel: "safe-label",
      exitCode: 0,
      stdout: `${secret}\n${absolutePath}`,
      stderr: "source response body",
      toolInvoked: true,
      structuredResultOk: true,
      message: "Safe release invariant passed.",
    });
    const rendered = JSON.stringify(summary);
    expect(summary.stdout_bytes).toBeGreaterThan(0);
    expect(summary.stdout_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(absolutePath);
    expect(rendered).not.toContain("source response body");
    expect(() =>
      transcriptSummary({
        host: "codex",
        status: "fail",
        commandLabel: "safe-label",
        exitCode: 1,
        stdout: "",
        stderr: "",
        toolInvoked: false,
        structuredResultOk: false,
        message: "Failure at /Users/example/private.ts with api_key=unsafe",
      }),
    ).toThrow();
  });

  it("requires four comparable complete profiles before recommending routing", () => {
    const incomplete = deriveRoutingRecommendation([
      evaluation("single-fast", 0.9, 3),
      evaluation("cluster-fast", 0.9, 5),
    ]);
    expect(incomplete).toMatchObject({ complete: false, fast_profile: null });

    const complete = deriveRoutingRecommendation([
      evaluation("single-fast", 0.9, 3),
      evaluation("cluster-fast", 0.92, 5),
      evaluation("single-deep", 0.8, 4),
      evaluation("cluster-deep", 0.95, 8),
    ]);
    expect(complete).toMatchObject({
      complete: true,
      fast_profile: "single-fast",
      deep_profile: "cluster-deep",
      cluster_fast_diagnostic_only: true,
    });
  });

  it("writes strict evidence atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-mlx-evidence-"));
    temporaryDirectories.push(directory);
    const evidence = evaluation("single-fast", 1, 2);
    const path = await writeReleaseEvidence(directory, evidence);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      ReleaseEvidenceSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown),
    ).toEqual(evidence);
    expect(await loadReleaseEvidence(directory)).toEqual([evidence]);
  });
});
