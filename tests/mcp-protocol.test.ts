import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendProbe, CompletionAdapter, ProbeRequest } from "../src/backends/types.js";
import { DEFAULT_CONFIG, type DelegateConfig } from "../src/config.js";
import { AvailabilityCoordinator } from "../src/coordinator.js";
import {
  DoctorResultSchema,
  DelegateResultSchema,
  LeaseCommandResultSchema,
  StatusResultSchema,
  type ConfiguredBackendStatus,
} from "../src/contracts.js";
import { DelegationService } from "../src/delegation.js";
import { Logger } from "../src/logging.js";
import { HostConfigurationResultSchema } from "../src/host-config.js";
import { createMcpServer, DELEGATE_TOOL_NAME, STATUS_TOOL_NAME } from "../src/mcp/server.js";
import { StatusService } from "../src/service.js";
import { startFakeUpstream } from "./helpers/fake-upstream.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function ready(request: ProbeRequest): ConfiguredBackendStatus {
  return {
    backend: request.backend,
    enabled: true,
    health: true,
    availability: "ready",
    models: [{ id: `${request.backend}-model`, object: null, created: null, owned_by: null }],
    endpoint: request.definition.url,
    latency_ms: 1,
    resource_groups: [...request.definition.resource_groups],
    resource_states: [],
    queue_depth: 0,
    lease_age_seconds: null,
    cooldown_remaining_seconds: null,
    warnings: [],
    startup_hint: request.definition.startup_hint,
    error: null,
  };
}

function safeEnvironment(overrides: Record<string, string>): Record<string, string> {
  const generatedStateDirectory = join(tmpdir(), `local-mlx-protocol-state-${randomUUID()}`);
  const stateDirectory = overrides.LOCAL_MLX_DELEGATE_STATE_DIRECTORY ?? generatedStateDirectory;
  if (overrides.LOCAL_MLX_DELEGATE_STATE_DIRECTORY === undefined) {
    temporaryDirectories.push(generatedStateDirectory);
  }
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LOCAL_MLX_DELEGATE_STATE_DIRECTORY: stateDirectory,
    ...overrides,
  };
}

describe("MCP SDK integration", () => {
  it("lists and invokes the strict status-only factory seam in memory", async () => {
    let calls = 0;
    const probe: BackendProbe = {
      probe(request) {
        calls += 1;
        return Promise.resolve(ready(request));
      },
    };
    const service = new StatusService(DEFAULT_CONFIG, probe, new Logger("error", () => undefined));
    const server = createMcpServer(service);
    const client = new Client({ name: "issue-11-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools).toHaveLength(1);
      const tool = listing.tools[0];
      expect(tool).toMatchObject({
        name: STATUS_TOOL_NAME,
        title: "Local LLM Status",
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
      expect(tool?.description).toContain("without changing model lifecycle state");
      expect(tool?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool?.outputSchema).toMatchObject({ type: "object", additionalProperties: false });

      const response = await client.callTool({ name: STATUS_TOOL_NAME, arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(StatusResultSchema.parse(response.structuredContent).selected_backend).toBe(
        "controller",
      );
      expect(response.content[0]).toMatchObject({ type: "text" });
      expect(calls).toBe(3);

      const invalid = await client.callTool({
        name: STATUS_TOOL_NAME,
        arguments: { backend: "invalid", surprise: true },
      });
      expect(invalid.isError).toBe(true);
      expect(calls).toBe(3);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists and invokes the non-idempotent read-only delegation tool in memory", async () => {
    let completions = 0;
    const probe: BackendProbe = {
      probe(request) {
        return Promise.resolve(ready(request));
      },
    };
    const completion: CompletionAdapter = {
      complete(request) {
        completions += 1;
        expect(request.model).toBe("controller-model");
        expect(request.maxOutputTokens).toBe(123);
        return Promise.resolve("In-memory advice");
      },
    };
    const config: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    config.workspace_root = process.cwd();
    config.coordination.state_directory = join(tmpdir(), `local-mlx-in-memory-${randomUUID()}`);
    temporaryDirectories.push(config.coordination.state_directory);
    const status = new StatusService(config, probe, new Logger("error", () => undefined));
    const delegation = await DelegationService.create({
      config,
      statusService: status,
      completion,
    });
    const server = createMcpServer(status, delegation);
    const client = new Client({ name: "issue-12-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listing = await client.listTools();
      expect(listing.tools.map((tool) => tool.name)).toEqual([
        STATUS_TOOL_NAME,
        DELEGATE_TOOL_NAME,
      ]);
      expect(listing.tools.find((tool) => tool.name === DELEGATE_TOOL_NAME)).toMatchObject({
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: { type: "object", additionalProperties: false },
      });
      const response = await client.callTool({
        name: DELEGATE_TOOL_NAME,
        arguments: {
          task: "Give a second opinion",
          cwd: process.cwd(),
          max_output_tokens: 123,
        },
      });
      expect(response.isError).not.toBe(true);
      expect(DelegateResultSchema.parse(response.structuredContent)).toMatchObject({
        ok: true,
        answer: "In-memory advice",
        backend: "controller",
      });
      expect(completions).toBe(1);

      const invalid = await client.callTool({
        name: DELEGATE_TOOL_NAME,
        arguments: { task: "Missing cwd", unexpected: true },
      });
      expect(invalid.isError).toBe(true);
      expect(completions).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("retains schema-valid structured content for expected tool errors", async () => {
    const config: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    config.backends.worker.enabled = false;
    config.backends.cluster.enabled = false;
    const probe: BackendProbe = {
      probe(request) {
        return Promise.resolve({
          ...ready(request),
          health: false,
          availability: "offline",
          models: [],
          error: {
            code: "BACKEND_UNAVAILABLE",
            message: "The backend is unavailable.",
            retryable: true,
            backend: request.backend,
            startup_hint: request.definition.startup_hint,
            details: {},
          },
        });
      },
    };
    const server = createMcpServer(
      new StatusService(config, probe, new Logger("error", () => undefined)),
    );
    const client = new Client({ name: "issue-11-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const response = await client.callTool({ name: STATUS_TOOL_NAME, arguments: {} });
      expect(response.isError).toBe(true);
      const structured = StatusResultSchema.parse(response.structuredContent);
      expect(structured.error?.code).toBe("BACKEND_UNAVAILABLE");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("spawns the compiled stdio server without stdout contamination", async () => {
    const upstream = await startFakeUpstream();
    const stderr: string[] = [];
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(process.cwd(), "dist/cli.js"), "serve", "--workspace-root", process.cwd()],
      cwd: process.cwd(),
      env: safeEnvironment({
        LOCAL_MLX_DELEGATE_CONTROLLER_URL: upstream.url,
        LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
        LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
        LOCAL_MLX_DELEGATE_LOG_LEVEL: "debug",
        LOCAL_MLX_DELEGATE_TEST_SECRET: "must-not-appear",
      }),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    const client = new Client({ name: "spawned-issue-11-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        STATUS_TOOL_NAME,
        DELEGATE_TOOL_NAME,
      ]);
      const response = await client.callTool({ name: STATUS_TOOL_NAME, arguments: {} });
      const status = StatusResultSchema.parse(response.structuredContent);
      expect(status.ok).toBe(true);
      expect(status.model?.id).toBe("fake-model");
      expect(upstream.requests).toEqual([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/v1/models" },
      ]);
      const delegated = await client.callTool({
        name: DELEGATE_TOOL_NAME,
        arguments: { task: "Give a bounded opinion", cwd: process.cwd() },
      });
      expect(DelegateResultSchema.parse(delegated.structuredContent)).toMatchObject({
        ok: true,
        answer: "Fake advice",
        backend: "controller",
      });
      expect(upstream.requests.slice(2)).toEqual([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/v1/models" },
        { method: "POST", path: "/v1/chat/completions" },
      ]);
    } finally {
      await client.close();
      await upstream.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logs = stderr.join("");
    expect(logs).toContain('"event":"request_complete"');
    expect(logs).toMatch(/"request_id":"[0-9a-f-]{36}"/);
    expect(logs).not.toContain("must-not-appear");
    expect(logs).not.toContain(process.cwd());
    expect(logs).not.toContain("Give a bounded opinion");
    expect(logs).not.toContain("Fake advice");
  });

  it("arbitrates one physical resource across two compiled stdio servers", async () => {
    let activeCompletions = 0;
    let maximumActiveCompletions = 0;
    const completionStarts: number[] = [];
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") {
        response.end("{}");
        return;
      }
      if (request.url === "/v1/models") {
        response.end('{"data":[{"id":"fake-model"}]}');
        return;
      }
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        request.resume();
        completionStarts.push(Date.now());
        activeCompletions += 1;
        maximumActiveCompletions = Math.max(maximumActiveCompletions, activeCompletions);
        setTimeout(() => {
          activeCompletions -= 1;
          response.end('{"choices":[{"message":{"content":"stdio advice"}}]}');
        }, 180);
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    const stateDirectory = join(tmpdir(), `local-mlx-stdio-race-${randomUUID()}`);
    temporaryDirectories.push(stateDirectory);
    const environment = safeEnvironment({
      LOCAL_MLX_DELEGATE_STATE_DIRECTORY: stateDirectory,
      LOCAL_MLX_DELEGATE_CONTROLLER_URL: upstream.url,
      LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS: "20",
    });
    const makeTransport = (): StdioClientTransport =>
      new StdioClientTransport({
        command: process.execPath,
        args: [join(process.cwd(), "dist/cli.js"), "serve", "--workspace-root", process.cwd()],
        cwd: process.cwd(),
        env: environment,
        stderr: "pipe",
      });
    const firstClient = new Client({ name: "capacity-one-a", version: "1.0.0" });
    const secondClient = new Client({ name: "capacity-one-b", version: "1.0.0" });
    const firstTransport = makeTransport();
    const secondTransport = makeTransport();
    firstTransport.stderr?.on("data", () => undefined);
    secondTransport.stderr?.on("data", () => undefined);
    try {
      await Promise.all([
        firstClient.connect(firstTransport),
        secondClient.connect(secondTransport),
      ]);
      const raced = await Promise.all([
        firstClient.callTool({
          name: DELEGATE_TOOL_NAME,
          arguments: { task: "Race through stdio", cwd: process.cwd() },
        }),
        secondClient.callTool({
          name: DELEGATE_TOOL_NAME,
          arguments: { task: "Race through stdio", cwd: process.cwd() },
        }),
      ]);
      const results = raced.map((response) =>
        DelegateResultSchema.parse(response.structuredContent),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.error?.code).toBe("BACKEND_BUSY");
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(maximumActiveCompletions).toBe(1);

      completionStarts.length = 0;
      const first = firstClient.callTool({
        name: DELEGATE_TOOL_NAME,
        arguments: { task: "Hold through stdio", cwd: process.cwd() },
      });
      const deadline = Date.now() + 1_000;
      while (completionStarts.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const second = secondClient.callTool({
        name: DELEGATE_TOOL_NAME,
        arguments: {
          task: "Wait through stdio",
          cwd: process.cwd(),
          busy_behavior: "wait",
          max_wait_seconds: 2,
        },
      });
      const waited = await Promise.all([first, second]);
      const waitedResults = waited.map((response) =>
        DelegateResultSchema.parse(response.structuredContent),
      );
      expect(waitedResults.every((result) => result.ok)).toBe(true);
      expect(waitedResults.at(1)?.queue_seconds).toBeGreaterThan(0);
      expect(maximumActiveCompletions).toBe(1);
    } finally {
      await Promise.allSettled([firstClient.close(), secondClient.close()]);
      await upstream.close();
    }
  });
});

describe("compiled CLI and doctor", () => {
  async function invoke(
    arguments_: string[],
    environment: Record<string, string>,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const result = await execFileAsync(
        process.execPath,
        [join(process.cwd(), "dist/cli.js"), ...arguments_],
        {
          cwd: process.cwd(),
          env: safeEnvironment(environment),
        },
      );
      return { ...result, exitCode: 0 };
    } catch (error) {
      const failure = error as { stdout: string; stderr: string; code: number };
      return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.code };
    }
  }

  it("emits human and single-document JSON status output with correct exit codes", async () => {
    const upstream = await startFakeUpstream();
    const environment = {
      LOCAL_MLX_DELEGATE_CONTROLLER_URL: upstream.url,
      LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
    };
    try {
      const json = await invoke(["status", "--json"], environment);
      expect(json.exitCode).toBe(0);
      expect(json.stdout.trim().split("\n")).toHaveLength(1);
      expect(StatusResultSchema.parse(JSON.parse(json.stdout) as unknown).ok).toBe(true);
      expect(json.stderr).toContain('"request_id"');

      const human = await invoke(["status"], environment);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain("controller: ready");
      expect(human.stdout).toContain("Selected: controller");

      const delegated = await invoke(
        [
          "delegate",
          "--task",
          "Give a bounded opinion",
          "--cwd",
          process.cwd(),
          "--max-output-tokens",
          "321",
          "--json",
        ],
        environment,
      );
      expect(delegated.exitCode).toBe(0);
      expect(delegated.stdout.trim().split("\n")).toHaveLength(1);
      expect(DelegateResultSchema.parse(JSON.parse(delegated.stdout) as unknown)).toMatchObject({
        ok: true,
        answer: "Fake advice",
        backend: "controller",
      });
      expect(upstream.requestBodies.at(-1)).toMatchObject({ max_tokens: 321, model: "fake-model" });
    } finally {
      await upstream.close();
    }
  });

  it("previews and idempotently applies host configuration through the compiled CLI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "local-mlx-configure-cli-"));
    temporaryDirectories.push(workspace);
    await mkdir(join(workspace, "dist"));
    await writeFile(join(workspace, "dist", "cli.js"), "#!/usr/bin/env node\n", {
      mode: 0o755,
    });
    await chmod(join(workspace, "dist", "cli.js"), 0o755);

    const preview = await invoke(
      ["configure", "codex", "--workspace-root", workspace, "--json"],
      {},
    );
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout.trim().split("\n")).toHaveLength(1);
    expect(
      HostConfigurationResultSchema.parse(JSON.parse(preview.stdout) as unknown),
    ).toMatchObject({ applied: false, changed: true, backup_path: null });
    await expect(access(join(workspace, ".codex", "config.toml"))).rejects.toThrow();

    const applied = await invoke(
      ["configure", "codex", "--workspace-root", workspace, "--apply", "--json"],
      {},
    );
    expect(applied.exitCode).toBe(0);
    expect(
      HostConfigurationResultSchema.parse(JSON.parse(applied.stdout) as unknown),
    ).toMatchObject({
      applied: true,
      changed: true,
      backup_path: null,
    });
    const second = await invoke(
      ["configure", "codex", "--workspace-root", workspace, "--apply", "--json"],
      {},
    );
    expect(HostConfigurationResultSchema.parse(JSON.parse(second.stdout) as unknown)).toMatchObject(
      {
        applied: true,
        changed: false,
        backup_path: null,
      },
    );
  });

  it("arbitrates capacity and FIFO waits across independent CLI processes", async () => {
    let activeCompletions = 0;
    let maximumActiveCompletions = 0;
    const completionStarts: number[] = [];
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") {
        response.end("{}");
        return;
      }
      if (request.url === "/v1/models") {
        response.end('{"data":[{"id":"fake-model"}]}');
        return;
      }
      if (request.url === "/v1/chat/completions" && request.method === "POST") {
        request.resume();
        completionStarts.push(Date.now());
        activeCompletions += 1;
        maximumActiveCompletions = Math.max(maximumActiveCompletions, activeCompletions);
        setTimeout(() => {
          activeCompletions -= 1;
          response.end('{"choices":[{"message":{"content":"slow advice"}}]}');
        }, 180);
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    const stateDirectory = join(tmpdir(), `local-mlx-process-race-${randomUUID()}`);
    temporaryDirectories.push(stateDirectory);
    const environment = {
      LOCAL_MLX_DELEGATE_STATE_DIRECTORY: stateDirectory,
      LOCAL_MLX_DELEGATE_CONTROLLER_URL: upstream.url,
      LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS: "20",
    };
    const arguments_ = ["delegate", "--task", "Race safely", "--cwd", process.cwd(), "--json"];
    try {
      const raced = await Promise.all([
        invoke(arguments_, environment),
        invoke(arguments_, environment),
      ]);
      const raceResults = raced.map((result) =>
        DelegateResultSchema.parse(JSON.parse(result.stdout) as unknown),
      );
      expect(raceResults.filter((result) => result.ok)).toHaveLength(1);
      expect(raceResults.find((result) => !result.ok)?.error?.code).toBe("BACKEND_BUSY");
      expect(upstream.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(maximumActiveCompletions).toBe(1);

      completionStarts.length = 0;
      const first = invoke(arguments_, environment);
      const deadline = Date.now() + 1_000;
      while (completionStarts.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const second = invoke(
        [
          ...arguments_.slice(0, -1),
          "--busy-behavior",
          "wait",
          "--max-wait-seconds",
          "2",
          "--json",
        ],
        environment,
      );
      const waited = await Promise.all([first, second]);
      const waitResults = waited.map((result) =>
        DelegateResultSchema.parse(JSON.parse(result.stdout) as unknown),
      );
      expect(waitResults.every((result) => result.ok)).toBe(true);
      expect(waitResults.at(1)?.queue_seconds).toBeGreaterThan(0);
      expect(completionStarts).toHaveLength(2);
      const firstStart = completionStarts[0];
      const secondStart = completionStarts[1];
      if (firstStart === undefined || secondStart === undefined) {
        throw new Error("Missing completion start timestamps");
      }
      expect(secondStart - firstStart).toBeGreaterThanOrEqual(150);
      expect(maximumActiveCompletions).toBe(1);
    } finally {
      await upstream.close();
    }
  });

  it("shares rate limits across processes and confirmation-gates cooldown clearing", async () => {
    const upstream = await startFakeUpstream();
    const stateDirectory = join(tmpdir(), `local-mlx-process-rate-${randomUUID()}`);
    temporaryDirectories.push(stateDirectory);
    const environment = {
      LOCAL_MLX_DELEGATE_STATE_DIRECTORY: stateDirectory,
      LOCAL_MLX_DELEGATE_CONTROLLER_URL: upstream.url,
      LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
      LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS: "1",
      LOCAL_MLX_DELEGATE_RATE_LIMIT_WINDOW_MS: "60000",
    };
    const arguments_ = ["delegate", "--task", "Rate safely", "--cwd", process.cwd(), "--json"];
    try {
      expect((await invoke(arguments_, environment)).exitCode).toBe(0);
      const limited = await invoke(arguments_, environment);
      expect(limited.exitCode).toBe(1);
      expect(DelegateResultSchema.parse(JSON.parse(limited.stdout) as unknown).error?.code).toBe(
        "RATE_LIMITED",
      );

      const coordination = structuredClone(DEFAULT_CONFIG.coordination);
      coordination.state_directory = stateDirectory;
      coordination.rate_limit_requests = 20;
      const coordinator = new AvailabilityCoordinator(coordination);
      const lease = await coordinator.acquire({
        requestId: randomUUID(),
        backend: "controller",
        resourceGroups: ["controller"],
        model: "fake-model",
        busyBehavior: "fail",
        maximumWaitMs: 0,
      });
      await coordinator.release(lease.lease.lease_id, true);

      const inspected = await invoke(["leases", "--json"], {
        ...environment,
        LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS: "20",
      });
      expect(inspected.exitCode).toBe(0);
      expect(
        LeaseCommandResultSchema.parse(JSON.parse(inspected.stdout) as unknown).state.leases[0]
          ?.state,
      ).toBe("cooldown");
      expect(
        (
          await invoke(
            ["leases", "clear", "--lease-id", lease.lease.lease_id, "--json"],
            environment,
          )
        ).exitCode,
      ).toBe(2);
      const cleared = await invoke(
        ["leases", "clear", "--lease-id", lease.lease.lease_id, "--confirm", "--json"],
        { ...environment, LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS: "20" },
      );
      expect(cleared.exitCode).toBe(0);
      expect(LeaseCommandResultSchema.parse(JSON.parse(cleared.stdout) as unknown)).toMatchObject({
        ok: true,
        action: "clear",
        cleared_lease_id: lease.lease.lease_id,
        state: { leases: [] },
      });
    } finally {
      await upstream.close();
    }
  });

  it("returns 1 for unloaded/unreachable diagnostics and 2 for invalid config", async () => {
    const unloaded = await startFakeUpstream((request, response) => {
      response.end(request.url === "/health" ? "{}" : '{"data":[]}');
    });
    try {
      const result = await invoke(["status", "--backend", "controller", "--json"], {
        LOCAL_MLX_DELEGATE_CONTROLLER_URL: unloaded.url,
        LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
        LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
      });
      expect(result.exitCode).toBe(1);
      expect(StatusResultSchema.parse(JSON.parse(result.stdout) as unknown).error?.code).toBe(
        "MODEL_NOT_LOADED",
      );
    } finally {
      await unloaded.close();
    }

    const closed = await startFakeUpstream();
    const closedUrl = closed.url;
    await closed.close();
    expect(
      (
        await invoke(["status", "--backend", "controller", "--json"], {
          LOCAL_MLX_DELEGATE_CONTROLLER_URL: closedUrl,
          LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
          LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
        })
      ).exitCode,
    ).toBe(1);

    const directory = await mkdtemp(join(tmpdir(), "local-mlx-invalid-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "config.json");
    await writeFile(path, '{"schema_version":2}', "utf8");
    expect(await invoke(["status", "--config", path, "--json"], {})).toMatchObject({
      exitCode: 2,
      stdout: "",
    });
  });

  it("runs read-only doctor workspace and backend checks", async () => {
    const upstream = await startFakeUpstream();
    const workspace = await mkdtemp(join(tmpdir(), "local-mlx-workspace-"));
    temporaryDirectories.push(workspace);
    await writeFile(join(workspace, "sentinel.txt"), "unchanged", "utf8");
    const before = await readdir(workspace);
    try {
      const result = await invoke(
        ["doctor", "--workspace-root", workspace, "--backend", "controller", "--json"],
        {
          LOCAL_MLX_DELEGATE_CONTROLLER_URL: upstream.url,
          LOCAL_MLX_DELEGATE_WORKER_ENABLED: "false",
          LOCAL_MLX_DELEGATE_CLUSTER_ENABLED: "false",
        },
      );
      expect(result.exitCode).toBe(0);
      const doctor = DoctorResultSchema.parse(JSON.parse(result.stdout) as unknown);
      expect(doctor.ok).toBe(true);
      expect(doctor.request_id).toBe(doctor.status.request_id);
      expect(doctor.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "workspace", status: "pass" }),
          expect.objectContaining({ name: "backend_controller", status: "pass" }),
        ]),
      );
      expect(JSON.stringify(doctor)).not.toContain(workspace);
      expect(await readdir(workspace)).toEqual(before);
    } finally {
      await upstream.close();
    }
  });

  it("reports version and rejects usage errors without probing", async () => {
    expect(await invoke(["--version"], {})).toMatchObject({ exitCode: 0, stdout: "0.1.0\n" });
    expect((await invoke(["status", "--unknown"], {})).exitCode).toBe(2);
    expect((await invoke(["serve"], {})).exitCode).toBe(2);
    expect((await invoke(["delegate", "--task", "missing cwd"], {})).exitCode).toBe(2);
  });
});
