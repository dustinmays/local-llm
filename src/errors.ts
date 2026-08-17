import type { BackendName, StableError, StableErrorCode } from "./contracts.js";

export type ErrorOptions = {
  retryable?: boolean;
  backend?: BackendName | null;
  startupHint?: string | null;
  details?: StableError["details"];
};

const defaultMessages: Record<StableErrorCode, string> = {
  INVALID_REQUEST: "The request is invalid.",
  INVALID_WORKSPACE: "The workspace is invalid or inaccessible.",
  PATH_OUTSIDE_WORKSPACE: "A requested path is outside the configured workspace.",
  SENSITIVE_PATH: "A requested path is not safe to read.",
  INPUT_LIMIT_EXCEEDED: "The request exceeds a configured input limit.",
  BACKEND_UNAVAILABLE: "The backend is unavailable.",
  MODEL_NOT_LOADED: "The backend is running but no model is loaded.",
  QUALITY_MISMATCH: "The available model does not match the requested quality.",
  BACKEND_BUSY: "The backend is busy.",
  BACKEND_COOLDOWN: "The backend is in cooldown.",
  RATE_LIMITED: "The request was rate limited.",
  UPSTREAM_TIMEOUT: "The backend did not respond before the deadline.",
  UPSTREAM_PROTOCOL_ERROR: "The backend returned an invalid response.",
  INTERNAL_ERROR: "An unexpected internal error occurred.",
};

const retryableCodes = new Set<StableErrorCode>([
  "BACKEND_UNAVAILABLE",
  "MODEL_NOT_LOADED",
  "BACKEND_BUSY",
  "BACKEND_COOLDOWN",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
]);

export function stableError(
  code: StableErrorCode,
  message = defaultMessages[code],
  options: ErrorOptions = {},
): StableError {
  return {
    code,
    message,
    retryable: options.retryable ?? retryableCodes.has(code),
    backend: options.backend ?? null,
    startup_hint: options.startupHint ?? null,
    details: options.details ?? {},
  };
}

export class UpstreamError extends Error {
  readonly stable: StableError;

  constructor(stable: StableError) {
    super(stable.message);
    this.name = "UpstreamError";
    this.stable = stable;
  }
}

export class DomainError extends Error {
  readonly stable: StableError;

  constructor(stable: StableError) {
    super(stable.message);
    this.name = "DomainError";
    this.stable = stable;
  }
}

export function asInternalError(backend: BackendName | null = null): StableError {
  return stableError("INTERNAL_ERROR", undefined, { backend, retryable: false });
}
