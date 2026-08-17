import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  DelegateResultSchema,
  StatusResultSchema,
  type BackendName,
  type DelegateResult,
  type StableErrorCode,
  type StatusResult,
} from "../../src/contracts.js";
import {
  ReleaseProfileSchema,
  StreamMeasurementSchema,
  WorkloadMeasurementSchema,
  sha256,
  type ReleaseProfile,
  type StreamMeasurement,
  type WorkloadMeasurement,
} from "../../src/release-evidence.js";

const execute = promisify(execFile);

export type LiveProfile = {
  profile: ReleaseProfile;
  backend: BackendName;
  quality: "fast" | "deep";
};

export type Workload = {
  name: WorkloadMeasurement["workload"];
  task: string;
  paths: string[];
  includeDiff: boolean;
  expectedTerms: string[];
  structured: boolean;
  maximumInputCharacters: number;
  maximumOutputTokens: number;
};

export type CliInvocation = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SafeLogEvent = {
  event: string;
  request_id: string | null;
  command: string | null;
  backend: BackendName | null;
  model: string | null;
  duration_ms: number | null;
  outcome: string | null;
  error_code: StableErrorCode | null;
};

const profileMap: Record<ReleaseProfile, LiveProfile> = {
  "single-fast": { profile: "single-fast", backend: "controller", quality: "fast" },
  "single-deep": { profile: "single-deep", backend: "controller", quality: "deep" },
  "worker-fast": { profile: "worker-fast", backend: "worker", quality: "fast" },
  "worker-deep": { profile: "worker-deep", backend: "worker", quality: "deep" },
  "cluster-fast": { profile: "cluster-fast", backend: "cluster", quality: "fast" },
  "cluster-deep": { profile: "cluster-deep", backend: "cluster", quality: "deep" },
};

export function liveProfile(value: string | undefined): LiveProfile {
  const profile = ReleaseProfileSchema.parse(value);
  return profileMap[profile];
}

export function liveEnvironment(profile: LiveProfile, stateDirectory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LOCAL_MLX_DELEGATE_STATE_DIRECTORY: stateDirectory,
    LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS:
      process.env.LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS ?? "600000",
    LOCAL_MLX_DELEGATE_CONTROLLER_ENABLED: String(profile.backend === "controller"),
    LOCAL_MLX_DELEGATE_WORKER_ENABLED: String(profile.backend === "worker"),
    LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: String(profile.backend === "cluster"),
  };
}

export async function invokeCli(
  arguments_: string[],
  environment: NodeJS.ProcessEnv,
): Promise<CliInvocation> {
  try {
    const result = await execute(
      process.execPath,
      [join(process.cwd(), "dist", "cli.js"), ...arguments_],
      {
        cwd: process.cwd(),
        env: environment,
        timeout: 900_000,
        maxBuffer: 16_777_216,
      },
    );
    return { ...result, exitCode: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 70,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

export function safeLogEvents(stderr: string): SafeLogEvent[] {
  const events: SafeLogEvent[] = [];
  for (const line of stderr.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const parsed = z
      .object({
        event: z.string(),
        request_id: z.string().nullable(),
        command: z.string().nullable(),
        backend: z.enum(["controller", "worker", "cluster"]).nullable(),
        model: z.string().nullable(),
        duration_ms: z.number().int().nonnegative().nullable(),
        outcome: z.string().nullable(),
        error_code: z
          .enum([
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
          ])
          .nullable(),
      })
      .loose()
      .safeParse(value);
    if (parsed.success) {
      events.push({
        event: parsed.data.event,
        request_id: parsed.data.request_id,
        command: parsed.data.command,
        backend: parsed.data.backend,
        model: parsed.data.model,
        duration_ms: parsed.data.duration_ms,
        outcome: parsed.data.outcome,
        error_code: parsed.data.error_code,
      });
    }
  }
  return events;
}

async function git(directory: string, arguments_: string[]): Promise<void> {
  await execute("git", arguments_, { cwd: directory, timeout: 30_000, maxBuffer: 1_048_576 });
}

function repeated(prefix: string, targetCharacters: number): string {
  const lines: string[] = [];
  let characters = 0;
  for (let index = 0; characters < targetCharacters; index += 1) {
    const line = `${prefix} record_${String(index).padStart(5, "0")} remains deterministic.`;
    lines.push(line);
    characters += line.length + 1;
  }
  return `${lines.join("\n")}\n`;
}

export async function createEvaluationWorkspace(): Promise<{
  root: string;
  workloads: Workload[];
}> {
  const root = await mkdtemp(join(tmpdir(), "local-mlx-evaluation-"));
  await mkdir(join(root, "src"));
  await writeFile(
    join(root, "src", "summary.txt"),
    `${repeated("The loopback service refuses redirects and", 8_000)}\nVerification marker: LOOPBACK_NO_REDIRECTS.\n`,
  );
  await writeFile(
    join(root, "src", "permissions.ts"),
    `${repeated("// Baseline permission rule", 38_000)}\nexport function canDelete(role: string): boolean {\n  return role === "admin";\n}\n`,
  );
  await writeFile(
    join(root, "src", "structured.txt"),
    "schema_version=1\nsafe=true\nitems=alpha,beta,gamma\n",
  );
  await writeFile(
    join(root, "src", "cache.ts"),
    "export function cacheKey(userId: string, projectId: string): string {\n  return `${userId}:${userId}`;\n}\n",
  );
  for (let index = 0; index < 5; index += 1) {
    const special =
      index === 2
        ? "Controller and cluster both reserve resource group controller. Marker: RESOURCE_COLLISION.\n"
        : "";
    await writeFile(
      join(root, "src", `analysis-${String(index)}.txt`),
      `${repeated(`Subsystem ${String(index)}`, 20_000)}${special}`,
    );
  }
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "user.name=Local MLX Test",
    "-c",
    "user.email=local-mlx@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture baseline",
  ]);
  const permissions = await readFile(join(root, "src", "permissions.ts"), "utf8");
  await writeFile(
    join(root, "src", "permissions.ts"),
    permissions.replace('return role === "admin";', 'return role === "admin" || role === "staff";'),
  );
  return {
    root,
    workloads: [
      {
        name: "summary-2k",
        task: "Summarize the selected service policy and include its verification marker.",
        paths: ["src/summary.txt"],
        includeDiff: false,
        expectedTerms: ["loopback_no_redirects"],
        structured: false,
        maximumInputCharacters: 20_000,
        maximumOutputTokens: 256,
      },
      {
        name: "diff-review-10k",
        task: "Review the tracked permission diff for a privilege regression. Name the marker STAFF_ESCALATION if staff gained delete access.",
        paths: ["src/permissions.ts"],
        includeDiff: true,
        expectedTerms: ["staff_escalation"],
        structured: false,
        maximumInputCharacters: 100_000,
        maximumOutputTokens: 512,
      },
      {
        name: "analysis-25k",
        task: "Analyze the selected subsystem notes for a shared physical-resource conflict and include its marker.",
        paths: Array.from({ length: 5 }, (_, index) => `src/analysis-${String(index)}.txt`),
        includeDiff: false,
        expectedTerms: ["resource_collision"],
        structured: false,
        maximumInputCharacters: 160_000,
        maximumOutputTokens: 512,
      },
      {
        name: "structured",
        task: 'Return only JSON with exactly schema_version, safe, and count. Convert the selected facts to {"schema_version":1,"safe":true,"count":3}.',
        paths: ["src/structured.txt"],
        includeDiff: false,
        expectedTerms: ["schema_version", "safe", "count"],
        structured: true,
        maximumInputCharacters: 20_000,
        maximumOutputTokens: 128,
      },
      {
        name: "bug-find",
        task: "Find the cache-key defect. Include marker PROJECT_ID_OMITTED only if the project ID is not represented in the returned key.",
        paths: ["src/cache.ts"],
        includeDiff: false,
        expectedTerms: ["project_id_omitted"],
        structured: false,
        maximumInputCharacters: 20_000,
        maximumOutputTokens: 256,
      },
    ],
  };
}

function structuredValid(answer: string): boolean {
  const unfenced = answer
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
  try {
    const value = JSON.parse(unfenced) as unknown;
    return z
      .object({ schema_version: z.literal(1), safe: z.literal(true), count: z.literal(3) })
      .strict()
      .safeParse(value).success;
  } catch {
    return false;
  }
}

export function measurement(workload: Workload, result: DelegateResult): WorkloadMeasurement {
  const answer = result.answer ?? "";
  const normalized = answer.toLowerCase();
  const matched = workload.expectedTerms.filter((term) => normalized.includes(term)).length;
  const responseValid = workload.structured ? structuredValid(answer) : answer.trim().length > 0;
  return WorkloadMeasurementSchema.parse({
    workload: workload.name,
    ok: result.ok,
    backend: result.backend,
    model: result.model?.id ?? null,
    actual_quality: result.actual_quality,
    elapsed_seconds: result.elapsed_seconds,
    queue_seconds: result.queue_seconds,
    input_characters: result.input_characters,
    output_characters: answer.length,
    answer_sha256: answer.length === 0 ? null : sha256(answer),
    correctness_score:
      workload.expectedTerms.length === 0 ? 0 : matched / workload.expectedTerms.length,
    response_valid: responseValid,
    error_code: result.error?.code ?? null,
  });
}

export async function status(
  profile: LiveProfile,
  environment: NodeJS.ProcessEnv,
): Promise<{ result: StatusResult; invocation: CliInvocation }> {
  const invocation = await invokeCli(
    ["status", "--backend", profile.backend, "--json"],
    environment,
  );
  return {
    result: StatusResultSchema.parse(JSON.parse(invocation.stdout) as unknown),
    invocation,
  };
}

export async function delegate(
  profile: LiveProfile,
  environment: NodeJS.ProcessEnv,
  root: string,
  workload: Workload,
): Promise<{ result: DelegateResult; invocation: CliInvocation }> {
  const arguments_ = [
    "delegate",
    "--task",
    workload.task,
    "--cwd",
    root,
    "--workspace-root",
    root,
    "--backend",
    profile.backend,
    "--quality",
    profile.quality,
    "--max-input-chars",
    String(workload.maximumInputCharacters),
    "--max-output-tokens",
    String(workload.maximumOutputTokens),
    "--json",
  ];
  for (const path of workload.paths) arguments_.push("--path", path);
  if (workload.includeDiff) arguments_.push("--include-diff");
  const invocation = await invokeCli(arguments_, environment);
  return {
    result: DelegateResultSchema.parse(JSON.parse(invocation.stdout) as unknown),
    invocation,
  };
}

export async function streamMeasurement(
  endpoint: string,
  model: string,
): Promise<StreamMeasurement> {
  const started = performance.now();
  let firstText: number | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  try {
    const response = await fetch(new URL("chat/completions", `${endpoint.replace(/\/$/u, "")}/`), {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: `${"Read this deterministic benchmark context. ".repeat(256)}Reply with the word ready. Nonce ${randomUUID()}.`,
          },
        ],
        temperature: 0,
        max_tokens: 64,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || response.body === null) throw new Error("stream response unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    let responseBytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const bytes: unknown = chunk.value;
      if (!(bytes instanceof Uint8Array)) throw new Error("stream returned invalid bytes");
      responseBytes += bytes.byteLength;
      if (responseBytes > 16_777_216) throw new Error("stream response exceeded safe limit");
      buffered += decoder.decode(bytes, { stream: true });
      if (buffered.length > 1_048_576) throw new Error("stream line exceeded safe limit");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        let value: unknown;
        try {
          value = JSON.parse(line.slice(6)) as unknown;
        } catch {
          continue;
        }
        const chunkValue = z
          .object({
            choices: z
              .array(
                z.object({
                  delta: z
                    .object({
                      content: z.string().optional(),
                      reasoning_content: z.string().optional(),
                    })
                    .loose(),
                }),
              )
              .optional(),
            usage: z
              .object({
                prompt_tokens: z.number().int().nonnegative().optional(),
                completion_tokens: z.number().int().nonnegative().optional(),
              })
              .nullish(),
          })
          .loose()
          .safeParse(value);
        if (!chunkValue.success) continue;
        if (chunkValue.data.usage?.prompt_tokens !== undefined)
          promptTokens = chunkValue.data.usage.prompt_tokens;
        if (chunkValue.data.usage?.completion_tokens !== undefined)
          completionTokens = chunkValue.data.usage.completion_tokens;
        const hasText = chunkValue.data.choices?.some(
          (choice) =>
            (choice.delta.content?.length ?? 0) > 0 ||
            (choice.delta.reasoning_content?.length ?? 0) > 0,
        );
        if (hasText === true && firstText === null) firstText = performance.now();
      }
    }
    const finished = performance.now();
    if (firstText === null) throw new Error("stream returned no text");
    const ttft = (firstText - started) / 1_000;
    const total = (finished - started) / 1_000;
    const decode = Math.max((finished - firstText) / 1_000, 0.001);
    return StreamMeasurementSchema.parse({
      available: true,
      time_to_first_text_seconds: ttft,
      total_seconds: total,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      effective_prefill_tokens_per_second:
        promptTokens === null ? null : promptTokens / Math.max(ttft, 0.001),
      decode_tokens_per_second: completionTokens === null ? null : completionTokens / decode,
      startup_seconds: null,
      peak_memory_bytes: null,
      unavailable_reason:
        "Lifecycle startup time and upstream peak memory are not exposed by the read-only OpenAI-compatible API.",
    });
  } catch {
    return StreamMeasurementSchema.parse({
      available: false,
      time_to_first_text_seconds: null,
      total_seconds: null,
      prompt_tokens: null,
      completion_tokens: null,
      effective_prefill_tokens_per_second: null,
      decode_tokens_per_second: null,
      startup_seconds: null,
      peak_memory_bytes: null,
      unavailable_reason: "The endpoint did not provide a valid bounded streaming measurement.",
    });
  }
}
