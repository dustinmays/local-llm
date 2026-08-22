// Single source of truth for models, backends, ports, and context windows.
//
// This module is the ONE place to edit when adding/swapping a model, changing a
// port, or adjusting a context window. `src/config.ts` derives the delegate's
// DEFAULT_CONFIG from it (so the MCP delegate uses it directly), and
// `src/render-config.ts` renders every non-TS surface from it (OpenCode, the
// `llm` CLI models file, shell env, cluster model defaults, host launchers).
//
// Keep it dependency-free and Zod-free: the Zod schemas in config.ts remain the
// validation guard downstream. These are plain typed constants.

import type { BackendName, QualityClass } from "./contracts.js";

/** Canonical loopback host used for every local endpoint (avoids the
 * localhost-vs-127.0.0.1 inconsistency that had crept into the configs). */
export const HOST = { loopback: "127.0.0.1" } as const;

export type ModelDiscovery = "lmstudio" | "openai";

export type BackendSpec = {
  port: number;
  discovery: ModelDiscovery;
  /** Default context budget for models on this backend that don't override it. */
  contextTokens: number;
  resourceGroups: string[];
  startupHint: string;
};

export const BACKENDS: Record<BackendName, BackendSpec> = {
  controller: {
    // oMLX (native MLX server) is the daily-driver controller. It serves gemma
    // (fast) and Qwen 3.6 27B (deep, with DFlash) on :8000. LM Studio is retired
    // from the delegate; models are discovered via the standard OpenAI catalog.
    port: 8000,
    discovery: "openai",
    contextTokens: 32_768,
    resourceGroups: ["controller"],
    startupHint: "Start oMLX (omlx start) or the oMLX menu-bar app; models load on first request.",
  },
  worker: {
    port: 1235,
    discovery: "lmstudio",
    contextTokens: 32_768,
    resourceGroups: ["worker"],
    startupHint:
      "Start worker LM Studio, then create the localhost port-1235 SSH tunnel to worker port 1234.",
  },
  cluster: {
    port: 8080,
    discovery: "openai",
    contextTokens: 32_768,
    resourceGroups: ["controller", "worker"],
    startupHint:
      "Start the cluster with mise run cluster:start-fast or mise run cluster:start-overnight.",
  },
};

/** OpenAI-compatible base URL for a backend, e.g. http://127.0.0.1:1234/v1 */
export function baseUrl(backend: BackendName): string {
  return `http://${HOST.loopback}:${String(BACKENDS[backend].port)}/v1`;
}

export type ModelEntry = {
  /** Canonical served model id (the one clients request). */
  id: string;
  /** Extra ids that refer to the same weights and classify identically
   * (e.g. an LM Studio short id and its full mlx-community repo id). */
  aliases?: string[];
  /** Quality tier used by the delegate to route `fast`/`deep`. */
  quality: QualityClass;
  /** Backends whose classification lists include this model. Empty means the
   * model is not delegate-routable (it still contributes to non-delegate
   * outputs like the cluster env or the `llm` CLI). */
  servedBy: BackendName[];
  /** Per-model context budget override (tokens). Must stay <= the context the
   * model is actually loaded with in its serving engine. */
  contextTokens?: number;
  /** `llm` CLI alias (extra-openai-models.yaml `model_id`) served via the
   * controller endpoint. */
  llmAlias?: string;
  /** OpenCode provider + display label, when the model is selectable there. */
  opencode?: { provider: "omlx" | "mlxcluster"; name: string };
  /** Cluster launch profile slot (cluster/models.env). */
  clusterProfile?: "fast" | "overnight" | "test";
  /** Role markers for shell/OpenCode defaults. */
  role?: "daily-driver" | "daily-hq";
  /** Optional speculative-decoding / accel metadata (e.g. DFlash). Advisory —
   * consumed by serving-layer plumbing, not by the delegate. */
  inference?: { quant?: string; draft?: string; preferredServer?: "lmstudio" | "omlx" };
};

// Order matters: derived fast/deep lists preserve this order (see the tests that
// assert exact array contents for DEFAULT_CONFIG).
export const MODELS: ModelEntry[] = [
  // --- controller = oMLX (:8000) daily drivers ---
  {
    // Fast, snappy default for ask/chat. Served by oMLX (MLX 4-bit).
    id: "gemma-4-e4b-mlx",
    quality: "fast",
    servedBy: ["controller"],
    llmAlias: "gemma",
    role: "daily-driver",
    opencode: { provider: "omlx", name: "Gemma 4 E4B (fast)" },
  },
  {
    // Reasoning/coding daily driver. Served by oMLX with the DFlash drafter
    // (~3x decode) enabled per-model in oMLX admin. See docs/… / memory.
    id: "qwen3.6-27b-4bit",
    quality: "deep",
    servedBy: ["controller"],
    llmAlias: "qwen",
    role: "daily-hq",
    contextTokens: 131072,
    opencode: { provider: "omlx", name: "Qwen3.6 27B (DFlash)" },
    inference: { quant: "4bit", draft: "qwen3.6-27b-dflash-6bit", preferredServer: "omlx" },
  },
  // --- worker = second Mac's LM Studio (:1235, offline in single-Mac mode) ---
  {
    id: "qwen3-coder-30b-a3b-instruct@4bit",
    aliases: ["mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit"],
    quality: "fast",
    servedBy: ["worker"],
  },
  {
    id: "qwen3-coder-30b-a3b-instruct@8bit",
    aliases: ["mlx-community/Qwen3-Coder-30B-A3B-Instruct-8bit"],
    quality: "deep",
    servedBy: ["worker"],
  },
  {
    id: "qwen3.6-35b",
    quality: "fast",
    servedBy: ["worker"],
  },
  {
    id: "mlx-community/Qwen3.5-35B-A3B-4bit",
    quality: "fast",
    servedBy: ["cluster"],
    clusterProfile: "fast",
  },
  {
    id: "mlx-community/Qwen3.5-122B-A10B-4bit",
    quality: "deep",
    servedBy: ["cluster"],
    clusterProfile: "overnight",
  },
  {
    // Cluster smoke-test model only; not delegate-routable.
    id: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    quality: "fast",
    servedBy: [],
    clusterProfile: "test",
  },
];

/** Repositories removed by the guarded cluster cleanup task (cluster/models.env). */
export const CLUSTER_CLEANUP_MODELS = [
  "mlx-community/Llama-3.2-3B-Instruct-4bit",
  "mlx-community/Llama-3.3-70B-Instruct-4bit",
];

/** fast/deep classification id lists for a backend, in registry order,
 * expanding each entry's canonical id followed by its aliases. */
export function backendModelQuality(backend: BackendName): { fast: string[]; deep: string[] } {
  const fast: string[] = [];
  const deep: string[] = [];
  for (const model of MODELS) {
    if (!model.servedBy.includes(backend)) continue;
    const ids = [model.id, ...(model.aliases ?? [])];
    (model.quality === "deep" ? deep : fast).push(...ids);
  }
  return { fast, deep };
}

/** Per-model context overrides for a backend, or undefined when none apply
 * (so the config field is omitted, matching the schema's optional shape). */
export function backendContextOverrides(backend: BackendName): Record<string, number> | undefined {
  const overrides: Record<string, number> = {};
  for (const model of MODELS) {
    if (model.contextTokens === undefined) continue;
    if (!model.servedBy.includes(backend)) continue;
    overrides[model.id] = model.contextTokens;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Cluster launch-profile model ids (cluster/models.env defaults). */
export function clusterModels(): { fast: string; overnight: string; test: string } {
  const pick = (profile: "fast" | "overnight" | "test"): string => {
    const entry = MODELS.find((model) => model.clusterProfile === profile);
    if (entry === undefined) throw new Error(`No cluster model for profile ${profile}`);
    return entry.id;
  };
  return { fast: pick("fast"), overnight: pick("overnight"), test: pick("test") };
}

/** `llm` CLI model entries (extra-openai-models.yaml), in registry order. */
export function llmCliModels(): { alias: string; modelId: string }[] {
  const entries: { alias: string; modelId: string }[] = [];
  for (const model of MODELS) {
    if (model.llmAlias === undefined) continue;
    entries.push({ alias: model.llmAlias, modelId: model.id });
  }
  return entries;
}

export type OpencodeProvider = "omlx" | "mlxcluster";

/** OpenCode-selectable models for a provider, in registry order. */
export function opencodeModels(provider: OpencodeProvider): { id: string; name: string }[] {
  const models: { id: string; name: string }[] = [];
  for (const model of MODELS) {
    if (model.opencode?.provider !== provider) continue;
    models.push({ id: model.id, name: model.opencode.name });
  }
  return models;
}

/** The default OpenCode model id for a provider: the daily-hq model if it lives
 * there, else the first selectable model. Undefined if the provider has none. */
export function opencodeDefault(provider: OpencodeProvider): string | undefined {
  const daily = MODELS.find(
    (model) => model.role === "daily-hq" && model.opencode?.provider === provider,
  );
  const fallback = MODELS.find((model) => model.opencode?.provider === provider);
  return (daily ?? fallback)?.id;
}

/** The llm-CLI alias for a role marker (used by the shell env). */
export function roleAlias(role: "daily-driver" | "daily-hq"): string {
  const entry = MODELS.find((model) => model.role === role);
  if (entry?.llmAlias === undefined) {
    throw new Error(`No llmAlias for role ${role}`);
  }
  return entry.llmAlias;
}
