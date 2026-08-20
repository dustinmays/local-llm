import { isIP } from "node:net";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  BackendNameSchema,
  type BackendName,
  type QualityClass,
  type StableError,
} from "./contracts.js";
import { stableError } from "./errors.js";
import { LogLevelValues } from "./logging.js";

export const BACKEND_ORDER = BackendNameSchema.options;
export const CONFIG_SCHEMA_VERSION = 1 as const;

const DEFAULT_STARTUP_HINTS: Record<BackendName, string> = {
  controller: "Start the controller with llm-serve or llm-serve-hq.",
  worker:
    "Start worker LM Studio, then create the localhost port-1235 SSH tunnel to worker port 1234.",
  cluster:
    "Start the cluster with mise run cluster:start-fast or mise run cluster:start-overnight.",
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return normalized.startsWith("127.");
  if (ipVersion === 6) return normalized === "::1" || normalized === "0:0:0:0:0:0:0:1";
  return normalized === "localhost" || normalized.endsWith(".localhost");
}

export function normalizeLoopbackUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) throw new Error("must not contain credentials");
  if (parsed.search) throw new Error("must not contain a query string");
  if (parsed.hash) throw new Error("must not contain a fragment");
  if (!isLoopbackHostname(parsed.hostname)) throw new Error("must resolve to a loopback host");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

const LoopbackUrlSchema = z
  .string()
  .min(1)
  .transform((value, context) => {
    try {
      return normalizeLoopbackUrl(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "invalid loopback URL",
      });
      return z.NEVER;
    }
  });

const ModelIdListSchema = z
  .array(z.string().min(1).max(1_024))
  .refine((values) => new Set(values).size === values.length, "model IDs must be unique");

export const ModelQualityConfigSchema = z
  .object({
    fast: ModelIdListSchema,
    deep: ModelIdListSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const deep = new Set(value.deep);
    if (value.fast.some((model) => deep.has(model))) {
      context.addIssue({ code: "custom", message: "fast and deep model IDs must not overlap" });
    }
  });

export const ModelDiscoverySchema = z.enum(["openai", "lmstudio"]);
export type ModelDiscovery = z.infer<typeof ModelDiscoverySchema>;

export const BackendDefinitionSchema = z
  .object({
    enabled: z.boolean(),
    url: LoopbackUrlSchema,
    model_discovery: ModelDiscoverySchema,
    context_window_tokens: z.number().int().min(1_024).max(1_000_000),
    // Per-model context budgets (model id -> tokens). Overrides context_window_tokens
    // for that model; falls back to context_window_tokens when a model isn't listed.
    // Needed when several models share one backend at different loaded context sizes.
    context_window_overrides: z
      .record(z.string().min(1).max(1_024), z.number().int().min(1_024).max(1_000_000))
      .optional(),
    resource_groups: z
      .array(z.string().min(1).max(128))
      .min(1)
      .refine((values) => new Set(values).size === values.length, {
        message: "resource groups must be unique",
      }),
    startup_hint: z.string().min(1).max(1024),
    model_quality: ModelQualityConfigSchema,
  })
  .strict();

export const CoordinationConfigSchema = z
  .object({
    state_directory: z.string().min(1),
    mutex_timeout_ms: z.number().int().min(100).max(60_000),
    mutex_stale_ms: z.number().int().min(1_000).max(300_000),
    heartbeat_interval_ms: z.number().int().min(100).max(60_000),
    lease_ttl_ms: z.number().int().min(1_000).max(300_000),
    cooldown_ms: z.number().int().min(1_000).max(3_600_000),
    queue_capacity: z.number().int().min(1).max(10_000),
    queue_poll_interval_ms: z.number().int().min(10).max(5_000),
    rate_limit_requests: z.number().int().min(1).max(100_000),
    rate_limit_window_ms: z.number().int().min(1_000).max(86_400_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.heartbeat_interval_ms * 2 >= value.lease_ttl_ms) {
      context.addIssue({
        code: "custom",
        path: ["heartbeat_interval_ms"],
        message: "must be less than half of lease_ttl_ms",
      });
    }
    if (value.mutex_stale_ms <= value.mutex_timeout_ms) {
      context.addIssue({
        code: "custom",
        path: ["mutex_stale_ms"],
        message: "must be greater than mutex_timeout_ms",
      });
    }
  });

export const DelegateConfigSchema = z
  .object({
    schema_version: z.literal(CONFIG_SCHEMA_VERSION),
    workspace_root: z.string().min(1).nullable(),
    log_level: z.enum(LogLevelValues),
    connect_timeout_ms: z.number().int().min(50).max(60_000),
    health_timeout_ms: z.number().int().min(50).max(300_000),
    generation_timeout_ms: z.number().int().min(1_000).max(3_600_000),
    coordination: CoordinationConfigSchema,
    backends: z
      .object({
        controller: BackendDefinitionSchema,
        worker: BackendDefinitionSchema,
        cluster: BackendDefinitionSchema,
      })
      .strict(),
  })
  .strict();
export type DelegateConfig = z.infer<typeof DelegateConfigSchema>;
export type BackendDefinition = z.infer<typeof BackendDefinitionSchema>;
export type CoordinationConfig = z.infer<typeof CoordinationConfigSchema>;

export function classifyModel(definition: BackendDefinition, modelId: string): QualityClass {
  if (definition.model_quality.fast.includes(modelId)) return "fast";
  if (definition.model_quality.deep.includes(modelId)) return "deep";
  return "unknown";
}

// Context budget the delegate assumes for a given loaded model. Must not exceed
// the context the model is actually loaded with in the serving engine (e.g. LM
// Studio's -c), or prompts can silently overflow the real window.
export function contextWindowForModel(definition: BackendDefinition, modelId: string): number {
  return definition.context_window_overrides?.[modelId] ?? definition.context_window_tokens;
}

const BackendFileOverlaySchema = BackendDefinitionSchema.omit({ model_quality: true })
  .partial()
  .extend({
    model_quality: z
      .object({ fast: ModelIdListSchema.optional(), deep: ModelIdListSchema.optional() })
      .strict()
      .optional(),
  })
  .strict();
const ConfigFileSchema = z
  .object({
    schema_version: z.literal(CONFIG_SCHEMA_VERSION),
    workspace_root: z.string().min(1).nullable().optional(),
    log_level: z.enum(LogLevelValues).optional(),
    connect_timeout_ms: z.number().int().min(50).max(60_000).optional(),
    health_timeout_ms: z.number().int().min(50).max(300_000).optional(),
    generation_timeout_ms: z.number().int().min(1_000).max(3_600_000).optional(),
    coordination: z
      .object({
        mutex_timeout_ms: z.number().int().min(100).max(60_000).optional(),
        mutex_stale_ms: z.number().int().min(1_000).max(300_000).optional(),
        heartbeat_interval_ms: z.number().int().min(100).max(60_000).optional(),
        lease_ttl_ms: z.number().int().min(1_000).max(300_000).optional(),
        cooldown_ms: z.number().int().min(1_000).max(3_600_000).optional(),
        queue_capacity: z.number().int().min(1).max(10_000).optional(),
        queue_poll_interval_ms: z.number().int().min(10).max(5_000).optional(),
        rate_limit_requests: z.number().int().min(1).max(100_000).optional(),
        rate_limit_window_ms: z.number().int().min(1_000).max(86_400_000).optional(),
      })
      .strict()
      .optional(),
    backends: z
      .object({
        controller: BackendFileOverlaySchema.optional(),
        worker: BackendFileOverlaySchema.optional(),
        cluster: BackendFileOverlaySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type ConfigFile = z.infer<typeof ConfigFileSchema>;

function defaultStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "local-mlx-delegate");
  }
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? homedir(), "local-mlx-delegate");
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "local-mlx-delegate");
}

export const DEFAULT_CONFIG: DelegateConfig = DelegateConfigSchema.parse({
  schema_version: CONFIG_SCHEMA_VERSION,
  workspace_root: null,
  log_level: "info",
  connect_timeout_ms: 1_000,
  health_timeout_ms: 2_000,
  generation_timeout_ms: 120_000,
  coordination: {
    state_directory: defaultStateDirectory(),
    mutex_timeout_ms: 5_000,
    mutex_stale_ms: 10_000,
    heartbeat_interval_ms: 2_000,
    lease_ttl_ms: 10_000,
    cooldown_ms: 30_000,
    queue_capacity: 8,
    queue_poll_interval_ms: 50,
    rate_limit_requests: 60,
    rate_limit_window_ms: 60_000,
  },
  backends: {
    controller: {
      enabled: true,
      url: "http://127.0.0.1:1234/v1",
      model_discovery: "lmstudio",
      context_window_tokens: 32_768,
      resource_groups: ["controller"],
      startup_hint: DEFAULT_STARTUP_HINTS.controller,
      // Keep each value at or below the context the model is actually loaded
      // with in LM Studio (its -c), or prompts silently overflow the real window.
      // Muse loaded at >=90K, Gemma at >=32K.
      context_window_overrides: {
        "meta/muse-glimmer": 90_000,
        "google/gemma-4-e4b": 32_768,
      },
      model_quality: {
        fast: [
          "qwen3-coder-30b-a3b-instruct@4bit",
          "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
          "qwen3.6-35b",
          "google/gemma-4-e4b",
        ],
        deep: [
          "qwen3-coder-30b-a3b-instruct@8bit",
          "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
          "meta/muse-glimmer",
        ],
      },
    },
    worker: {
      enabled: true,
      url: "http://127.0.0.1:1235/v1",
      model_discovery: "lmstudio",
      context_window_tokens: 32_768,
      resource_groups: ["worker"],
      startup_hint: DEFAULT_STARTUP_HINTS.worker,
      model_quality: {
        fast: [
          "qwen3-coder-30b-a3b-instruct@4bit",
          "mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit",
          "qwen3.6-35b",
        ],
        deep: [
          "qwen3-coder-30b-a3b-instruct@8bit",
          "mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit",
        ],
      },
    },
    cluster: {
      enabled: true,
      url: "http://127.0.0.1:8080/v1",
      model_discovery: "openai",
      context_window_tokens: 32_768,
      resource_groups: ["controller", "worker"],
      startup_hint: DEFAULT_STARTUP_HINTS.cluster,
      model_quality: {
        fast: ["mlx-community/Qwen3.5-35B-A3B-4bit"],
        deep: ["mlx-community/Qwen3.5-122B-A10B-4bit"],
      },
    },
  },
});

export class ConfigurationError extends Error {
  readonly stable: StableError;

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
    this.stable = stableError("INVALID_REQUEST", message, { retryable: false });
  }
}

export type LoadConfigOptions = {
  configPath?: string;
  workspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
};

function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  const issueLocation = issue?.path.join(".") ?? "";
  const location = issueLocation.length > 0 ? issueLocation : "configuration";
  return `Invalid ${location}: ${issue?.message ?? "validation failed"}.`;
}

function parseBoolean(name: string, value: string): boolean {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigurationError(`${name} must be true, false, 1, or 0.`);
}

function parseInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new ConfigurationError(`${name} must be an integer.`);
  return Number(value);
}

function mergeFile(
  config: DelegateConfig,
  file: ConfigFile,
  baseDirectory: string,
): DelegateConfig {
  const mergeBackend = (
    base: BackendDefinition,
    overlay: z.infer<typeof BackendFileOverlaySchema> | undefined,
  ): BackendDefinition => {
    if (overlay === undefined) return { ...base };
    return {
      enabled: overlay.enabled ?? base.enabled,
      url: overlay.url ?? base.url,
      model_discovery: overlay.model_discovery ?? base.model_discovery,
      context_window_tokens: overlay.context_window_tokens ?? base.context_window_tokens,
      context_window_overrides:
        overlay.context_window_overrides ?? base.context_window_overrides,
      resource_groups: overlay.resource_groups ?? base.resource_groups,
      startup_hint: overlay.startup_hint ?? base.startup_hint,
      model_quality: {
        fast: overlay.model_quality?.fast ?? base.model_quality.fast,
        deep: overlay.model_quality?.deep ?? base.model_quality.deep,
      },
    };
  };
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    workspace_root:
      file.workspace_root === undefined
        ? config.workspace_root
        : file.workspace_root === null
          ? null
          : resolve(baseDirectory, file.workspace_root),
    log_level: file.log_level ?? config.log_level,
    connect_timeout_ms: file.connect_timeout_ms ?? config.connect_timeout_ms,
    health_timeout_ms: file.health_timeout_ms ?? config.health_timeout_ms,
    generation_timeout_ms: file.generation_timeout_ms ?? config.generation_timeout_ms,
    coordination: {
      mutex_timeout_ms: file.coordination?.mutex_timeout_ms ?? config.coordination.mutex_timeout_ms,
      mutex_stale_ms: file.coordination?.mutex_stale_ms ?? config.coordination.mutex_stale_ms,
      heartbeat_interval_ms:
        file.coordination?.heartbeat_interval_ms ?? config.coordination.heartbeat_interval_ms,
      lease_ttl_ms: file.coordination?.lease_ttl_ms ?? config.coordination.lease_ttl_ms,
      cooldown_ms: file.coordination?.cooldown_ms ?? config.coordination.cooldown_ms,
      queue_capacity: file.coordination?.queue_capacity ?? config.coordination.queue_capacity,
      queue_poll_interval_ms:
        file.coordination?.queue_poll_interval_ms ?? config.coordination.queue_poll_interval_ms,
      rate_limit_requests:
        file.coordination?.rate_limit_requests ?? config.coordination.rate_limit_requests,
      rate_limit_window_ms:
        file.coordination?.rate_limit_window_ms ?? config.coordination.rate_limit_window_ms,
      state_directory: config.coordination.state_directory,
    },
    backends: {
      controller: mergeBackend(config.backends.controller, file.backends?.controller),
      worker: mergeBackend(config.backends.worker, file.backends?.worker),
      cluster: mergeBackend(config.backends.cluster, file.backends?.cluster),
    },
  };
}

function applyEnvironment(
  config: DelegateConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
): DelegateConfig {
  const result = structuredClone(config);
  const workspace = env.LOCAL_MLX_DELEGATE_WORKSPACE_ROOT;
  if (workspace !== undefined) result.workspace_root = resolve(cwd, workspace);
  if (env.LOCAL_MLX_DELEGATE_LOG_LEVEL !== undefined) {
    result.log_level = env.LOCAL_MLX_DELEGATE_LOG_LEVEL as DelegateConfig["log_level"];
  }
  if (env.LOCAL_MLX_DELEGATE_CONNECT_TIMEOUT_MS !== undefined) {
    result.connect_timeout_ms = parseInteger(
      "LOCAL_MLX_DELEGATE_CONNECT_TIMEOUT_MS",
      env.LOCAL_MLX_DELEGATE_CONNECT_TIMEOUT_MS,
    );
  }
  if (env.LOCAL_MLX_DELEGATE_HEALTH_TIMEOUT_MS !== undefined) {
    result.health_timeout_ms = parseInteger(
      "LOCAL_MLX_DELEGATE_HEALTH_TIMEOUT_MS",
      env.LOCAL_MLX_DELEGATE_HEALTH_TIMEOUT_MS,
    );
  }
  if (env.LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS !== undefined) {
    result.generation_timeout_ms = parseInteger(
      "LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS",
      env.LOCAL_MLX_DELEGATE_GENERATION_TIMEOUT_MS,
    );
  }
  const coordinationEnvironment: [keyof Omit<CoordinationConfig, "state_directory">, string][] = [
    ["mutex_timeout_ms", "LOCAL_MLX_DELEGATE_MUTEX_TIMEOUT_MS"],
    ["mutex_stale_ms", "LOCAL_MLX_DELEGATE_MUTEX_STALE_MS"],
    ["heartbeat_interval_ms", "LOCAL_MLX_DELEGATE_HEARTBEAT_INTERVAL_MS"],
    ["lease_ttl_ms", "LOCAL_MLX_DELEGATE_LEASE_TTL_MS"],
    ["cooldown_ms", "LOCAL_MLX_DELEGATE_COOLDOWN_MS"],
    ["queue_capacity", "LOCAL_MLX_DELEGATE_QUEUE_CAPACITY"],
    ["queue_poll_interval_ms", "LOCAL_MLX_DELEGATE_QUEUE_POLL_INTERVAL_MS"],
    ["rate_limit_requests", "LOCAL_MLX_DELEGATE_RATE_LIMIT_REQUESTS"],
    ["rate_limit_window_ms", "LOCAL_MLX_DELEGATE_RATE_LIMIT_WINDOW_MS"],
  ];
  const stateDirectory = env.LOCAL_MLX_DELEGATE_STATE_DIRECTORY;
  if (stateDirectory !== undefined)
    result.coordination.state_directory = resolve(cwd, stateDirectory);
  for (const [field, name] of coordinationEnvironment) {
    const value = env[name];
    if (value !== undefined) result.coordination[field] = parseInteger(name, value);
  }

  for (const backend of BACKEND_ORDER) {
    const prefix = `LOCAL_MLX_DELEGATE_${backend.toUpperCase()}`;
    const url = env[`${prefix}_URL`];
    const enabled = env[`${prefix}_ENABLED`];
    const modelDiscovery = env[`${prefix}_MODEL_DISCOVERY`];
    if (url !== undefined) result.backends[backend].url = url;
    if (enabled !== undefined) {
      result.backends[backend].enabled = parseBoolean(`${prefix}_ENABLED`, enabled);
    }
    if (modelDiscovery !== undefined) {
      result.backends[backend].model_discovery = modelDiscovery as ModelDiscovery;
    }
  }
  return result;
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<DelegateConfig> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const selectedConfigPath = options.configPath ?? env.LOCAL_MLX_DELEGATE_CONFIG;
  let config = structuredClone(DEFAULT_CONFIG);

  if (selectedConfigPath !== undefined) {
    const absoluteConfigPath = resolve(cwd, selectedConfigPath);
    let source: string;
    try {
      source = await readFile(absoluteConfigPath, { encoding: "utf8" });
    } catch {
      throw new ConfigurationError("The selected configuration file could not be read.");
    }
    if (Buffer.byteLength(source) > 1_048_576) {
      throw new ConfigurationError("The selected configuration file is too large.");
    }
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new ConfigurationError("The selected configuration file is not valid JSON.");
    }
    const parsed = ConfigFileSchema.safeParse(value);
    if (!parsed.success) throw new ConfigurationError(zodMessage(parsed.error));
    config = mergeFile(config, parsed.data, dirname(absoluteConfigPath));
  }

  config = applyEnvironment(config, env, cwd);
  if (!isAbsolute(config.coordination.state_directory)) {
    config.coordination.state_directory = resolve(cwd, config.coordination.state_directory);
  }
  if (options.workspaceRoot !== undefined)
    config.workspace_root = resolve(cwd, options.workspaceRoot);

  const parsed = DelegateConfigSchema.safeParse(config);
  if (!parsed.success) throw new ConfigurationError(zodMessage(parsed.error));
  return parsed.data;
}
