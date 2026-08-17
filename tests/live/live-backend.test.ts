import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DelegateResultSchema } from "../../src/contracts.js";
import {
  ReleaseEvidenceSchema,
  sha256,
  writeReleaseEvidence,
  type ReleaseEvidence,
} from "../../src/release-evidence.js";
import {
  createEvaluationWorkspace,
  delegate,
  invokeCli,
  liveEnvironment,
  liveProfile,
  measurement,
  safeLogEvents,
  status,
} from "./helpers.js";

const execute = promisify(execFile);
const enabled = process.env.LOCAL_MLX_DELEGATE_LIVE === "1";
const profile = enabled ? liveProfile(process.env.LOCAL_MLX_DELEGATE_LIVE_PROFILE) : null;
const topology = process.env.LOCAL_MLX_DELEGATE_LIVE_TOPOLOGY;
if (
  enabled &&
  profile !== null &&
  ((topology === "single" && !profile.profile.startsWith("single-")) ||
    (topology === "worker" && !profile.profile.startsWith("worker-")) ||
    (topology === "cluster" && !profile.profile.startsWith("cluster-")))
) {
  throw new Error(`The selected profile does not match the ${topology} live task.`);
}
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe.skipIf(!enabled)("live backend release smoke", () => {
  it("checks ready delegation, quality mismatch, and canonical containment", async () => {
    if (profile === null) throw new Error("LOCAL_MLX_DELEGATE_LIVE_PROFILE is required.");
    const fixture = await createEvaluationWorkspace();
    temporaryDirectories.push(fixture.root);
    const stateDirectory = await mkdtemp(join(tmpdir(), "local-mlx-live-state-"));
    temporaryDirectories.push(stateDirectory);
    const environment = liveEnvironment(profile, stateDirectory);
    const checked = await status(profile, environment);
    expect(checked.result.ok).toBe(true);
    expect(checked.result.selected_backend).toBe(profile.backend);
    expect(checked.result.quality_class).toBe(profile.quality);
    const model = checked.result.model?.id;
    if (model === undefined) throw new Error("The live backend did not select one model.");

    const bugWorkload = fixture.workloads.find((workload) => workload.name === "bug-find");
    if (bugWorkload === undefined) throw new Error("Missing bug workload.");
    const before = sha256(await readFile(join(fixture.root, "src", "cache.ts"), "utf8"));
    const delegated = await delegate(profile, environment, fixture.root, bugWorkload);
    const measured = measurement(bugWorkload, delegated.result);
    expect(measured).toMatchObject({
      ok: true,
      backend: profile.backend,
      model,
      actual_quality: profile.quality,
      correctness_score: 1,
      response_valid: true,
    });
    expect(sha256(await readFile(join(fixture.root, "src", "cache.ts"), "utf8"))).toBe(before);

    const oppositeQuality = profile.quality === "fast" ? "deep" : "fast";
    const mismatch = await invokeCli(
      [
        "delegate",
        "--task",
        "Return a bounded quality diagnostic.",
        "--cwd",
        fixture.root,
        "--workspace-root",
        fixture.root,
        "--backend",
        profile.backend,
        "--quality",
        oppositeQuality,
        "--json",
      ],
      environment,
    );
    const mismatchResult = DelegateResultSchema.parse(JSON.parse(mismatch.stdout) as unknown);
    expect(mismatchResult.error?.code).toBe("QUALITY_MISMATCH");

    const outsideDirectory = await mkdtemp(join(tmpdir(), "local-mlx-outside-"));
    temporaryDirectories.push(outsideDirectory);
    const outsideFile = join(outsideDirectory, "private.txt");
    await writeFile(outsideFile, "must remain unread\n");
    const link = join(fixture.root, "escape.txt");
    await symlink(outsideFile, link);
    const containmentResults = [];
    for (const path of [outsideFile, basename(link)]) {
      const contained = await invokeCli(
        [
          "delegate",
          "--task",
          "Attempt a containment check only.",
          "--cwd",
          fixture.root,
          "--workspace-root",
          fixture.root,
          "--backend",
          profile.backend,
          "--path",
          path,
          "--json",
        ],
        environment,
      );
      const result = DelegateResultSchema.parse(JSON.parse(contained.stdout) as unknown);
      expect(result.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
      containmentResults.push({ result, invocation: contained });
    }
    expect(await readFile(outsideFile, "utf8")).toBe("must remain unread\n");

    const commit = (
      await execute("git", ["rev-parse", "HEAD"], { cwd: process.cwd() })
    ).stdout.trim();
    const logEvents = [
      ...safeLogEvents(checked.invocation.stderr),
      ...safeLogEvents(delegated.invocation.stderr),
      ...safeLogEvents(mismatch.stderr),
      ...containmentResults.flatMap((item) => safeLogEvents(item.invocation.stderr)),
    ];
    const evidence: ReleaseEvidence = ReleaseEvidenceSchema.parse({
      schema_version: 1,
      run_id: randomUUID(),
      created_at: new Date().toISOString(),
      kind: "live-backend",
      profile: profile.profile,
      scenario: null,
      git_commit: commit,
      package_version: "0.1.0",
      node_version: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
      status: "pass",
      backend: profile.backend,
      model,
      checks: [
        {
          name: "status_ready",
          status: "pass",
          message: "The requested live profile reported one ready model with expected quality.",
          error_code: null,
        },
        {
          name: "bounded_delegation",
          status: "pass",
          message: "The known-defect consultation passed without changing its source file.",
          error_code: null,
        },
        {
          name: "quality_mismatch",
          status: "pass",
          message: "The opposite explicit quality returned QUALITY_MISMATCH without generation.",
          error_code: "QUALITY_MISMATCH",
        },
        {
          name: "containment",
          status: "pass",
          message: "Direct and symlink workspace escapes returned PATH_OUTSIDE_WORKSPACE.",
          error_code: "PATH_OUTSIDE_WORKSPACE",
        },
      ],
      workloads: [measured],
      stream: null,
      host_transcripts: [],
      log_events: logEvents,
      warnings: [],
    });
    const evidenceDirectory =
      process.env.LOCAL_MLX_DELEGATE_EVIDENCE_DIR ?? join(process.cwd(), "artifacts", "delegate");
    const output = await writeReleaseEvidence(evidenceDirectory, evidence);
    process.stderr.write(`Release evidence written: ${basename(output)}\n`);
  }, 900_000);
});
