import { describe, expect, it } from "vitest";
import { OpenAiCompatibleProbe } from "../src/backends/openai-compatible.js";
import type { BackendProbe, ProbeRequest } from "../src/backends/types.js";
import { DEFAULT_CONFIG, type DelegateConfig } from "../src/config.js";
import type { ConfiguredBackendStatus } from "../src/contracts.js";
import { Logger } from "../src/logging.js";
import { StatusService } from "../src/service.js";
import { startFakeUpstream } from "./helpers/fake-upstream.js";

function definition(url: string) {
  return { ...DEFAULT_CONFIG.backends.controller, url, model_discovery: "openai" as const };
}

async function probe(url: string, timeout = 500): Promise<ConfiguredBackendStatus> {
  return await new OpenAiCompatibleProbe().probe({
    backend: "controller",
    definition: definition(url),
    connectTimeoutMs: Math.min(timeout, 100),
    responseTimeoutMs: timeout,
  });
}

async function probeLmStudio(url: string, timeout = 500): Promise<ConfiguredBackendStatus> {
  return await new OpenAiCompatibleProbe().probe({
    backend: "controller",
    definition: { ...DEFAULT_CONFIG.backends.controller, url, model_discovery: "lmstudio" },
    connectTimeoutMs: Math.min(timeout, 100),
    responseTimeoutMs: timeout,
  });
}

describe("OpenAI-compatible backend probe", () => {
  it("uses only GET /health and GET /v1/models and strips unexpected metadata", async () => {
    const upstream = await startFakeUpstream();
    try {
      const result = await probe(upstream.url);
      expect(result.availability).toBe("ready");
      expect(result.health).toBe(true);
      expect(result.models).toEqual([
        { id: "fake-model", object: "model", created: 1, owned_by: "local" },
      ]);
      expect(result.loaded_models).toEqual(result.models);
      expect(upstream.requests).toEqual([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/v1/models" },
      ]);
    } finally {
      await upstream.close();
    }
  });

  it("preserves all returned model entries", async () => {
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        request.url === "/health"
          ? "{}"
          : JSON.stringify({ data: [{ id: "one" }, { id: "two", owned_by: "owner" }] }),
      );
    });
    try {
      const result = await probe(upstream.url);
      expect(result.models).toEqual([
        { id: "one", object: null, created: null, owned_by: null },
        { id: "two", object: null, created: null, owned_by: "owner" },
      ]);
    } finally {
      await upstream.close();
    }
  });

  it("uses LM Studio native metadata to exclude JIT-visible unloaded and embedding models", async () => {
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") {
        response.end('{"error":"Unexpected endpoint or method. (GET /health)"}');
        return;
      }
      if (request.url === "/v1/models") {
        response.end(
          JSON.stringify({
            data: [
              { id: "loaded-llm", object: "model", owned_by: "organization_owner" },
              { id: "unloaded-llm", object: "model", owned_by: "organization_owner" },
              { id: "embedding-model", object: "model", owned_by: "organization_owner" },
            ],
          }),
        );
        return;
      }
      if (request.url === "/api/v1/models") {
        response.end(
          JSON.stringify({
            models: [
              {
                type: "llm",
                key: "loaded-llm",
                loaded_instances: [{ id: "loaded-llm", config: { context_length: 65_536 } }],
              },
              { type: "llm", key: "unloaded-llm", loaded_instances: [] },
              { type: "embedding", key: "embedding-model", loaded_instances: [] },
            ],
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    try {
      const result = await probeLmStudio(upstream.url);
      expect(result.availability).toBe("ready");
      expect(result.models.map((model) => model.id)).toEqual([
        "loaded-llm",
        "unloaded-llm",
        "embedding-model",
      ]);
      expect(result.loaded_models.map((model) => model.id)).toEqual(["loaded-llm"]);
      expect(result.warnings).toEqual([
        "Excluded 2 unloaded or non-generative LM Studio catalog entries.",
      ]);
      expect(upstream.requests).toEqual([
        { method: "GET", path: "/health" },
        { method: "GET", path: "/v1/models" },
        { method: "GET", path: "/api/v1/models" },
      ]);
    } finally {
      await upstream.close();
    }
  });

  it("maps an LM Studio catalog with no loaded LLM to MODEL_NOT_LOADED", async () => {
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") response.end("{}");
      else if (request.url === "/v1/models") response.end('{"data":[{"id":"available"}]}');
      else if (request.url === "/api/v1/models") {
        response.end('{"models":[{"type":"llm","key":"available","loaded_instances":[]}]}');
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    try {
      const result = await probeLmStudio(upstream.url);
      expect(result.health).toBe(true);
      expect(result.models.map((model) => model.id)).toEqual(["available"]);
      expect(result.loaded_models).toEqual([]);
      expect(result.error?.code).toBe("MODEL_NOT_LOADED");
    } finally {
      await upstream.close();
    }
  });

  it.each([
    ["malformed native JSON", 200, "{"],
    ["schema-invalid native metadata", 200, '{"models":[{"type":"llm"}]}'],
    ["non-success native response", 503, '{"private":"do not expose"}'],
  ])("fails closed for %s", async (_label, statusCode, body) => {
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") response.end("{}");
      else if (request.url === "/v1/models") response.end('{"data":[{"id":"model"}]}');
      else if (request.url === "/api/v1/models") {
        response.statusCode = statusCode;
        response.end(body);
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    try {
      const result = await probeLmStudio(upstream.url);
      expect(result.health).toBe(true);
      expect(result.loaded_models).toEqual([]);
      expect(result.error?.code).toBe("UPSTREAM_PROTOCOL_ERROR");
      expect(JSON.stringify(result)).not.toContain("do not expose");
    } finally {
      await upstream.close();
    }
  });

  it("fails closed when LM Studio loaded instance IDs do not match the visible catalog", async () => {
    const upstream = await startFakeUpstream((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/health") response.end("{}");
      else if (request.url === "/v1/models") response.end('{"data":[{"id":"visible"}]}');
      else if (request.url === "/api/v1/models") {
        response.end(
          '{"models":[{"type":"llm","key":"visible","loaded_instances":[{"id":"missing"}]}]}',
        );
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    try {
      const result = await probeLmStudio(upstream.url);
      expect(result.error?.code).toBe("UPSTREAM_PROTOCOL_ERROR");
      expect(result.loaded_models).toEqual([]);
    } finally {
      await upstream.close();
    }
  });

  it("maps an empty model list to MODEL_NOT_LOADED", async () => {
    const upstream = await startFakeUpstream((request, response) => {
      response.end(request.url === "/health" ? "{}" : '{"data":[]}');
    });
    try {
      const result = await probe(upstream.url);
      expect(result.health).toBe(true);
      expect(result.error?.code).toBe("MODEL_NOT_LOADED");
    } finally {
      await upstream.close();
    }
  });

  it.each([
    ["malformed JSON", "{"],
    ["invalid metadata", '{"data":[{"id":7}]}'],
  ])("maps %s model responses to UPSTREAM_PROTOCOL_ERROR", async (_label, body) => {
    const upstream = await startFakeUpstream((request, response) => {
      response.end(request.url === "/health" ? "{}" : body);
    });
    try {
      const result = await probe(upstream.url);
      expect(result.error?.code).toBe("UPSTREAM_PROTOCOL_ERROR");
    } finally {
      await upstream.close();
    }
  });

  it("maps non-success health and model responses deterministically", async () => {
    const healthFailure = await startFakeUpstream((_request, response) => {
      response.statusCode = 503;
      response.end("private failure body");
    });
    try {
      const result = await probe(healthFailure.url);
      expect(result.error?.code).toBe("BACKEND_UNAVAILABLE");
      expect(result.error?.details).toEqual({ http_status: 503 });
      expect(JSON.stringify(result)).not.toContain("private failure body");
    } finally {
      await healthFailure.close();
    }

    const modelFailure = await startFakeUpstream((request, response) => {
      if (request.url === "/v1/models") response.statusCode = 502;
      response.end("private model failure");
    });
    try {
      const result = await probe(modelFailure.url);
      expect(result.health).toBe(true);
      expect(result.error?.code).toBe("UPSTREAM_PROTOCOL_ERROR");
      expect(JSON.stringify(result)).not.toContain("private model failure");
    } finally {
      await modelFailure.close();
    }
  });

  it("bounds slow and oversized responses", async () => {
    const slow = await startFakeUpstream((_request, response) => {
      setTimeout(() => response.end("{}"), 200);
    });
    try {
      const started = performance.now();
      const result = await probe(slow.url, 50);
      expect(result.error?.code).toBe("UPSTREAM_TIMEOUT");
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await slow.close();
    }

    const oversized = await startFakeUpstream((request, response) => {
      response.end(request.url === "/health" ? "{}" : "x".repeat(1_048_577));
    });
    try {
      expect((await probe(oversized.url)).error?.code).toBe("UPSTREAM_PROTOCOL_ERROR");
    } finally {
      await oversized.close();
    }
  });

  it("maps an unreachable loopback port without retrying", async () => {
    const upstream = await startFakeUpstream();
    const url = upstream.url;
    await upstream.close();
    const result = await probe(url);
    expect(result.error?.code).toBe("BACKEND_UNAVAILABLE");
  });
});

function ready(request: ProbeRequest, models = ["model"]): ConfiguredBackendStatus {
  const metadata = models.map((id) => ({ id, object: null, created: null, owned_by: null }));
  return {
    backend: request.backend,
    enabled: true,
    health: true,
    availability: "ready",
    models: metadata,
    loaded_models: metadata,
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

describe("status orchestration", () => {
  it("probes concurrently and auto-selects in controller, worker, cluster order", async () => {
    const completionOrder: string[] = [];
    const adapter: BackendProbe = {
      async probe(request) {
        await new Promise((resolve) =>
          setTimeout(resolve, request.backend === "controller" ? 20 : 1),
        );
        completionOrder.push(request.backend);
        return ready(request);
      },
    };
    const service = new StatusService(
      DEFAULT_CONFIG,
      adapter,
      new Logger("error", () => undefined),
    );
    const status = await service.status();
    expect(completionOrder[0]).not.toBe("controller");
    expect(status.configured_backends.map((item) => item.backend)).toEqual([
      "controller",
      "worker",
      "cluster",
    ]);
    expect(status.selected_backend).toBe("controller");
    expect(status.healthy_backends).toEqual(["controller", "worker", "cluster"]);
    expect(status.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("honors explicit backend selection and leaves ambiguous models at top level null", async () => {
    const adapter: BackendProbe = {
      probe(request) {
        return Promise.resolve(
          ready(request, request.backend === "worker" ? ["one", "two"] : ["one"]),
        );
      },
    };
    const service = new StatusService(
      DEFAULT_CONFIG,
      adapter,
      new Logger("error", () => undefined),
    );
    const status = await service.status({ backend: "worker" });
    expect(status.selected_backend).toBe("worker");
    expect(status.model).toBeNull();
    expect(status.warnings).toHaveLength(1);
  });

  it("selects one loaded model even when the visible catalog contains multiple models", async () => {
    const adapter: BackendProbe = {
      probe(request) {
        const value = ready(request, ["loaded", "unloaded", "embedding"]);
        const loaded = value.models.at(0);
        if (loaded === undefined) throw new Error("Missing loaded fixture model");
        value.loaded_models = [loaded];
        value.warnings = ["Excluded 2 unloaded or non-generative LM Studio catalog entries."];
        return Promise.resolve(value);
      },
    };
    const service = new StatusService(
      DEFAULT_CONFIG,
      adapter,
      new Logger("error", () => undefined),
    );
    const status = await service.status({ backend: "controller" });
    expect(status.model?.id).toBe("loaded");
    expect(status.configured_backends[0]?.models).toHaveLength(3);
    expect(status.configured_backends[0]?.loaded_models).toHaveLength(1);
    expect(status.warnings).toEqual([]);
  });

  it("classifies an unambiguous status model only through configured exact IDs", async () => {
    const value: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    value.backends.controller.model_quality.fast = ["configured-fast"];
    const adapter: BackendProbe = {
      probe(request) {
        return Promise.resolve(ready(request, ["configured-fast"]));
      },
    };
    const service = new StatusService(value, adapter, new Logger("error", () => undefined));
    expect((await service.status({ backend: "controller" })).quality_class).toBe("fast");
    value.backends.controller.model_quality.fast = [];
    expect(
      (
        await new StatusService(value, adapter, new Logger("error", () => undefined)).status({
          backend: "controller",
        })
      ).quality_class,
    ).toBe("unknown");
  });

  it("does not call disabled adapters and safely maps unexpected adapter errors", async () => {
    let calls = 0;
    const adapter: BackendProbe = {
      probe() {
        calls += 1;
        return Promise.reject(new Error("secret stack and body"));
      },
    };
    const config: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    config.backends.worker.enabled = false;
    config.backends.cluster.enabled = false;
    const service = new StatusService(config, adapter, new Logger("error", () => undefined));
    const status = await service.status({ backend: "controller" });
    expect(calls).toBe(1);
    expect(status.selected_backend).toBe("controller");
    expect(status.endpoint).toBe(config.backends.controller.url);
    expect(status.error?.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(status)).not.toContain("secret stack");
  });
});
