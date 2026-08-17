import http from "node:http";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type DelegateConfig } from "../src/config.js";
import { AvailabilityCoordinator } from "../src/coordinator.js";
import { DelegateInputSchema, DelegateResultSchema } from "../src/contracts.js";
import { DelegationService } from "../src/delegation.js";
import { Logger } from "../src/logging.js";
import { StatusService } from "../src/service.js";

const execFileAsync = promisify(execFile);

type InferenceMode = "success" | "malformed" | "invalid" | "reasoning-only" | "slow" | "http-error";
type FakeInference = {
  url: string;
  requests: { method: string; path: string }[];
  completionBodies: unknown[];
  close(): Promise<void>;
};

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function startInference(
  model: string,
  mode: InferenceMode = "success",
  visibleModels: string[] = [model],
): Promise<FakeInference> {
  const requests: { method: string; path: string }[] = [];
  const completionBodies: unknown[] = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end("{}");
      return;
    }
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: visibleModels.map((id) => ({ id, object: "model" })) }));
      return;
    }
    if (request.url === "/api/v1/models") {
      response.end(
        JSON.stringify({
          models: visibleModels.map((id) => ({
            type: id.includes("embedding") ? "embedding" : "llm",
            key: id,
            loaded_instances: id === model ? [{ id }] : [],
          })),
        }),
      );
      return;
    }
    if (request.url === "/v1/chat/completions" && request.method === "POST") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        completionBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        if (mode === "slow") {
          setTimeout(
            () =>
              response.end(
                JSON.stringify({ choices: [{ message: { content: "late response" } }] }),
              ),
            150,
          );
        } else if (mode === "malformed") {
          response.end("{");
        } else if (mode === "invalid") {
          response.end('{"choices":[]}');
        } else if (mode === "reasoning-only") {
          response.end(
            JSON.stringify({
              choices: [
                {
                  finish_reason: "length",
                  message: { content: "", reasoning_content: "private reasoning" },
                },
              ],
            }),
          );
        } else if (mode === "http-error") {
          response.statusCode = 500;
          response.end('{"private":"upstream body"}');
        } else {
          response.end(
            JSON.stringify({
              choices: [{ message: { content: "Candidate finding" } }],
              usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 },
            }),
          );
        }
      });
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No address");
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    completionBodies,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function fixture(): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "local-mlx-delegate-"));
  temporaryDirectories.push(root);
  const path = join(root, "source.ts");
  await writeFile(path, "export const value = 1;\n", "utf8");
  return { root, path };
}

function config(root: string, upstream: FakeInference, model: string): DelegateConfig {
  const value: DelegateConfig = structuredClone(DEFAULT_CONFIG);
  value.workspace_root = root;
  value.coordination.state_directory = join(root, ".delegate-state");
  value.backends.controller.url = upstream.url;
  value.backends.controller.model_discovery = "openai";
  value.backends.worker.model_discovery = "openai";
  value.backends.controller.model_quality.fast = [model];
  value.backends.controller.model_quality.deep = [];
  value.backends.worker.enabled = false;
  value.backends.cluster.enabled = false;
  return value;
}

function input(root: string, overrides: Record<string, unknown> = {}) {
  return DelegateInputSchema.parse({
    task: "Find likely defects",
    cwd: root,
    paths: ["source.ts"],
    ...overrides,
  });
}

async function service(value: DelegateConfig): Promise<DelegationService> {
  const logger = new Logger("error", () => undefined);
  const status = new StatusService(value, undefined, logger);
  return await DelegationService.create({ config: value, statusService: status, logger });
}

describe("safe delegation pipeline", () => {
  it("propagates the active model, output limit, task, context, backend, and quality", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model);
    const { root } = await fixture();
    try {
      const result = await (
        await service(config(root, upstream, model))
      ).delegate(input(root, { max_output_tokens: 777, quality: "fast", backend: "controller" }));
      expect(DelegateResultSchema.parse(result)).toMatchObject({
        ok: true,
        backend: "controller",
        actual_quality: "fast",
        answer: "Candidate finding",
        queue_seconds: 0,
        context_window_tokens: 32_768,
        prompt_tokens_actual: 321,
        completion_tokens_actual: 12,
      });
      expect(result.context_manifest).toHaveLength(1);
      expect(result.context_manifest[0]).toMatchObject({
        relative_path: "source.ts",
        omitted: false,
      });
      expect(upstream.requests).toEqual([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/v1/models" },
        { method: "POST", path: "/v1/chat/completions" },
      ]);
      expect(upstream.completionBodies).toHaveLength(1);
      expect(upstream.completionBodies[0]).toMatchObject({
        model,
        max_tokens: 777,
        stream: false,
      });
      expect(upstream.completionBodies[0]).not.toHaveProperty("reasoning_effort");
      const body = JSON.stringify(upstream.completionBodies[0]);
      expect(body).toContain("Find likely defects");
      expect(body).toContain("source.ts");
      expect(body).toContain("export const value = 1");
      expect(body).toContain("REQUESTED QUALITY\\nfast");
      expect(body).toContain("REQUESTED BACKEND\\ncontroller");
    } finally {
      await upstream.close();
    }
  });

  it("delegates only to the loaded LM Studio LLM when JIT exposes other catalog entries", async () => {
    const model = "loaded-fast-model";
    const upstream = await startInference(model, "success", [
      model,
      "unloaded-deep-model",
      "embedding-model",
    ]);
    const { root } = await fixture();
    const value = config(root, upstream, model);
    value.backends.controller.model_discovery = "lmstudio";
    try {
      const result = await (
        await service(value)
      ).delegate(input(root, { quality: "fast", backend: "controller" }));
      expect(result).toMatchObject({
        ok: true,
        backend: "controller",
        model: { id: model },
        actual_quality: "fast",
      });
      expect(upstream.requests).toEqual([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/v1/models" },
        { method: "GET", path: "/api/v1/models" },
        { method: "POST", path: "/v1/chat/completions" },
      ]);
      expect(upstream.completionBodies[0]).toMatchObject({
        model,
        reasoning_effort: "none",
      });
    } finally {
      await upstream.close();
    }
  });

  it("propagates an explicitly requested tracked diff to the completion prompt", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model);
    const { root, path } = await fixture();
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await execFileAsync("git", ["add", "source.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
    await writeFile(path, "export const value = 2;\n", "utf8");
    try {
      const result = await (
        await service(config(root, upstream, model))
      ).delegate(input(root, { paths: [], include_diff: true }));
      expect(result.ok).toBe(true);
      expect(result.context_manifest).toEqual(
        expect.arrayContaining([expect.objectContaining({ relative_path: ".git-diff" })]),
      );
      const body = JSON.stringify(upstream.completionBodies[0]);
      expect(body).toContain("diff --git");
      expect(body).toContain("export const value = 2");
    } finally {
      await upstream.close();
    }
  });

  it.each([
    ["malformed", "UPSTREAM_PROTOCOL_ERROR"],
    ["invalid", "UPSTREAM_PROTOCOL_ERROR"],
    ["http-error", "UPSTREAM_PROTOCOL_ERROR"],
  ] as const)("maps %s completion failures safely without retries", async (mode, code) => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model, mode);
    const { root } = await fixture();
    try {
      const result = await (await service(config(root, upstream, model))).delegate(input(root));
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("upstream body");
    } finally {
      await upstream.close();
    }
  });

  it("rejects reasoning-only completions without exposing private reasoning", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model, "reasoning-only");
    const { root } = await fixture();
    try {
      const result = await (await service(config(root, upstream, model))).delegate(input(root));
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "UPSTREAM_PROTOCOL_ERROR",
          message: "The backend did not return a final answer within the output limit.",
          details: {
            empty_content: true,
            finish_reason: "length",
            reasoning_content_present: true,
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain("private reasoning");
    } finally {
      await upstream.close();
    }
  });

  it("bounds ambiguous completion timeouts and never retries generation", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model, "slow");
    const { root } = await fixture();
    const value = config(root, upstream, model);
    value.generation_timeout_ms = 50;
    try {
      const started = performance.now();
      const result = await (await service(value)).delegate(input(root));
      expect(result.error?.code).toBe("UPSTREAM_TIMEOUT");
      expect(result.availability).toBe("cooldown");
      expect(performance.now() - started).toBeLessThan(500);
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      const state = await new AvailabilityCoordinator(value.coordination).inspect();
      expect(state.leases).toMatchObject([{ state: "cooldown", backend: "controller" }]);
    } finally {
      await upstream.close();
    }
  });

  it("returns quality mismatch and input-limit errors without generation", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model);
    const { root } = await fixture();
    try {
      const delegate = await service(config(root, upstream, model));
      const mismatch = await delegate.delegate(input(root, { quality: "deep" }));
      expect(mismatch.error?.code).toBe("QUALITY_MISMATCH");
      const oversized = await delegate.delegate(
        input(root, { task: "x".repeat(950), max_input_chars: 1_000 }),
      );
      expect(oversized.error?.code).toBe("INPUT_LIMIT_EXCEEDED");
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
      await upstream.close();
    }
  });

  it("reserves output and safety capacity while packing context against a token budget", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model);
    const { root, path } = await fixture();
    await writeFile(path, "x".repeat(20_000), "utf8");
    const value = config(root, upstream, model);
    value.backends.controller.context_window_tokens = 4_096;
    try {
      const result = await (
        await service(value)
      ).delegate(input(root, { max_input_chars: 120_000, max_output_tokens: 512 }));
      expect(result).toMatchObject({
        ok: true,
        context_window_tokens: 4_096,
        prompt_tokens_actual: 321,
        completion_tokens_actual: 12,
      });
      expect(result.truncated).toBe(true);
      expect(result.prompt_tokens_estimate + 512).toBeLessThanOrEqual(4_096 - 1_024);
      expect(result.context_utilization_percent).toBeLessThanOrEqual(100);
      expect(JSON.stringify(upstream.completionBodies[0])).not.toContain("x".repeat(20_000));
    } finally {
      await upstream.close();
    }
  });

  it("rejects an output budget that cannot leave a safe prompt reservation", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model);
    const { root } = await fixture();
    const value = config(root, upstream, model);
    value.backends.controller.context_window_tokens = 4_096;
    try {
      const result = await (
        await service(value)
      ).delegate(input(root, { max_output_tokens: 3_100 }));
      expect(result).toMatchObject({
        ok: false,
        context_window_tokens: 4_096,
        error: {
          code: "INPUT_LIMIT_EXCEEDED",
          details: { context_window_tokens: 4_096, max_output_tokens: 3_100 },
        },
      });
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
      await upstream.close();
    }
  });

  it("normalizes containment failures and accepts issue-13 bounded waits", async () => {
    const model = "fixture-fast-model";
    const upstream = await startInference(model);
    const { root } = await fixture();
    const outside = await fixture();
    try {
      const delegate = await service(config(root, upstream, model));
      const escaped = await delegate.delegate(input(root, { paths: [outside.path] }));
      expect(escaped.error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
      expect(JSON.stringify(escaped)).not.toContain(outside.root);
      expect(upstream.requests).toHaveLength(0);
      const waiting = await delegate.delegate(
        input(root, { busy_behavior: "wait", max_wait_seconds: 1 }),
      );
      expect(waiting.ok).toBe(true);
      expect(DelegateResultSchema.parse(waiting).queue_seconds).toBe(0);
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
      await upstream.close();
    }
  });

  it("routes requested deep quality to the first ready configured deep model", async () => {
    const controller = await startInference("controller-fast");
    const cluster = await startInference("cluster-deep");
    const { root } = await fixture();
    const value: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    value.workspace_root = root;
    value.coordination.state_directory = join(root, ".delegate-state");
    value.backends.controller.url = controller.url;
    value.backends.controller.model_quality.fast = ["controller-fast"];
    value.backends.worker.enabled = false;
    value.backends.cluster.url = cluster.url;
    value.backends.cluster.model_quality.deep = ["cluster-deep"];
    try {
      const result = await (await service(value)).delegate(input(root, { quality: "deep" }));
      expect(result).toMatchObject({
        ok: true,
        backend: "cluster",
        actual_quality: "deep",
        model: { id: "cluster-deep" },
      });
      expect(controller.requests.some((request) => request.method === "POST")).toBe(false);
      expect(cluster.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    } finally {
      await Promise.all([controller.close(), cluster.close()]);
    }
  });

  it("routes a second automatic request to a free worker instead of a busy controller", async () => {
    const controller = await startInference("shared-fast", "slow");
    const worker = await startInference("shared-fast");
    const { root } = await fixture();
    const value: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    value.workspace_root = root;
    value.coordination.state_directory = join(root, ".delegate-state");
    value.backends.controller.url = controller.url;
    value.backends.controller.model_quality.fast = ["shared-fast"];
    value.backends.worker.enabled = true;
    value.backends.worker.url = worker.url;
    value.backends.worker.model_quality.fast = ["shared-fast"];
    value.backends.cluster.enabled = false;
    try {
      const firstService = await service(value);
      const secondService = await service(value);
      const first = firstService.delegate(input(root, { backend: "controller" }));
      const deadline = Date.now() + 1_000;
      while (
        !controller.requests.some((request) => request.method === "POST") &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const second = await secondService.delegate(input(root));
      expect(second).toMatchObject({ ok: true, backend: "worker" });
      expect(worker.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect((await first).ok).toBe(true);
    } finally {
      await Promise.all([controller.close(), worker.close()]);
    }
  });
});
