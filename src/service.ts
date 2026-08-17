import { randomUUID } from "node:crypto";
import type { BackendProbe } from "./backends/types.js";
import { OpenAiCompatibleProbe } from "./backends/openai-compatible.js";
import { BACKEND_ORDER, classifyModel, type DelegateConfig } from "./config.js";
import { AvailabilityCoordinator } from "./coordinator.js";
import {
  StatusResultSchema,
  type BackendName,
  type BackendSelection,
  type ConfiguredBackendStatus,
  type StatusResult,
} from "./contracts.js";
import { asInternalError, stableError } from "./errors.js";
import { Logger } from "./logging.js";

export type StatusOptions = {
  backend?: BackendSelection;
  requestId?: string;
  command?: string;
  logCompletion?: boolean;
};

function disabledStatus(config: DelegateConfig, backend: BackendName): ConfiguredBackendStatus {
  const definition = config.backends[backend];
  return {
    backend,
    enabled: false,
    health: false,
    availability: "offline",
    models: [],
    loaded_models: [],
    endpoint: definition.url,
    latency_ms: null,
    resource_groups: [...definition.resource_groups],
    resource_states: [],
    queue_depth: 0,
    lease_age_seconds: null,
    cooldown_remaining_seconds: null,
    warnings: ["Backend probing is disabled by configuration."],
    startup_hint: definition.startup_hint,
    error: stableError("BACKEND_UNAVAILABLE", "The backend is disabled by configuration.", {
      backend,
      startupHint: definition.startup_hint,
      retryable: false,
    }),
  };
}

export class StatusService {
  readonly logger: Logger;

  constructor(
    readonly config: DelegateConfig,
    private readonly probe: BackendProbe = new OpenAiCompatibleProbe(),
    logger?: Logger,
    readonly coordinator: AvailabilityCoordinator = new AvailabilityCoordinator(
      config.coordination,
    ),
  ) {
    this.logger = logger ?? new Logger(config.log_level);
  }

  async status(options: StatusOptions = {}): Promise<StatusResult> {
    const requestId = options.requestId ?? randomUUID();
    const requestedBackend = options.backend ?? "auto";
    const command = options.command ?? "status";
    const start = performance.now();

    const probes = BACKEND_ORDER.map(async (backend): Promise<ConfiguredBackendStatus> => {
      const definition = this.config.backends[backend];
      if (!definition.enabled) return disabledStatus(this.config, backend);
      try {
        return await this.probe.probe({
          backend,
          definition,
          connectTimeoutMs: this.config.connect_timeout_ms,
          responseTimeoutMs: this.config.health_timeout_ms,
        });
      } catch {
        return {
          backend,
          enabled: true,
          health: false,
          availability: "offline",
          models: [],
          loaded_models: [],
          endpoint: definition.url,
          latency_ms: null,
          resource_groups: [...definition.resource_groups],
          resource_states: [],
          queue_depth: 0,
          lease_age_seconds: null,
          cooldown_remaining_seconds: null,
          warnings: [],
          startup_hint: definition.startup_hint,
          error: asInternalError(backend),
        };
      }
    });
    const probedBackends = await Promise.all(probes);
    const inspection = await this.coordinator.inspect();
    const configuredBackends = probedBackends.map((backend): ConfiguredBackendStatus => {
      const resourceStates = this.coordinator.resourceStates(inspection, backend.resource_groups);
      const queueDepth = Math.max(0, ...resourceStates.map((resource) => resource.queue_depth));
      const active = resourceStates.find((resource) => resource.availability === "busy");
      const cooldown = resourceStates.find((resource) => resource.availability === "cooldown");
      const degraded = resourceStates.find((resource) => resource.availability === "degraded");
      const queued = resourceStates.find((resource) => resource.availability === "queued");
      if (!backend.health || backend.loaded_models.length === 0) {
        return {
          ...backend,
          resource_states: resourceStates,
          queue_depth: queueDepth,
          lease_age_seconds: active?.lease_age_seconds ?? null,
          cooldown_remaining_seconds: cooldown?.cooldown_remaining_seconds ?? null,
        };
      }
      if (degraded !== undefined) {
        return {
          ...backend,
          availability: "degraded",
          resource_states: resourceStates,
          queue_depth: queueDepth,
          lease_age_seconds: null,
          cooldown_remaining_seconds: null,
          error: inspection.error ?? asInternalError(backend.backend),
        };
      }
      if (cooldown !== undefined) {
        return {
          ...backend,
          availability: "cooldown",
          resource_states: resourceStates,
          queue_depth: queueDepth,
          lease_age_seconds: cooldown.lease_age_seconds,
          cooldown_remaining_seconds: cooldown.cooldown_remaining_seconds,
          error: stableError("BACKEND_COOLDOWN", undefined, {
            backend: backend.backend,
            details: {
              lease_id: cooldown.lease_id,
              active_backend: cooldown.backend,
              active_model: cooldown.model,
              cooldown_remaining_seconds: cooldown.cooldown_remaining_seconds,
              retry_after_seconds: Math.max(1, Math.ceil(cooldown.cooldown_remaining_seconds ?? 0)),
            },
          }),
        };
      }
      if (active !== undefined) {
        return {
          ...backend,
          availability: "busy",
          resource_states: resourceStates,
          queue_depth: queueDepth,
          lease_age_seconds: active.lease_age_seconds,
          cooldown_remaining_seconds: null,
          error: stableError("BACKEND_BUSY", undefined, {
            backend: backend.backend,
            details: {
              lease_id: active.lease_id,
              active_backend: active.backend,
              active_model: active.model,
              busy_seconds: active.lease_age_seconds,
              queue_depth: queueDepth,
              retry_after_seconds: 1,
            },
          }),
        };
      }
      if (queued !== undefined) {
        return {
          ...backend,
          availability: "queued",
          resource_states: resourceStates,
          queue_depth: queueDepth,
          lease_age_seconds: null,
          cooldown_remaining_seconds: null,
          error: stableError("BACKEND_BUSY", "Backend capacity has bounded wait tickets.", {
            backend: backend.backend,
            details: { queue_depth: queueDepth, retry_after_seconds: 1 },
          }),
        };
      }
      return {
        ...backend,
        availability: "ready",
        resource_states: resourceStates,
        queue_depth: queueDepth,
        lease_age_seconds: null,
        cooldown_remaining_seconds: null,
        error: null,
      };
    });
    const healthyBackends = configuredBackends
      .filter((backend) => backend.health && backend.loaded_models.length > 0)
      .map((backend) => backend.backend);

    const selected =
      requestedBackend === "auto"
        ? (configuredBackends.find((backend) => backend.availability === "ready") ??
          configuredBackends.find((backend) => backend.health && backend.loaded_models.length > 0))
        : configuredBackends.find((backend) => backend.backend === requestedBackend);
    const ready = selected?.availability === "ready";
    const fallback = configuredBackends.find((backend) => backend.enabled) ?? configuredBackends[0];
    const relevant = selected ?? fallback;
    const model =
      selected?.health === true && selected.loaded_models.length === 1
        ? (selected.loaded_models.at(0) ?? null)
        : null;
    const topError = ready
      ? null
      : (relevant?.error ??
        stableError("BACKEND_UNAVAILABLE", undefined, {
          backend: requestedBackend === "auto" ? null : requestedBackend,
          startupHint: relevant?.startup_hint ?? null,
        }));

    const value: StatusResult = {
      ok: ready,
      request_id: requestId,
      configured_backends: configuredBackends,
      healthy_backends: healthyBackends,
      selected_backend: selected?.backend ?? null,
      endpoint: selected?.endpoint ?? null,
      model,
      quality_class:
        model === null || selected === undefined
          ? "unknown"
          : classifyModel(this.config.backends[selected.backend], model.id),
      availability: selected?.availability ?? "offline",
      resource_groups: selected ? [...selected.resource_groups] : [],
      resource_states: selected ? [...selected.resource_states] : [],
      queue_depth: selected?.queue_depth ?? 0,
      lease_age_seconds: selected?.lease_age_seconds ?? null,
      cooldown_remaining_seconds: selected?.cooldown_remaining_seconds ?? null,
      startup_hint: ready || relevant?.health === true ? null : (relevant?.startup_hint ?? null),
      warnings:
        ready && selected.loaded_models.length > 1
          ? ["Multiple models are loaded; top-level model selection is intentionally ambiguous."]
          : [],
      error: topError,
    };
    const parsed = StatusResultSchema.parse(value);
    if (options.logCompletion !== false) {
      this.logger.log({
        level: parsed.ok ? "info" : "warn",
        event: "request_complete",
        requestId,
        command,
        backend: parsed.selected_backend,
        model: parsed.model?.id ?? null,
        durationMs: performance.now() - start,
        outcome: parsed.ok ? "ready" : "unavailable",
        errorCode: parsed.error?.code ?? null,
      });
    }
    return parsed;
  }
}
