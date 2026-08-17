import type { BackendName, StableErrorCode } from "./contracts.js";

export const LogLevelValues = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LogLevelValues)[number];

export type LogEvent = {
  level: LogLevel;
  event: string;
  requestId?: string | null;
  command?: string | null;
  backend?: BackendName | null;
  model?: string | null;
  durationMs?: number | null;
  inputCharacters?: number | null;
  outputCharacters?: number | null;
  promptTokensEstimate?: number | null;
  promptTokensActual?: number | null;
  completionTokensActual?: number | null;
  contextUtilizationPercent?: number | null;
  queueMs?: number | null;
  outcome?: string | null;
  errorCode?: StableErrorCode | null;
};

export type LogWriter = (line: string) => void;

const priorities: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function safeToken(value: string, maximum = 128): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, maximum);
}

export class Logger {
  constructor(
    private readonly minimumLevel: LogLevel,
    private readonly writer: LogWriter = (line) => process.stderr.write(`${line}\n`),
  ) {}

  log(event: LogEvent): void {
    if (priorities[event.level] < priorities[this.minimumLevel]) return;

    const record = {
      timestamp: new Date().toISOString(),
      level: event.level,
      event: safeToken(event.event),
      request_id: event.requestId ?? null,
      command: event.command ? safeToken(event.command) : null,
      backend: event.backend ?? null,
      model: event.model ? safeToken(event.model, 1024) : null,
      duration_ms:
        event.durationMs === undefined || event.durationMs === null
          ? null
          : Math.max(0, Math.round(event.durationMs)),
      input_characters:
        event.inputCharacters === undefined || event.inputCharacters === null
          ? null
          : Math.max(0, Math.round(event.inputCharacters)),
      output_characters:
        event.outputCharacters === undefined || event.outputCharacters === null
          ? null
          : Math.max(0, Math.round(event.outputCharacters)),
      prompt_tokens_estimate:
        event.promptTokensEstimate === undefined || event.promptTokensEstimate === null
          ? null
          : Math.max(0, Math.round(event.promptTokensEstimate)),
      prompt_tokens_actual:
        event.promptTokensActual === undefined || event.promptTokensActual === null
          ? null
          : Math.max(0, Math.round(event.promptTokensActual)),
      completion_tokens_actual:
        event.completionTokensActual === undefined || event.completionTokensActual === null
          ? null
          : Math.max(0, Math.round(event.completionTokensActual)),
      context_utilization_percent:
        event.contextUtilizationPercent === undefined || event.contextUtilizationPercent === null
          ? null
          : Math.max(0, Math.min(100, Math.round(event.contextUtilizationPercent))),
      queue_ms:
        event.queueMs === undefined || event.queueMs === null
          ? null
          : Math.max(0, Math.round(event.queueMs)),
      outcome: event.outcome ? safeToken(event.outcome) : null,
      error_code: event.errorCode ?? null,
    };
    this.writer(JSON.stringify(record));
  }
}
