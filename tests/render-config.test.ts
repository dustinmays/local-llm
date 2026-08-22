import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { DelegateConfigSchema, ModelQualityConfigSchema } from "../src/config.js";
import {
  BACKENDS,
  backendContextOverrides,
  backendModelQuality,
  baseUrl,
  clusterModels,
  llmCliModels,
  MODELS,
  roleAlias,
} from "../src/shared-config.js";
import { surfaces } from "../src/render-config.js";

const repoRoot = process.cwd();

describe("shared-config → DEFAULT_CONFIG derivation", () => {
  it("produces a config that passes the delegate schema", () => {
    expect(DelegateConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it("derives each backend's fast/deep lists that satisfy the quality schema", () => {
    for (const backend of ["controller", "worker", "cluster"] as const) {
      const quality = backendModelQuality(backend);
      // The real safety net: fast/deep must not overlap and ids must be unique.
      expect(ModelQualityConfigSchema.safeParse(quality).success).toBe(true);
    }
  });

  it("matches the derived values into DEFAULT_CONFIG", () => {
    for (const backend of ["controller", "worker", "cluster"] as const) {
      expect(DEFAULT_CONFIG.backends[backend].url).toBe(baseUrl(backend));
      expect(DEFAULT_CONFIG.backends[backend].model_discovery).toBe(BACKENDS[backend].discovery);
      expect(DEFAULT_CONFIG.backends[backend].model_quality).toEqual(backendModelQuality(backend));
      expect(DEFAULT_CONFIG.backends[backend].context_window_overrides).toEqual(
        backendContextOverrides(backend),
      );
    }
  });

  it("keeps the muse/gemma context overrides on the controller", () => {
    expect(backendContextOverrides("controller")).toEqual({
      "google/gemma-4-e4b": 32_768,
      "meta/muse-glimmer": 90_000,
    });
    // worker/cluster have no per-model overrides.
    expect(backendContextOverrides("worker")).toBeUndefined();
    expect(backendContextOverrides("cluster")).toBeUndefined();
  });
});

describe("registry helpers", () => {
  it("resolves cluster launch profiles", () => {
    expect(clusterModels()).toEqual({
      fast: "mlx-community/Qwen3.5-35B-A3B-4bit",
      overnight: "mlx-community/Qwen3.5-122B-A10B-4bit",
      test: "mlx-community/Llama-3.2-3B-Instruct-4bit",
    });
  });

  it("maps llm CLI aliases to model ids via the controller endpoint", () => {
    expect(llmCliModels()).toEqual([
      { alias: "gemma", modelId: "google/gemma-4-e4b" },
      { alias: "muse", modelId: "meta/muse-glimmer" },
    ]);
  });

  it("resolves daily-driver role aliases used by the shell env", () => {
    expect(roleAlias("daily-driver")).toBe("gemma");
    expect(roleAlias("daily-hq")).toBe("muse");
  });

  it("keeps every model id unique across the registry", () => {
    const ids = MODELS.flatMap((model) => [model.id, ...(model.aliases ?? [])]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("rendered surfaces", () => {
  it("renders deterministically (idempotent content)", () => {
    const first = surfaces();
    const second = surfaces();
    expect(second).toEqual(first);
    for (const surface of first) expect(surface.content.length).toBeGreaterThan(0);
  });

  it("matches the committed files on disk (no drift)", async () => {
    for (const surface of surfaces()) {
      const onDisk = await readFile(join(repoRoot, surface.relativePath), "utf8");
      expect(onDisk, `${surface.relativePath} is stale — run pnpm config:render`).toBe(
        surface.content,
      );
    }
  });

  it("round-trips model ids/baseURL into extra-openai-models.yaml", () => {
    const yaml = surfaces().find(
      (s) => s.relativePath === "config/extra-openai-models.yaml",
    )?.content;
    expect(yaml).toBeDefined();
    for (const { alias, modelId } of llmCliModels()) {
      expect(yaml).toContain(`model_id: ${alias}`);
      expect(yaml).toContain(`model_name: ${modelId}`);
    }
    expect(yaml).toContain(baseUrl("controller"));
  });

  it("emits bash-sourceable shell env with the daily-driver aliases", () => {
    const env = surfaces().find((s) => s.relativePath === "shell/llm.env")?.content ?? "";
    expect(env).toMatch(new RegExp(`export LLM_SERVE_PORT=${String(BACKENDS.controller.port)}`));
    expect(env).toMatch(/export LLM_MODEL=gemma/);
    expect(env).toMatch(/export LLM_MODEL_HQ=muse/);
  });
});
