import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AvailabilitySchema,
  BackendNameSchema,
  BackendSelectionSchema,
  ContextManifestEntrySchema,
  DelegateInputSchema,
  DelegateResultSchema,
  DoctorResultSchema,
  LeaseInspectionSchema,
  LeaseRecordSchema,
  ModelMetadataSchema,
  QualityClassSchema,
  ResourceAvailabilitySchema,
  StableErrorCodeSchema,
  StableErrorSchema,
  StatusInputSchema,
  StatusResultSchema,
} from "../src/contracts.js";
import {
  BACKEND_ORDER,
  ConfigurationError,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeLoopbackUrl,
} from "../src/config.js";
import { stableError } from "../src/errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function configFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-mlx-config-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value), "utf8");
  return path;
}

describe("public contracts", () => {
  it("exports every stable enum value and strict status input", () => {
    expect(BackendNameSchema.options).toEqual(["controller", "worker", "cluster"]);
    expect(BackendSelectionSchema.options).toEqual(["auto", "controller", "worker", "cluster"]);
    expect(AvailabilitySchema.options).toEqual([
      "offline",
      "ready",
      "busy",
      "queued",
      "cooldown",
      "degraded",
    ]);
    expect(QualityClassSchema.options).toEqual(["fast", "deep", "unknown"]);
    expect(StableErrorCodeSchema.options).toHaveLength(14);
    expect(StatusInputSchema.parse({})).toEqual({ backend: "auto" });
    expect(StatusInputSchema.safeParse({ surprise: true }).success).toBe(false);
  });

  it("validates model, manifest, and safe error shapes", () => {
    expect(
      ModelMetadataSchema.parse({ id: "model", object: null, created: null, owned_by: null }),
    ).toBeTruthy();
    expect(
      ContextManifestEntrySchema.parse({
        relative_path: "src/a.ts",
        byte_count: 12,
        sha256: "a".repeat(64),
        truncated: false,
        omitted: false,
        reason: null,
      }),
    ).toBeTruthy();
    for (const code of StableErrorCodeSchema.options) {
      expect(StableErrorSchema.parse(stableError(code)).code).toBe(code);
    }
    expect(
      StableErrorSchema.safeParse({
        ...stableError("INTERNAL_ERROR"),
        details: { nested: { secret: true } },
      }).success,
    ).toBe(false);
    const lease = LeaseRecordSchema.parse({
      lease_id: "00000000-0000-4000-8000-000000000001",
      request_id: "00000000-0000-4000-8000-000000000002",
      owner_pid: 123,
      owner_instance_id: "00000000-0000-4000-8000-000000000003",
      backend: "cluster",
      resource_groups: ["controller", "worker"],
      model: "model",
      started_at: "2026-08-16T00:00:00.000Z",
      heartbeat_at: "2026-08-16T00:00:01.000Z",
      expires_at: "2026-08-16T00:00:10.000Z",
      state: "active",
    });
    expect(
      LeaseInspectionSchema.parse({
        schema_version: 1,
        healthy: true,
        leases: [lease],
        queue: [],
        rate_limit_count: 1,
        rate_limit_maximum: 60,
        rate_limit_window_seconds: 60,
        error: null,
      }).leases,
    ).toHaveLength(1);
    expect(
      ResourceAvailabilitySchema.parse({
        resource_group: "controller",
        availability: "busy",
        lease_id: lease.lease_id,
        backend: "cluster",
        model: "model",
        lease_age_seconds: 1,
        cooldown_remaining_seconds: null,
        queue_depth: 2,
      }),
    ).toBeTruthy();
  });

  it("keeps nullable status and doctor fields explicit", () => {
    const status = {
      ok: false,
      request_id: "00000000-0000-4000-8000-000000000000",
      configured_backends: [],
      healthy_backends: [],
      selected_backend: null,
      endpoint: null,
      model: null,
      quality_class: "unknown",
      availability: "offline",
      resource_groups: [],
      resource_states: [],
      queue_depth: 0,
      lease_age_seconds: null,
      cooldown_remaining_seconds: null,
      startup_hint: null,
      warnings: [],
      error: stableError("BACKEND_UNAVAILABLE"),
    };
    expect(StatusResultSchema.parse(status)).toEqual(status);
    expect(
      DoctorResultSchema.parse({ request_id: status.request_id, ok: false, checks: [], status }),
    ).toBeTruthy();
  });

  it("validates strict delegation defaults and stable error output", () => {
    const input = DelegateInputSchema.parse({ task: "Review", cwd: "/workspace" });
    expect(input).toMatchObject({
      paths: [],
      include_diff: false,
      quality: "auto",
      backend: "auto",
      busy_behavior: "fail",
      max_wait_seconds: 0,
      max_input_chars: 120_000,
      max_output_tokens: 4_096,
    });
    expect(
      DelegateInputSchema.safeParse({ task: "Review", cwd: "/workspace", extra: true }).success,
    ).toBe(false);
    expect(
      DelegateResultSchema.parse({
        ok: false,
        request_id: "00000000-0000-4000-8000-000000000000",
        backend: null,
        endpoint: null,
        model: null,
        requested_quality: "auto",
        actual_quality: "unknown",
        availability: "offline",
        answer: null,
        context_manifest: [],
        elapsed_seconds: 0,
        queue_seconds: 0,
        input_characters: 0,
        truncated: false,
        warnings: [],
        error: stableError("INVALID_WORKSPACE"),
      }),
    ).toBeTruthy();
  });
});

describe("configuration", () => {
  it("loads built-in defaults in deterministic order", async () => {
    const config = await loadConfig({ env: {}, cwd: "/tmp" });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(BACKEND_ORDER).toEqual(["controller", "worker", "cluster"]);
    expect(config.connect_timeout_ms).toBe(1_000);
    expect(config.health_timeout_ms).toBe(2_000);
    expect(config.backends.controller.model_discovery).toBe("lmstudio");
    expect(config.backends.worker.model_discovery).toBe("lmstudio");
    expect(config.backends.cluster.model_discovery).toBe("openai");
    expect(config.coordination).toMatchObject({
      heartbeat_interval_ms: 2_000,
      lease_ttl_ms: 10_000,
      cooldown_ms: 30_000,
      queue_capacity: 32,
      rate_limit_requests: 60,
      rate_limit_window_ms: 60_000,
    });
  });

  it("deep-merges partial files, then env, then invocation overrides", async () => {
    const path = await configFile({
      schema_version: 1,
      workspace_root: "file-workspace",
      health_timeout_ms: 5_000,
      coordination: { cooldown_ms: 45_000 },
      backends: {
        controller: {
          enabled: false,
          url: "http://localhost:4321/v1/",
          model_discovery: "openai",
          model_quality: { deep: ["custom-deep"] },
        },
      },
    });
    const config = await loadConfig({
      configPath: path,
      workspaceRoot: "flag-workspace",
      cwd: "/tmp",
      env: {
        LOCAL_MLX_DELEGATE_HEALTH_TIMEOUT_MS: "6000",
        LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS: "90000",
        LOCAL_MLX_DELEGATE_CONTROLLER_ENABLED: "true",
        LOCAL_MLX_DELEGATE_CONTROLLER_URL: "http://127.0.0.1:9876/v1",
        LOCAL_MLX_DELEGATE_CONTROLLER_MODEL_DISCOVERY: "lmstudio",
        LOCAL_MLX_DELEGATE_STATE_DIRECTORY: "state",
        LOCAL_MLX_DELEGATE_QUEUE_CAPACITY: "12",
        LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS: "15",
      },
    });
    expect(config.workspace_root).toBe("/tmp/flag-workspace");
    expect(config.health_timeout_ms).toBe(6_000);
    expect(config.generation_timeout_ms).toBe(90_000);
    expect(config.backends.controller.enabled).toBe(true);
    expect(config.backends.controller.url).toBe("http://127.0.0.1:9876/v1");
    expect(config.backends.controller.model_discovery).toBe("lmstudio");
    expect(config.backends.controller.resource_groups).toEqual(["controller"]);
    expect(config.backends.controller.model_quality.deep).toEqual(["custom-deep"]);
    expect(config.backends.controller.model_quality.fast).toEqual(
      DEFAULT_CONFIG.backends.controller.model_quality.fast,
    );
    expect(config.coordination.state_directory).toBe("/tmp/state");
    expect(config.coordination.cooldown_ms).toBe(45_000);
    expect(config.coordination.queue_capacity).toBe(12);
    expect(config.coordination.rate_limit_requests).toBe(15);
  });

  it("gives the CLI config path precedence over the environment path", async () => {
    const first = await configFile({ schema_version: 1, log_level: "debug" });
    const second = await configFile({ schema_version: 1, log_level: "error" });
    const config = await loadConfig({
      configPath: first,
      env: { LOCAL_MLX_DELEGATE_CONFIG: second },
    });
    expect(config.log_level).toBe("debug");
  });

  it.each([
    "http://user:password@127.0.0.1:1234/v1",
    "http://127.0.0.1:1234/v1?token=secret",
    "http://127.0.0.1:1234/v1#fragment",
    "ftp://127.0.0.1/v1",
    "http://192.168.1.2:1234/v1",
    "https://example.com/v1",
  ])("rejects unsafe URL %s", (url) => {
    expect(() => normalizeLoopbackUrl(url)).toThrow();
  });

  it.each([
    { schema_version: 2 },
    { schema_version: 1, extra: true },
    { schema_version: 1, connect_timeout_ms: 1 },
    { schema_version: 1, health_timeout_ms: 999_999 },
    { schema_version: 1, generation_timeout_ms: 10 },
    { schema_version: 1, coordination: { state_directory: "/tmp/unsafe" } },
    {
      schema_version: 1,
      coordination: { heartbeat_interval_ms: 5_000, lease_ttl_ms: 9_000 },
    },
    {
      schema_version: 1,
      coordination: { mutex_timeout_ms: 5_000, mutex_stale_ms: 5_000 },
    },
    {
      schema_version: 1,
      backends: { controller: { model_quality: { fast: ["same"], deep: ["same"] } } },
    },
    { schema_version: 1, backends: { controller: { enabled: "yes" } } },
    { schema_version: 1, backends: { controller: { model_discovery: "automatic" } } },
    {
      schema_version: 1,
      backends: { cluster: { resource_groups: ["controller", "controller"] } },
    },
  ])("rejects invalid file configuration %#", async (value) => {
    const path = await configFile(value);
    await expect(loadConfig({ configPath: path, env: {} })).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("rejects invalid environment booleans and timeout values", async () => {
    await expect(
      loadConfig({ env: { LOCAL_MLX_DELEGATE_WORKER_ENABLED: "yes" } }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      loadConfig({ env: { LOCAL_MLX_DELEGATE_CONNECT_TIMEOUT_MS: "1.5" } }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      loadConfig({ env: { LOCAL_MLX_DELEGATE_CONTROLLER_MODEL_DISCOVERY: "automatic" } }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
