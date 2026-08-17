import http from "node:http";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type {
  BackendProbe,
  CompletionAdapter,
  CompletionRequest,
  CompletionResult,
  ProbeRequest,
} from "./types.js";
import type { ConfiguredBackendStatus, ModelMetadata, StableErrorCode } from "../contracts.js";
import { stableError, UpstreamError } from "../errors.js";

const MAX_RESPONSE_BYTES = 1_048_576;

const UpstreamModelSchema = z.object({
  id: z.string().min(1).max(1024),
  object: z.string().max(128).optional(),
  created: z.number().int().nonnegative().optional(),
  owned_by: z.string().max(1024).optional(),
});

const ModelsResponseSchema = z.object({
  object: z.string().max(128).optional(),
  data: z.array(UpstreamModelSchema).max(10_000),
});

const LmStudioModelsResponseSchema = z.object({
  models: z
    .array(
      z.object({
        type: z.enum(["llm", "embedding"]),
        key: z.string().min(1).max(1024),
        loaded_instances: z.array(z.object({ id: z.string().min(1).max(1024) })).max(10_000),
      }),
    )
    .max(10_000),
});

const CompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().max(128).nullable().optional(),
        message: z.object({
          content: z.string(),
          reasoning_content: z.string().nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .looseObject({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      total_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

type RequestFailureKind = "connection" | "timeout" | "protocol";

class RequestFailure extends Error {
  constructor(readonly kind: RequestFailureKind) {
    super(kind);
    this.name = "RequestFailure";
  }
}

type BoundedResponse = {
  statusCode: number;
  body: Buffer;
};

function boundedRequest(
  url: URL,
  connectTimeoutMs: number,
  responseTimeoutMs: number,
  options: {
    method: "GET" | "POST";
    body?: Buffer;
    maximumBytes?: number;
    signal?: AbortSignal;
  },
): Promise<BoundedResponse> {
  if (options.signal?.aborted) return Promise.reject(new RequestFailure("timeout"));
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    let request: ClientRequest;
    let response: IncomingMessage | null = null;
    let settled = false;
    let connected = false;

    const onSignalAbort = (): void => abort(new RequestFailure("timeout"));
    const finish = (error: RequestFailure | null, value?: BoundedResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      options.signal?.removeEventListener("abort", onSignalAbort);
      if (error) reject(error);
      else if (value) resolve(value);
    };

    const abort = (failure: RequestFailure): void => {
      finish(failure);
      response?.destroy();
      request.destroy();
    };

    const connectTimer = setTimeout(() => {
      if (!connected) abort(new RequestFailure("timeout"));
    }, connectTimeoutMs);
    connectTimer.unref();
    const responseTimer = setTimeout(() => abort(new RequestFailure("timeout")), responseTimeoutMs);
    responseTimer.unref();

    request = transport.request(
      url,
      {
        method: options.method,
        headers: {
          accept: "application/json",
          ...(options.body === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(options.body.length),
              }),
        },
        agent: false,
      },
      (incoming) => {
        response = incoming;
        const chunks: Buffer[] = [];
        let byteCount = 0;
        incoming.on("data", (chunk: Buffer) => {
          byteCount += chunk.length;
          if (byteCount > (options.maximumBytes ?? MAX_RESPONSE_BYTES)) {
            abort(new RequestFailure("protocol"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("end", () => {
          finish(null, {
            statusCode: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks, byteCount),
          });
        });
        incoming.on("aborted", () => finish(new RequestFailure("connection")));
        incoming.on("error", () => finish(new RequestFailure("connection")));
      },
    );

    request.on("socket", (socket) => {
      if (!socket.connecting) {
        connected = true;
        clearTimeout(connectTimer);
        return;
      }
      const event = url.protocol === "https:" ? "secureConnect" : "connect";
      socket.once(event, () => {
        connected = true;
        clearTimeout(connectTimer);
      });
    });
    request.on("error", () => finish(new RequestFailure("connection")));
    options.signal?.addEventListener("abort", onSignalAbort, { once: true });
    if (options.signal?.aborted) {
      onSignalAbort();
      return;
    }
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

export function boundedGet(
  url: URL,
  connectTimeoutMs: number,
  responseTimeoutMs: number,
  maximumBytes = MAX_RESPONSE_BYTES,
): Promise<BoundedResponse> {
  return boundedRequest(url, connectTimeoutMs, responseTimeoutMs, {
    method: "GET",
    maximumBytes,
  });
}

function endpoints(apiBase: string): {
  health: URL;
  models: URL;
  lmStudioModels: URL;
  completions: URL;
} {
  const base = new URL(apiBase);
  const health = new URL("/health", base.origin);
  const path = base.pathname.replace(/\/+$/, "");
  const models = new URL(`${path}/models`, base.origin);
  const lmStudioModels = new URL("/api/v1/models", base.origin);
  const completions = new URL(`${path}/chat/completions`, base.origin);
  return { health, models, lmStudioModels, completions };
}

function mapRequestFailure(failure: unknown): StableErrorCode {
  if (failure instanceof RequestFailure) {
    if (failure.kind === "timeout") return "UPSTREAM_TIMEOUT";
    if (failure.kind === "protocol") return "UPSTREAM_PROTOCOL_ERROR";
  }
  return "BACKEND_UNAVAILABLE";
}

function publicModels(value: Buffer): ModelMetadata[] | null {
  let json: unknown;
  try {
    json = JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = ModelsResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.data.map((model) => ({
    id: model.id,
    object: model.object ?? null,
    created: model.created ?? null,
    owned_by: model.owned_by ?? null,
  }));
}

function lmStudioLoadedModelIds(value: Buffer): Set<string> | null {
  let json: unknown;
  try {
    json = JSON.parse(value.toString("utf8")) as unknown;
  } catch {
    return null;
  }
  const parsed = LmStudioModelsResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  return new Set(
    parsed.data.models
      .filter((model) => model.type === "llm")
      .flatMap((model) => model.loaded_instances.map((instance) => instance.id)),
  );
}

function result(
  request: ProbeRequest,
  start: number,
  values: Partial<ConfiguredBackendStatus>,
): ConfiguredBackendStatus {
  return {
    backend: request.backend,
    enabled: true,
    health: false,
    availability: "offline",
    models: [],
    loaded_models: [],
    endpoint: request.definition.url,
    latency_ms: Math.max(0, Math.round(performance.now() - start)),
    resource_groups: [...request.definition.resource_groups],
    resource_states: [],
    queue_depth: 0,
    lease_age_seconds: null,
    cooldown_remaining_seconds: null,
    warnings: [],
    startup_hint: request.definition.startup_hint,
    error: null,
    ...values,
  };
}

export class OpenAiCompatibleProbe implements BackendProbe {
  async probe(request: ProbeRequest): Promise<ConfiguredBackendStatus> {
    const start = performance.now();
    const target = endpoints(request.definition.url);
    let healthResponse: BoundedResponse;
    try {
      healthResponse = await boundedGet(
        target.health,
        request.connectTimeoutMs,
        request.responseTimeoutMs,
      );
    } catch (error) {
      const code = mapRequestFailure(error);
      return result(request, start, {
        error: stableError(code, undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
        }),
      });
    }

    if (healthResponse.statusCode < 200 || healthResponse.statusCode >= 300) {
      return result(request, start, {
        error: stableError("BACKEND_UNAVAILABLE", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          details: { http_status: healthResponse.statusCode },
        }),
      });
    }

    let modelsResponse: BoundedResponse;
    try {
      modelsResponse = await boundedGet(
        target.models,
        request.connectTimeoutMs,
        request.responseTimeoutMs,
      );
    } catch (error) {
      const code = mapRequestFailure(error);
      return result(request, start, {
        health: true,
        error: stableError(code, undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
        }),
      });
    }

    if (modelsResponse.statusCode < 200 || modelsResponse.statusCode >= 300) {
      return result(request, start, {
        health: true,
        error: stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          retryable: false,
          details: { http_status: modelsResponse.statusCode },
        }),
      });
    }

    const models = publicModels(modelsResponse.body);
    if (models === null) {
      return result(request, start, {
        health: true,
        error: stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          retryable: false,
        }),
      });
    }
    let loadedModels = models;
    const warnings: string[] = [];
    if (request.definition.model_discovery === "lmstudio") {
      let nativeResponse: BoundedResponse;
      try {
        nativeResponse = await boundedGet(
          target.lmStudioModels,
          request.connectTimeoutMs,
          request.responseTimeoutMs,
        );
      } catch (error) {
        const code = mapRequestFailure(error);
        return result(request, start, {
          health: true,
          models,
          error: stableError(code, undefined, {
            backend: request.backend,
            startupHint: request.definition.startup_hint,
          }),
        });
      }
      if (nativeResponse.statusCode < 200 || nativeResponse.statusCode >= 300) {
        return result(request, start, {
          health: true,
          models,
          error: stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
            backend: request.backend,
            startupHint: request.definition.startup_hint,
            retryable: false,
            details: { http_status: nativeResponse.statusCode },
          }),
        });
      }
      const loadedModelIds = lmStudioLoadedModelIds(nativeResponse.body);
      if (loadedModelIds === null) {
        return result(request, start, {
          health: true,
          models,
          error: stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
            backend: request.backend,
            startupHint: request.definition.startup_hint,
            retryable: false,
          }),
        });
      }
      loadedModels = models.filter((model) => loadedModelIds.has(model.id));
      if (loadedModelIds.size !== loadedModels.length) {
        return result(request, start, {
          health: true,
          models,
          error: stableError(
            "UPSTREAM_PROTOCOL_ERROR",
            "LM Studio loaded-model metadata did not match its OpenAI-compatible catalog.",
            {
              backend: request.backend,
              startupHint: request.definition.startup_hint,
              retryable: false,
            },
          ),
        });
      }
      const excluded = models.length - loadedModels.length;
      if (excluded > 0) {
        warnings.push(
          `Excluded ${String(excluded)} unloaded or non-generative LM Studio catalog entries.`,
        );
      }
    }
    if (loadedModels.length === 0) {
      return result(request, start, {
        health: true,
        models,
        warnings,
        error: stableError("MODEL_NOT_LOADED", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
        }),
      });
    }

    return result(request, start, {
      health: true,
      availability: "ready",
      models,
      loaded_models: loadedModels,
      warnings,
    });
  }
}

export class OpenAiCompatibleCompletionAdapter implements CompletionAdapter {
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body = Buffer.from(
      JSON.stringify({
        model: request.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.prompt },
        ],
        max_tokens: request.maxOutputTokens,
        stream: false,
        ...(request.definition.model_discovery === "lmstudio" ? { reasoning_effort: "none" } : {}),
      }),
      "utf8",
    );
    let response: BoundedResponse;
    try {
      response = await boundedRequest(
        endpoints(request.definition.url).completions,
        request.connectTimeoutMs,
        request.responseTimeoutMs,
        {
          method: "POST",
          body,
          maximumBytes: 8_388_608,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
    } catch (error) {
      const code = mapRequestFailure(error);
      throw new UpstreamError(
        stableError(code, undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
        }),
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const code =
        response.statusCode === 429
          ? "RATE_LIMITED"
          : response.statusCode === 408 || response.statusCode === 504
            ? "UPSTREAM_TIMEOUT"
            : "UPSTREAM_PROTOCOL_ERROR";
      throw new UpstreamError(
        stableError(code, undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          retryable: code !== "UPSTREAM_PROTOCOL_ERROR",
          details: { http_status: response.statusCode },
        }),
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(response.body.toString("utf8")) as unknown;
    } catch {
      throw new UpstreamError(
        stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          retryable: false,
        }),
      );
    }
    const parsed = CompletionResponseSchema.safeParse(value);
    if (!parsed.success) {
      throw new UpstreamError(
        stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          retryable: false,
        }),
      );
    }
    const choice = parsed.data.choices.at(0);
    if (choice === undefined) {
      throw new UpstreamError(
        stableError("UPSTREAM_PROTOCOL_ERROR", undefined, {
          backend: request.backend,
          startupHint: request.definition.startup_hint,
          retryable: false,
        }),
      );
    }
    if (choice.message.content.trim().length === 0) {
      throw new UpstreamError(
        stableError(
          "UPSTREAM_PROTOCOL_ERROR",
          "The backend did not return a final answer within the output limit.",
          {
            backend: request.backend,
            startupHint: request.definition.startup_hint,
            retryable: false,
            details: {
              empty_content: true,
              finish_reason: choice.finish_reason ?? "unknown",
              reasoning_content_present: (choice.message.reasoning_content?.trim().length ?? 0) > 0,
            },
          },
        ),
      );
    }
    return {
      answer: choice.message.content,
      usage: {
        promptTokens: parsed.data.usage?.prompt_tokens ?? null,
        completionTokens: parsed.data.usage?.completion_tokens ?? null,
        totalTokens: parsed.data.usage?.total_tokens ?? null,
      },
    };
  }
}
