import { randomUUID } from "node:crypto";
import type { CompletionAdapter } from "./backends/types.js";
import { OpenAiCompatibleCompletionAdapter } from "./backends/openai-compatible.js";
import { classifyModel, type DelegateConfig } from "./config.js";
import { collectContext, resolveWorkspaceRoot, type ResolvedWorkspace } from "./context.js";
import {
  DelegateResultSchema,
  type ConfiguredBackendStatus,
  type DelegateInput,
  type DelegateResult,
  type ModelMetadata,
  type QualityClass,
  type StableError,
} from "./contracts.js";
import { asInternalError, DomainError, stableError, UpstreamError } from "./errors.js";
import { Logger } from "./logging.js";
import { DELEGATION_SYSTEM_PROMPT, renderDelegationPrompt } from "./prompt.js";
import { StatusService } from "./service.js";

export type DelegateOptions = {
  requestId?: string;
  command?: string;
  signal?: AbortSignal;
};

type Selection = {
  backendStatus: ConfiguredBackendStatus;
  model: ModelMetadata;
  quality: QualityClass;
  warnings: string[];
};

function elapsedSeconds(start: number): number {
  return Number(((performance.now() - start) / 1_000).toFixed(3));
}

function selectModel(
  config: DelegateConfig,
  backends: ConfiguredBackendStatus[],
  input: DelegateInput,
): Selection | StableError {
  const routable = backends.filter(
    (backend) => backend.enabled && backend.health && backend.models.length > 0,
  );
  const automaticOrder =
    input.quality === "deep"
      ? (["cluster", "controller", "worker"] as const)
      : (["controller", "worker", "cluster"] as const);
  const candidates =
    input.backend === "auto"
      ? ["ready", "occupied"].flatMap((phase) =>
          automaticOrder.flatMap((name) =>
            routable.filter(
              (backend) =>
                backend.backend === name &&
                (phase === "ready"
                  ? backend.availability === "ready"
                  : backend.availability !== "ready"),
            ),
          ),
        )
      : backends.filter((backend) => backend.backend === input.backend);
  const explicit = input.backend !== "auto";
  const requestedBackend = explicit ? candidates.at(0) : undefined;
  if (
    explicit &&
    (requestedBackend?.enabled !== true ||
      !requestedBackend.health ||
      requestedBackend.models.length === 0)
  ) {
    return (
      requestedBackend?.error ??
      stableError("BACKEND_UNAVAILABLE", undefined, {
        backend: input.backend === "auto" ? null : input.backend,
        startupHint: requestedBackend?.startup_hint ?? null,
      })
    );
  }

  for (const backend of candidates) {
    if (!backend.health || backend.models.length === 0) continue;
    const classified = backend.models.map((model) => ({
      model,
      quality: classifyModel(config.backends[backend.backend], model.id),
    }));
    const matching =
      input.quality === "auto"
        ? classified
        : classified.filter((item) => item.quality === input.quality);
    if (matching.length === 1) {
      const match = matching.at(0);
      if (match !== undefined) return { backendStatus: backend, ...match, warnings: [] };
    }
    if (explicit && matching.length > 1) {
      return stableError(
        "INVALID_REQUEST",
        "Multiple loaded models match the request; model selection is ambiguous.",
        {
          backend: backend.backend,
          startupHint: backend.startup_hint,
          retryable: false,
        },
      );
    }
  }

  if (candidates.length === 0) {
    const firstEnabled = backends.find((backend) => backend.enabled);
    return (
      firstEnabled?.error ??
      stableError("BACKEND_UNAVAILABLE", undefined, {
        startupHint: firstEnabled?.startup_hint ?? null,
      })
    );
  }
  if (input.quality !== "auto") {
    const onlyCluster = routable.length === 1 ? routable.at(0) : undefined;
    if (
      input.backend === "auto" &&
      onlyCluster?.backend === "cluster" &&
      onlyCluster.models.length === 1
    ) {
      const model = onlyCluster.models.at(0);
      if (model !== undefined) {
        return {
          backendStatus: onlyCluster,
          model,
          quality: classifyModel(config.backends.cluster, model.id),
          warnings: [
            `Only the cluster backend is available; its loaded model does not match requested quality ${input.quality}.`,
          ],
        };
      }
    }
    const available = candidates
      .flatMap((backend) =>
        backend.models.map((model) => classifyModel(config.backends[backend.backend], model.id)),
      )
      .join(",")
      .slice(0, 1_024);
    return stableError(
      "QUALITY_MISMATCH",
      "No unambiguous loaded model matches the requested quality.",
      {
        backend: explicit && input.backend !== "auto" ? input.backend : null,
        startupHint: candidates.at(0)?.startup_hint ?? null,
        retryable: false,
        details: { requested_quality: input.quality, available_quality: available },
      },
    );
  }
  return stableError("INVALID_REQUEST", "Loaded model selection is ambiguous.", {
    backend: explicit && input.backend !== "auto" ? input.backend : null,
    startupHint: candidates.at(0)?.startup_hint ?? null,
    retryable: false,
  });
}

export class DelegationService {
  private constructor(
    readonly config: DelegateConfig,
    private readonly workspace: ResolvedWorkspace,
    private readonly statusService: StatusService,
    private readonly completion: CompletionAdapter,
    readonly logger: Logger,
  ) {}

  static async create(options: {
    config: DelegateConfig;
    statusService: StatusService;
    completion?: CompletionAdapter;
    logger?: Logger;
  }): Promise<DelegationService> {
    const workspace = await resolveWorkspaceRoot(options.config.workspace_root);
    return new DelegationService(
      options.config,
      workspace,
      options.statusService,
      options.completion ?? new OpenAiCompatibleCompletionAdapter(),
      options.logger ?? options.statusService.logger,
    );
  }

  async delegate(input: DelegateInput, options: DelegateOptions = {}): Promise<DelegateResult> {
    const requestId = options.requestId ?? randomUUID();
    const command = options.command ?? "delegate";
    const start = performance.now();
    let selection: Selection | null = null;
    let manifest: DelegateResult["context_manifest"] = [];
    let warnings: string[] = [];
    let inputCharacters = 0;
    let queueSeconds = 0;
    let availabilityOverride: DelegateResult["availability"] | null = null;

    const failure = (error: StableError): DelegateResult => {
      const parsed = DelegateResultSchema.parse({
        ok: false,
        request_id: requestId,
        backend: selection?.backendStatus.backend ?? error.backend,
        endpoint: selection?.backendStatus.endpoint ?? null,
        model: selection?.model ?? null,
        requested_quality: input.quality,
        actual_quality: selection?.quality ?? "unknown",
        availability:
          availabilityOverride ??
          (error.code === "BACKEND_BUSY"
            ? "busy"
            : error.code === "BACKEND_COOLDOWN"
              ? "cooldown"
              : error.code === "INTERNAL_ERROR" && error.details.availability_state === "degraded"
                ? "degraded"
                : (selection?.backendStatus.availability ?? "offline")),
        answer: null,
        context_manifest: manifest,
        elapsed_seconds: elapsedSeconds(start),
        queue_seconds: queueSeconds,
        input_characters: inputCharacters,
        truncated: manifest.some((entry) => entry.truncated || entry.omitted),
        warnings,
        error,
      });
      this.logResult(parsed, command, start);
      return parsed;
    };

    if (input.busy_behavior === "fail" && input.max_wait_seconds !== 0) {
      return failure(
        stableError(
          "INVALID_REQUEST",
          "max_wait_seconds must be zero when busy_behavior is fail.",
          { retryable: false },
        ),
      );
    }

    try {
      const status = await this.statusService.status({
        backend: input.backend,
        requestId,
        command,
        logCompletion: false,
      });
      const selected = selectModel(this.config, status.configured_backends, input);
      if (!("backendStatus" in selected)) return failure(selected);
      selection = selected;
      warnings = [...selected.warnings];

      const emptyPrompt = renderDelegationPrompt({
        task: input.task,
        backend: input.backend,
        quality: input.quality,
        manifest: [],
        sections: [],
      });
      const emptyInputCharacters = DELEGATION_SYSTEM_PROMPT.length + emptyPrompt.length;
      if (emptyInputCharacters > input.max_input_chars) {
        return failure(
          stableError(
            "INPUT_LIMIT_EXCEEDED",
            "The task and prompt envelope exceed max_input_chars.",
            {
              backend: selection.backendStatus.backend,
              retryable: false,
            },
          ),
        );
      }
      const context = await collectContext({
        workspace: this.workspace,
        cwd: input.cwd,
        paths: input.paths,
        includeDiff: input.include_diff,
        maximumCharacters: Math.max(0, input.max_input_chars - emptyInputCharacters - 4_096),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      manifest = context.manifest;
      warnings = [...warnings, ...context.warnings];
      const prompt = renderDelegationPrompt({
        task: input.task,
        backend: input.backend,
        quality: input.quality,
        manifest,
        sections: context.sections,
      });
      inputCharacters = DELEGATION_SYSTEM_PROMPT.length + prompt.length;
      if (inputCharacters > input.max_input_chars) {
        return failure(
          stableError(
            "INPUT_LIMIT_EXCEEDED",
            "The task, context manifest, and prompt exceed max_input_chars.",
            { backend: selection.backendStatus.backend, retryable: false },
          ),
        );
      }

      const acquired = await this.statusService.coordinator.acquire({
        requestId,
        backend: selection.backendStatus.backend,
        resourceGroups: selection.backendStatus.resource_groups,
        model: selection.model.id,
        busyBehavior: input.busy_behavior,
        maximumWaitMs: input.max_wait_seconds * 1_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      queueSeconds = acquired.queueSeconds;
      const stopHeartbeat = this.statusService.coordinator.startHeartbeat(acquired.lease.lease_id);
      let answer: string;
      try {
        answer = await this.completion.complete({
          backend: selection.backendStatus.backend,
          definition: this.config.backends[selection.backendStatus.backend],
          model: selection.model.id,
          systemPrompt: DELEGATION_SYSTEM_PROMPT,
          prompt,
          maxOutputTokens: input.max_output_tokens,
          connectTimeoutMs: this.config.connect_timeout_ms,
          responseTimeoutMs: this.config.generation_timeout_ms,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        stopHeartbeat();
        const ambiguous =
          options.signal?.aborted === true ||
          (error instanceof UpstreamError &&
            (error.stable.code === "UPSTREAM_TIMEOUT" ||
              error.stable.code === "BACKEND_UNAVAILABLE"));
        await this.statusService.coordinator.release(acquired.lease.lease_id, ambiguous);
        if (ambiguous) availabilityOverride = "cooldown";
        throw error;
      }
      stopHeartbeat();
      await this.statusService.coordinator.release(acquired.lease.lease_id, false);
      const result = DelegateResultSchema.parse({
        ok: true,
        request_id: requestId,
        backend: selection.backendStatus.backend,
        endpoint: selection.backendStatus.endpoint,
        model: selection.model,
        requested_quality: input.quality,
        actual_quality: selection.quality,
        availability: "ready",
        answer,
        context_manifest: manifest,
        elapsed_seconds: elapsedSeconds(start),
        queue_seconds: queueSeconds,
        input_characters: inputCharacters,
        truncated: context.truncated,
        warnings,
        error: null,
      });
      this.logResult(result, command, start);
      return result;
    } catch (error) {
      if (error instanceof DomainError || error instanceof UpstreamError) {
        const queued =
          error.stable.details.queue_timeout_seconds ?? error.stable.details.queue_seconds;
        if (typeof queued === "number") queueSeconds = Math.max(0, queued);
        return failure(error.stable);
      }
      return failure(asInternalError(selection?.backendStatus.backend ?? null));
    }
  }

  private logResult(result: DelegateResult, command: string, start: number): void {
    this.logger.log({
      level: result.ok ? "info" : "warn",
      event: "request_complete",
      requestId: result.request_id,
      command,
      backend: result.backend,
      model: result.model?.id ?? null,
      durationMs: performance.now() - start,
      inputCharacters: result.input_characters,
      outputCharacters: result.answer?.length ?? 0,
      queueMs: result.queue_seconds * 1_000,
      outcome: result.ok ? "success" : "failure",
      errorCode: result.error?.code ?? null,
    });
  }
}
