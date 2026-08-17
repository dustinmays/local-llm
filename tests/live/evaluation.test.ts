import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  ReleaseEvidenceSchema,
  writeReleaseEvidence,
  type ReleaseEvidence,
} from "../../src/release-evidence.js";
import {
  createEvaluationWorkspace,
  delegate,
  liveEnvironment,
  liveProfile,
  measurement,
  safeLogEvents,
  status,
  streamMeasurement,
} from "./helpers.js";

const execute = promisify(execFile);
const enabled = process.env.LOCAL_MLX_DELEGATE_EVALUATION === "1";
const profile = enabled ? liveProfile(process.env.LOCAL_MLX_DELEGATE_LIVE_PROFILE) : null;
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("comparable live evaluation", () => {
  it("runs the identical five-workload suite and records safe measurements", async () => {
    if (profile === null) throw new Error("LOCAL_MLX_DELEGATE_LIVE_PROFILE is required.");
    const fixture = await createEvaluationWorkspace();
    temporaryDirectories.push(fixture.root);
    const stateDirectory = await mkdtemp(join(tmpdir(), "local-mlx-eval-state-"));
    temporaryDirectories.push(stateDirectory);
    const environment = liveEnvironment(profile, stateDirectory);
    const checked = await status(profile, environment);
    expect(checked.result.ok).toBe(true);
    expect(checked.result.quality_class).toBe(profile.quality);
    const model = checked.result.model?.id;
    const endpoint = checked.result.endpoint;
    if (model === undefined || endpoint === null) {
      throw new Error("The live profile did not resolve one model and endpoint.");
    }

    const workloads = [];
    const logEvents = [...safeLogEvents(checked.invocation.stderr)];
    for (const workload of fixture.workloads) {
      const invocation = await delegate(profile, environment, fixture.root, workload);
      const measured = measurement(workload, invocation.result);
      workloads.push(measured);
      logEvents.push(...safeLogEvents(invocation.invocation.stderr));
    }
    const stream = await streamMeasurement(endpoint, model);
    const allCorrect = workloads.every(
      (workload) => workload.ok && workload.response_valid && workload.correctness_score === 1,
    );
    expect(allCorrect).toBe(true);
    const commit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })
    ).stdout.trim();
    const evidence: ReleaseEvidence = ReleaseEvidenceSchema.parse({
      schema_version: 1,
      run_id: randomUUID(),
      created_at: new Date().toISOString(),
      kind: "evaluation",
      profile: profile.profile,
      scenario: null,
      git_commit: commit,
      package_version: "0.1.0",
      node_version: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      status: allCorrect ? "pass" : "fail",
      backend: profile.backend,
      model,
      checks: [
        {
          name: "comparable_workloads",
          status: allCorrect ? "pass" : "fail",
          message: allCorrect
            ? "All five identical workloads passed their deterministic validators."
            : "At least one identical workload failed its deterministic validator.",
          error_code: null,
        },
        {
          name: "stream_metrics",
          status: stream.available ? "pass" : "warn",
          message: stream.available
            ? "The endpoint returned bounded TTFT and token-throughput measurements."
            : "The endpoint did not expose a valid streaming measurement.",
          error_code: null,
        },
      ],
      workloads,
      stream,
      host_transcripts: [],
      log_events: logEvents,
      warnings: [
        "Startup time and peak upstream memory remain null because this read-only harness does not control lifecycle and the API does not report them.",
      ],
    });
    const evidenceDirectory =
      process.env.LOCAL_MLX_DELEGATE_EVIDENCE_DIR ?? join(process.cwd(), "artifacts", "delegate");
    const output = await writeReleaseEvidence(evidenceDirectory, evidence);
    process.stderr.write(`Evaluation evidence written: ${basename(output)}\n`);
  }, 3_600_000);
});
