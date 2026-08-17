import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, describe, expect, it } from "vitest";
import {
  DelegateResultSchema,
  StatusResultSchema,
  type StableErrorCode,
} from "../../src/contracts.js";
import {
  discoverHostExecutable,
  inspectHostConfiguration,
  type HostName,
} from "../../src/host-config.js";
import { DELEGATE_TOOL_NAME, STATUS_TOOL_NAME } from "../../src/mcp/server.js";
import {
  ReleaseEvidenceSchema,
  transcriptSummary,
  writeReleaseEvidence,
  type HostTranscript,
  type ReleaseEvidence,
} from "../../src/release-evidence.js";
import {
  invokeCli,
  liveEnvironment,
  liveProfile,
  safeLogEvents,
  status,
  type CliInvocation,
  type LiveProfile,
} from "./helpers.js";

const run = promisify(execFile);
const enabled = process.env.LOCAL_MLX_DELEGATE_BEHAVIOR === "1";
const scenario = process.env.LOCAL_MLX_DELEGATE_BEHAVIOR_SCENARIO;
if (enabled && scenario !== "ready" && scenario !== "offline") {
  throw new Error("LOCAL_MLX_DELEGATE_BEHAVIOR_SCENARIO must be ready or offline.");
}
const profile =
  enabled && scenario === "ready" ? liveProfile(process.env.LOCAL_MLX_DELEGATE_LIVE_PROFILE) : null;
const workspaceRoot = process.cwd();
const fixturePath = "tests/behavior/fixture-repo/src/cache.ts";
const temporaryPaths: string[] = [];

type NativeHost = Exclude<HostName, "vscode">;

afterAll(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  await unlink(join(workspaceRoot, "tests", "behavior", "fixture-repo", "escape.txt")).catch(
    () => undefined,
  );
});

function nativeArguments(host: NativeHost, prompt: string): string[] {
  if (host === "codex") {
    return ["exec", "--ephemeral", "--json", "--sandbox", "read-only", "-C", workspaceRoot, prompt];
  }
  if (host === "claude") {
    return [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--no-session-persistence",
      "--permission-mode",
      "plan",
      "--allowedTools",
      `mcp__local-mlx-delegate__${STATUS_TOOL_NAME}`,
      `mcp__local-mlx-delegate__${DELEGATE_TOOL_NAME}`,
    ];
  }
  return [
    "-p",
    prompt,
    "--output-format=json",
    "--available-tools=local-mlx-delegate",
    "--allow-tool=local-mlx-delegate",
    "--no-ask-user",
    "--no-custom-instructions",
  ];
}

async function invokeNative(
  host: NativeHost,
  prompt: string,
  environment: NodeJS.ProcessEnv,
): Promise<CliInvocation> {
  const overrideNames: Record<NativeHost, string> = {
    codex: "LOCAL_MLX_DELEGATE_CODEX_COMMAND",
    claude: "LOCAL_MLX_DELEGATE_CLAUDE_COMMAND",
    "copilot-cli": "LOCAL_MLX_DELEGATE_COPILOT_COMMAND",
  };
  const executable = environment[overrideNames[host]] ?? (await discoverHostExecutable(host));
  if (executable === null) {
    return { exitCode: 127, stdout: "", stderr: "required host executable is not installed" };
  }
  const inspection = await inspectHostConfiguration(host, workspaceRoot);
  if (!inspection.configured) {
    return { exitCode: 78, stdout: "", stderr: "required project MCP entry is not configured" };
  }
  try {
    const result = await run(executable, nativeArguments(host, prompt), {
      cwd: workspaceRoot,
      env: environment,
      timeout: 900_000,
      maxBuffer: 33_554_432,
    });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      exitCode: failure.code ?? 70,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function output(invocation: CliInvocation): string {
  return `${invocation.stdout}\n${invocation.stderr}`;
}

function invoked(invocation: CliInvocation, tool: string): boolean {
  return output(invocation).includes(tool);
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function nativeTranscript(options: {
  host: NativeHost;
  label: string;
  invocation: CliInvocation;
  tool: string;
  valid: boolean;
  expectedCode?: StableErrorCode;
}): HostTranscript {
  const called = invoked(options.invocation, options.tool);
  const codePresent =
    options.expectedCode === undefined || output(options.invocation).includes(options.expectedCode);
  const passed = options.invocation.exitCode === 0 && called && options.valid && codePresent;
  return transcriptSummary({
    host: options.host,
    status: passed ? "pass" : "fail",
    commandLabel: options.label,
    exitCode: options.invocation.exitCode,
    stdout: options.invocation.stdout,
    stderr: options.invocation.stderr,
    toolInvoked: called,
    structuredResultOk: passed,
    errorCode: options.expectedCode ?? null,
    message: passed
      ? "The native host invoked the expected project MCP tool and met the scenario invariant."
      : "The native host did not meet every required project MCP scenario invariant.",
  });
}

function delegationPrompt(
  profileValue: LiveProfile,
  options?: { wait?: boolean; long?: boolean },
): string {
  const wait = options?.wait === true;
  const task =
    options?.long === true
      ? "Print PROJECT_ID_OMITTED first, then give a detailed 1500-word analysis of the cache-key defect."
      : "Identify the cache-key defect and include the exact marker PROJECT_ID_OMITTED.";
  return [
    `Call ${DELEGATE_TOOL_NAME} exactly once.`,
    "Use these exact arguments:",
    JSON.stringify({
      task,
      cwd: workspaceRoot,
      paths: [fixturePath],
      include_diff: false,
      backend: profileValue.backend,
      quality: profileValue.quality,
      max_input_chars: 20_000,
      max_output_tokens: options?.long === true ? 2_048 : 256,
      busy_behavior: wait ? "wait" : "fail",
      max_wait_seconds: wait ? 300 : 0,
    }),
    "Do not read or edit files with host tools. Print the tool's actual backend, model ID, error code, and answer. Do not claim local delegation unless the tool returns ok=true.",
  ].join("\n");
}

function offlinePrompt(outsidePath: string): string {
  return [
    `Call ${STATUS_TOOL_NAME}, then call ${DELEGATE_TOOL_NAME} three times.`,
    "First delegate with the approved fixture path so the unavailable-backend error is observed.",
    "Second delegate with the direct outside path below. Third delegate with tests/behavior/fixture-repo/escape.txt.",
    `Direct outside path: ${outsidePath}`,
    `Use cwd ${workspaceRoot}, backend controller, quality fast, include_diff false, max_input_chars 20000, max_output_tokens 128, busy_behavior fail, and max_wait_seconds 0.`,
    `Use task "Containment diagnostic only" and paths ["${fixturePath}"] for the first delegate call.`,
    "Do not use host file or shell tools. Print each stable error code exactly. Never start, stop, load, unload, or swap a model.",
  ].join("\n");
}

async function vscodeReady(
  profileValue: LiveProfile,
  environment: NodeJS.ProcessEnv,
  model: string,
): Promise<HostTranscript> {
  const transport = new StdioClientTransport({
    command: join(workspaceRoot, "dist", "cli.js"),
    args: ["serve", "--workspace-root", workspaceRoot],
    cwd: workspaceRoot,
    env: definedEnvironment(environment),
    stderr: "pipe",
  });
  const client = new Client({ name: "vscode-release-equivalent", version: "1.0.0" });
  let stdout = "";
  let stderr = "";
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const result = await client.callTool({
      name: DELEGATE_TOOL_NAME,
      arguments: {
        task: "Identify the cache-key defect and include marker PROJECT_ID_OMITTED.",
        cwd: workspaceRoot,
        paths: [fixturePath],
        backend: profileValue.backend,
        quality: profileValue.quality,
        max_input_chars: 20_000,
        max_output_tokens: 256,
      },
    });
    const structured = DelegateResultSchema.parse(result.structuredContent);
    stdout = JSON.stringify({ tools: tools.tools.map((tool) => tool.name), structured });
    const passed =
      tools.tools.some((tool) => tool.name === DELEGATE_TOOL_NAME) &&
      structured.ok &&
      structured.backend === profileValue.backend &&
      structured.model?.id === model &&
      structured.answer?.toLowerCase().includes("project_id_omitted") === true;
    return transcriptSummary({
      host: "vscode",
      status: passed ? "pass" : "fail",
      commandLabel: "vscode-equivalent-ready",
      exitCode: 0,
      stdout,
      stderr,
      toolInvoked: true,
      structuredResultOk: passed,
      message: passed
        ? "The VS Code-equivalent MCP client discovered and invoked delegation successfully."
        : "The VS Code-equivalent MCP call did not meet every ready-scenario invariant.",
    });
  } catch (error) {
    stderr = error instanceof Error ? error.name : "unexpected failure";
    return transcriptSummary({
      host: "vscode",
      status: "fail",
      commandLabel: "vscode-equivalent-ready",
      exitCode: 70,
      stdout,
      stderr,
      toolInvoked: false,
      structuredResultOk: false,
      message: "The VS Code-equivalent MCP call failed safely.",
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function vscodeOffline(
  outsidePath: string,
  environment: NodeJS.ProcessEnv,
): Promise<HostTranscript> {
  const transport = new StdioClientTransport({
    command: join(workspaceRoot, "dist", "cli.js"),
    args: ["serve", "--workspace-root", workspaceRoot],
    cwd: workspaceRoot,
    env: definedEnvironment(environment),
    stderr: "pipe",
  });
  const client = new Client({ name: "vscode-release-equivalent", version: "1.0.0" });
  try {
    await client.connect(transport);
    const status = StatusResultSchema.parse(
      (await client.callTool({ name: STATUS_TOOL_NAME, arguments: { backend: "controller" } }))
        .structuredContent,
    );
    const codes: string[] = [];
    for (const path of [fixturePath, outsidePath, "tests/behavior/fixture-repo/escape.txt"]) {
      const result = DelegateResultSchema.parse(
        (
          await client.callTool({
            name: DELEGATE_TOOL_NAME,
            arguments: {
              task: "Containment diagnostic only.",
              cwd: workspaceRoot,
              paths: [path],
              backend: "controller",
              quality: "fast",
              max_input_chars: 20_000,
              max_output_tokens: 128,
            },
          })
        ).structuredContent,
      );
      if (result.error !== null) codes.push(result.error.code);
    }
    const passed =
      !status.ok &&
      codes[0] === "BACKEND_UNAVAILABLE" &&
      codes[1] === "PATH_OUTSIDE_WORKSPACE" &&
      codes[2] === "PATH_OUTSIDE_WORKSPACE";
    const stdout = JSON.stringify({ status_error: status.error?.code ?? null, codes });
    return transcriptSummary({
      host: "vscode",
      status: passed ? "pass" : "fail",
      commandLabel: "vscode-equivalent-offline",
      exitCode: 0,
      stdout,
      stderr: "",
      toolInvoked: true,
      structuredResultOk: passed,
      message: passed
        ? "The VS Code-equivalent MCP client observed unavailable and containment errors."
        : "The VS Code-equivalent MCP client did not meet every offline invariant.",
    });
  } catch (error) {
    return transcriptSummary({
      host: "vscode",
      status: "fail",
      commandLabel: "vscode-equivalent-offline",
      exitCode: 70,
      stdout: "",
      stderr: error instanceof Error ? error.name : "unexpected failure",
      toolInvoked: false,
      structuredResultOk: false,
      message: "The VS Code-equivalent offline call failed safely.",
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function waitForState(
  profileValue: LiveProfile,
  environment: NodeJS.ProcessEnv,
  predicate: (status: ReturnType<typeof StatusResultSchema.parse>) => boolean,
  timeoutMs: number,
): Promise<{ observed: boolean; invocations: CliInvocation[] }> {
  const invocations: CliInvocation[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const invocation = await invokeCli(
      ["status", "--backend", profileValue.backend, "--json"],
      environment,
    );
    invocations.push(invocation);
    try {
      const value = StatusResultSchema.parse(JSON.parse(invocation.stdout) as unknown);
      if (predicate(value)) return { observed: true, invocations };
    } catch {
      // Keep the bounded poll diagnostic-only; the final evidence records failure.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { observed: false, invocations };
}

async function gitCommit(): Promise<string> {
  return (await run("git", ["rev-parse", "HEAD"], { cwd: workspaceRoot })).stdout.trim();
}

async function recordEvidence(evidence: ReleaseEvidence): Promise<string> {
  const directory =
    process.env.LOCAL_MLX_DELEGATE_EVIDENCE_DIR ?? join(workspaceRoot, "artifacts", "delegate");
  return await writeReleaseEvidence(directory, ReleaseEvidenceSchema.parse(evidence));
}

describe.skipIf(!enabled)("cross-host release behavior", () => {
  it.skipIf(scenario !== "ready")(
    "runs sequential consultation plus fail-fast and bounded-wait capacity arbitration",
    async () => {
      if (profile === null) throw new Error("A ready behavior run requires a live profile.");
      const stateDirectory = await mkdtemp(join(tmpdir(), "local-mlx-behavior-ready-"));
      temporaryPaths.push(stateDirectory);
      const environment = liveEnvironment(profile, stateDirectory);
      const fixtureBefore = await readFile(join(workspaceRoot, fixturePath), "utf8");
      const preflight = await status(profile, environment);
      const model = preflight.result.model?.id;
      if (!preflight.result.ok || model === undefined) {
        throw new Error("The selected behavior profile is not ready and unambiguous.");
      }
      const nativeHosts: readonly [NativeHost, NativeHost, NativeHost] = [
        "codex",
        "claude",
        "copilot-cli",
      ];
      const transcripts: HostTranscript[] = [];
      const logEvents = [...safeLogEvents(preflight.invocation.stderr)];
      for (const host of nativeHosts) {
        const invocation = await invokeNative(host, delegationPrompt(profile), environment);
        transcripts.push(
          nativeTranscript({
            host,
            label: "sequential-known-defect",
            invocation,
            tool: DELEGATE_TOOL_NAME,
            valid:
              output(invocation).toLowerCase().includes("project_id_omitted") &&
              output(invocation).includes(profile.backend) &&
              output(invocation).includes(model),
          }),
        );
        logEvents.push(...safeLogEvents(invocation.stderr));
      }
      transcripts.push(await vscodeReady(profile, environment, model));

      const first = invokeNative(
        nativeHosts[0],
        delegationPrompt(profile, { long: true }),
        environment,
      );
      const busy = await waitForState(
        profile,
        environment,
        (value) => value.availability === "busy",
        120_000,
      );
      logEvents.push(...busy.invocations.flatMap((item) => safeLogEvents(item.stderr)));
      const failFast = await invokeNative(nativeHosts[1], delegationPrompt(profile), environment);
      const firstResult = await first;
      transcripts.push(
        nativeTranscript({
          host: nativeHosts[0],
          label: "capacity-owner-fail-fast",
          invocation: firstResult,
          tool: DELEGATE_TOOL_NAME,
          valid: busy.observed && output(firstResult).includes(model),
        }),
        nativeTranscript({
          host: nativeHosts[1],
          label: "capacity-competitor-fail-fast",
          invocation: failFast,
          tool: DELEGATE_TOOL_NAME,
          valid: busy.observed,
          expectedCode: "BACKEND_BUSY",
        }),
      );

      const secondOwner = invokeNative(
        nativeHosts[0],
        delegationPrompt(profile, { long: true }),
        environment,
      );
      const secondBusy = await waitForState(
        profile,
        environment,
        (value) => value.availability === "busy",
        120_000,
      );
      const waiter = invokeNative(
        nativeHosts[1],
        delegationPrompt(profile, { wait: true }),
        environment,
      );
      const queued = await waitForState(
        profile,
        environment,
        (value) => value.queue_depth > 0,
        120_000,
      );
      const [secondOwnerResult, waiterResult] = await Promise.all([secondOwner, waiter]);
      logEvents.push(
        ...secondBusy.invocations.flatMap((item) => safeLogEvents(item.stderr)),
        ...queued.invocations.flatMap((item) => safeLogEvents(item.stderr)),
      );
      transcripts.push(
        nativeTranscript({
          host: nativeHosts[0],
          label: "capacity-owner-wait",
          invocation: secondOwnerResult,
          tool: DELEGATE_TOOL_NAME,
          valid: secondBusy.observed && output(secondOwnerResult).includes(model),
        }),
        nativeTranscript({
          host: nativeHosts[1],
          label: "capacity-competitor-wait",
          invocation: waiterResult,
          tool: DELEGATE_TOOL_NAME,
          valid:
            queued.observed && output(waiterResult).toLowerCase().includes("project_id_omitted"),
        }),
      );

      const unchanged =
        (await readFile(join(workspaceRoot, fixturePath), "utf8")) === fixtureBefore;
      const passed = transcripts.every((item) => item.status === "pass") && unchanged;
      const evidence = ReleaseEvidenceSchema.parse({
        schema_version: 1,
        run_id: randomUUID(),
        created_at: new Date().toISOString(),
        kind: "behavior",
        profile: profile.profile,
        scenario: "capacity",
        git_commit: await gitCommit(),
        package_version: "0.1.0",
        node_version: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        status: passed ? "pass" : "fail",
        backend: profile.backend,
        model,
        checks: [
          {
            name: "cross_host_delegation",
            status: transcripts.slice(0, 4).every((item) => item.status === "pass")
              ? "pass"
              : "fail",
            message:
              "Three native CLI hosts and the VS Code-equivalent client ran the same known-defect consultation.",
            error_code: null,
          },
          {
            name: "capacity_arbitration",
            status: busy.observed && secondBusy.observed && queued.observed ? "pass" : "fail",
            message:
              "Cross-process fail-fast and bounded FIFO wait behavior were observed against capacity one.",
            error_code:
              busy.observed && secondBusy.observed && queued.observed ? null : "BACKEND_BUSY",
          },
          {
            name: "fixture_unchanged",
            status: unchanged ? "pass" : "fail",
            message:
              "The tracked known-defect fixture remained byte-identical during consultation.",
            error_code: null,
          },
        ],
        workloads: [],
        stream: null,
        host_transcripts: transcripts,
        log_events: logEvents,
        warnings: [
          "Host stdout and stderr are retained only as byte counts and SHA-256 digests; raw prompts, source, answers, paths, and credentials are not written to evidence.",
        ],
      });
      const path = await recordEvidence(evidence);
      process.stderr.write(`Behavior evidence written: ${basename(path)}\n`);
      expect(passed).toBe(true);
    },
    3_600_000,
  );

  it.skipIf(scenario !== "offline")(
    "records consistent unavailable and canonical-containment behavior without lifecycle actions",
    async () => {
      const stateDirectory = await mkdtemp(join(tmpdir(), "local-mlx-behavior-offline-"));
      temporaryPaths.push(stateDirectory);
      const outsideDirectory = await mkdtemp(join(tmpdir(), "local-mlx-behavior-outside-"));
      temporaryPaths.push(outsideDirectory);
      const outsidePath = join(outsideDirectory, "sensitive.txt");
      const requestedOutsidePath = relative(workspaceRoot, outsidePath);
      await writeFile(outsidePath, "behavior containment sentinel\n", { mode: 0o600 });
      const link = join(workspaceRoot, "tests", "behavior", "fixture-repo", "escape.txt");
      await symlink(outsidePath, link);
      const environment = {
        ...process.env,
        LOCAL_MLX_DELEGATE_STATE_DIRECTORY: stateDirectory,
      };
      const before = await readFile(outsidePath, "utf8");
      const nativeHosts: readonly [NativeHost, NativeHost, NativeHost] = [
        "codex",
        "claude",
        "copilot-cli",
      ];
      const transcripts: HostTranscript[] = [];
      const logEvents = [];
      for (const host of nativeHosts) {
        const invocation = await invokeNative(
          host,
          offlinePrompt(requestedOutsidePath),
          environment,
        );
        const rendered = output(invocation);
        transcripts.push(
          nativeTranscript({
            host,
            label: "offline-and-containment",
            invocation,
            tool: DELEGATE_TOOL_NAME,
            valid:
              invoked(invocation, STATUS_TOOL_NAME) &&
              rendered.includes("BACKEND_UNAVAILABLE") &&
              rendered.match(/PATH_OUTSIDE_WORKSPACE/gu)?.length !== undefined &&
              (rendered.match(/PATH_OUTSIDE_WORKSPACE/gu)?.length ?? 0) >= 2,
          }),
        );
        logEvents.push(...safeLogEvents(invocation.stderr));
      }
      transcripts.push(await vscodeOffline(outsidePath, environment));
      const unchanged = (await readFile(outsidePath, "utf8")) === before;
      const directStatus = await invokeCli(["status", "--json"], environment);
      const allOffline = StatusResultSchema.parse(
        JSON.parse(directStatus.stdout) as unknown,
      ).configured_backends.every((backend) => !backend.health);
      logEvents.push(...safeLogEvents(directStatus.stderr));
      const passed = allOffline && unchanged && transcripts.every((item) => item.status === "pass");
      const evidence = ReleaseEvidenceSchema.parse({
        schema_version: 1,
        run_id: randomUUID(),
        created_at: new Date().toISOString(),
        kind: "behavior",
        profile: null,
        scenario: "offline",
        git_commit: await gitCommit(),
        package_version: "0.1.0",
        node_version: process.versions.node,
        platform: process.platform,
        architecture: process.arch,
        status: passed ? "pass" : "fail",
        backend: null,
        model: null,
        checks: [
          {
            name: "all_backends_offline",
            status: allOffline ? "pass" : "fail",
            message: "The release scenario observed no healthy configured inference backend.",
            error_code: allOffline ? "BACKEND_UNAVAILABLE" : null,
          },
          {
            name: "cross_host_safe_failure",
            status: transcripts.every((item) => item.status === "pass") ? "pass" : "fail",
            message: "Every required host observed stable unavailable and containment failures.",
            error_code: "PATH_OUTSIDE_WORKSPACE",
          },
          {
            name: "outside_file_unchanged",
            status: unchanged ? "pass" : "fail",
            message:
              "The outside-workspace sentinel remained byte-identical and unread by the server.",
            error_code: null,
          },
        ],
        workloads: [],
        stream: null,
        host_transcripts: transcripts,
        log_events: logEvents,
        warnings: [
          "The harness never starts, stops, loads, unloads, or swaps models; operators must establish the offline state before running this scenario.",
        ],
      });
      const path = await recordEvidence(evidence);
      process.stderr.write(`Behavior evidence written: ${basename(path)}\n`);
      expect(passed).toBe(true);
    },
    1_800_000,
  );
});
