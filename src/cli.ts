#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigurationError } from "./config.js";
import {
  BackendNameSchema,
  BackendSelectionSchema,
  DelegateInputSchema,
  LeaseCommandResultSchema,
  RequestedQualitySchema,
  type BackendSelection,
  type DelegateResult,
  type DoctorResult,
  type LeaseCommandResult,
  type RequestedQuality,
  type StatusResult,
} from "./contracts.js";
import { DelegationService } from "./delegation.js";
import { runDoctor } from "./doctor.js";
import { DomainError, stableError } from "./errors.js";
import {
  configureHost,
  HostConfigurationError,
  HostNameSchema,
  type HostConfigurationResult,
  type HostName,
} from "./host-config.js";
import { Logger } from "./logging.js";
import { createMcpServer } from "./mcp/server.js";
import { StatusService } from "./service.js";

const VERSION = "0.1.0";

const HELP = `local-mlx-delegate ${VERSION}

Read-only diagnostics and bounded consultation for local MLX/OpenAI-compatible backends.

Usage:
  local-mlx-delegate serve --workspace-root PATH [--config PATH]
  local-mlx-delegate status [--backend NAME] [--config PATH] [--json]
  local-mlx-delegate doctor [--backend NAME] [--workspace-root PATH] [--config PATH] [--json]
  local-mlx-delegate configure codex|claude|copilot-cli|vscode --workspace-root PATH [--apply] [--json]
  local-mlx-delegate leases [--config PATH] [--json]
  local-mlx-delegate leases clear --lease-id UUID --confirm [--config PATH] [--json]
  local-mlx-delegate delegate --task TEXT --cwd PATH [--path PATH ...] [--include-diff]
      [--quality auto|fast|deep] [--backend NAME] [--workspace-root PATH]
      [--busy-behavior fail|wait] [--max-wait-seconds N]
      [--max-input-chars N] [--max-output-tokens N] [--config PATH] [--json]
  local-mlx-delegate --help
  local-mlx-delegate --version

Backends: auto, controller, worker, cluster
`;

type Command = "serve" | "status" | "doctor" | "delegate" | "leases" | "configure";
export type ParsedArguments = {
  command: Command | "help" | "version";
  backend: BackendSelection;
  configPath?: string;
  workspaceRoot?: string;
  json: boolean;
  task?: string;
  cwd?: string;
  paths: string[];
  includeDiff: boolean;
  quality: RequestedQuality;
  busyBehavior: "fail" | "wait";
  maxWaitSeconds: number;
  maxInputChars: number;
  maxOutputTokens: number;
  leaseAction: "inspect" | "clear";
  leaseId?: string;
  confirm: boolean;
  host?: HostName;
  apply: boolean;
};

class UsageError extends Error {
  override name = "UsageError";
}

function baseArguments(command: ParsedArguments["command"]): ParsedArguments {
  return {
    command,
    backend: "auto",
    json: false,
    paths: [],
    includeDiff: false,
    quality: "auto",
    busyBehavior: "fail",
    maxWaitSeconds: 0,
    maxInputChars: 120_000,
    maxOutputTokens: 4_096,
    leaseAction: "inspect",
    confirm: false,
    apply: false,
  };
}

function takeValue(arguments_: string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value.`);
  }
  return value;
}

function integerValue(arguments_: string[], index: number, flag: string): number {
  const value = takeValue(arguments_, index, flag);
  if (!/^\d+$/.test(value)) throw new UsageError(`${flag} requires a non-negative integer.`);
  return Number(value);
}

export function parseArguments(arguments_: string[]): ParsedArguments {
  if (arguments_.length === 0 || arguments_[0] === "--help") return baseArguments("help");
  if (arguments_[0] === "--version") return baseArguments("version");
  const command = arguments_[0];
  if (
    command !== "serve" &&
    command !== "status" &&
    command !== "doctor" &&
    command !== "delegate" &&
    command !== "leases" &&
    command !== "configure"
  ) {
    throw new UsageError(
      "Expected serve, status, doctor, delegate, leases, configure, --help, or --version.",
    );
  }

  const result = baseArguments(command);
  let firstOption = 1;
  if (command === "leases" && arguments_[1] === "clear") {
    result.leaseAction = "clear";
    firstOption = 2;
  }
  if (command === "configure") {
    const host = HostNameSchema.safeParse(arguments_[1]);
    if (!host.success) {
      throw new UsageError("configure requires codex, claude, copilot-cli, or vscode.");
    }
    result.host = host.data;
    firstOption = 2;
  }
  const seen = new Set<string>();
  for (let index = firstOption; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    if (flag === undefined) break;
    if (flag === "--help") return baseArguments("help");
    if (flag !== "--path" && seen.has(flag)) {
      throw new UsageError(`${flag} may only be provided once.`);
    }
    seen.add(flag);
    switch (flag) {
      case "--backend": {
        if (command === "serve" || command === "leases" || command === "configure")
          throw new UsageError("--backend is not valid for this command.");
        const parsed = BackendSelectionSchema.safeParse(takeValue(arguments_, index, flag));
        if (!parsed.success)
          throw new UsageError("--backend must name a supported backend or auto.");
        result.backend = parsed.data;
        index += 1;
        break;
      }
      case "--config":
        if (command === "configure") throw new UsageError("--config is not valid for configure.");
        result.configPath = takeValue(arguments_, index, flag);
        index += 1;
        break;
      case "--workspace-root":
        if (command === "status" || command === "leases")
          throw new UsageError("--workspace-root is not valid for this command.");
        result.workspaceRoot = takeValue(arguments_, index, flag);
        index += 1;
        break;
      case "--apply":
        if (command !== "configure") throw new UsageError("--apply is only valid for configure.");
        result.apply = true;
        break;
      case "--json":
        if (command === "serve") throw new UsageError("--json is not valid for serve.");
        result.json = true;
        break;
      case "--task":
        if (command !== "delegate") throw new UsageError("--task is only valid for delegate.");
        result.task = takeValue(arguments_, index, flag);
        index += 1;
        break;
      case "--cwd":
        if (command !== "delegate") throw new UsageError("--cwd is only valid for delegate.");
        result.cwd = takeValue(arguments_, index, flag);
        index += 1;
        break;
      case "--path":
        if (command !== "delegate") throw new UsageError("--path is only valid for delegate.");
        result.paths.push(takeValue(arguments_, index, flag));
        index += 1;
        break;
      case "--include-diff":
        if (command !== "delegate")
          throw new UsageError("--include-diff is only valid for delegate.");
        result.includeDiff = true;
        break;
      case "--quality": {
        if (command !== "delegate") throw new UsageError("--quality is only valid for delegate.");
        const parsed = RequestedQualitySchema.safeParse(takeValue(arguments_, index, flag));
        if (!parsed.success) throw new UsageError("--quality must be auto, fast, or deep.");
        result.quality = parsed.data;
        index += 1;
        break;
      }
      case "--busy-behavior": {
        if (command !== "delegate")
          throw new UsageError("--busy-behavior is only valid for delegate.");
        const value = takeValue(arguments_, index, flag);
        if (value !== "fail" && value !== "wait") {
          throw new UsageError("--busy-behavior must be fail or wait.");
        }
        result.busyBehavior = value;
        index += 1;
        break;
      }
      case "--max-wait-seconds":
        if (command !== "delegate")
          throw new UsageError("--max-wait-seconds is only valid for delegate.");
        result.maxWaitSeconds = integerValue(arguments_, index, flag);
        index += 1;
        break;
      case "--max-input-chars":
        if (command !== "delegate")
          throw new UsageError("--max-input-chars is only valid for delegate.");
        result.maxInputChars = integerValue(arguments_, index, flag);
        index += 1;
        break;
      case "--max-output-tokens":
        if (command !== "delegate")
          throw new UsageError("--max-output-tokens is only valid for delegate.");
        result.maxOutputTokens = integerValue(arguments_, index, flag);
        index += 1;
        break;
      case "--lease-id":
        if (command !== "leases" || result.leaseAction !== "clear") {
          throw new UsageError("--lease-id is only valid for leases clear.");
        }
        result.leaseId = takeValue(arguments_, index, flag);
        index += 1;
        break;
      case "--confirm":
        if (command !== "leases" || result.leaseAction !== "clear") {
          throw new UsageError("--confirm is only valid for leases clear.");
        }
        result.confirm = true;
        break;
      default:
        throw new UsageError(`Unknown option: ${flag}.`);
    }
  }
  if (command === "delegate" && (result.task === undefined || result.cwd === undefined)) {
    throw new UsageError("delegate requires --task and --cwd.");
  }
  if (
    command === "leases" &&
    result.leaseAction === "clear" &&
    (result.leaseId === undefined || !result.confirm)
  ) {
    throw new UsageError("leases clear requires --lease-id and --confirm.");
  }
  if (command === "configure" && result.workspaceRoot === undefined) {
    throw new UsageError("configure requires --workspace-root.");
  }
  return result;
}

function printStatus(status: StatusResult): void {
  process.stdout.write(`Request: ${status.request_id}\n`);
  for (const backend of status.configured_backends) {
    const models = backend.models.length
      ? backend.models.map((model) => model.id).join(", ")
      : "none";
    process.stdout.write(
      `${backend.backend}: ${backend.enabled ? backend.availability : "disabled"} (${backend.endpoint}); models: ${models}; queue: ${String(backend.queue_depth)}${backend.lease_age_seconds === null ? "" : `; lease age: ${String(backend.lease_age_seconds)}s`}${backend.cooldown_remaining_seconds === null ? "" : `; cooldown: ${String(backend.cooldown_remaining_seconds)}s`}\n`,
    );
    if (backend.error) {
      process.stdout.write(
        `  ${backend.error.message}${backend.error.startup_hint ? ` ${backend.error.startup_hint}` : ""}\n`,
      );
    }
  }
  process.stdout.write(
    status.ok
      ? `Selected: ${status.selected_backend ?? "none"}${status.model ? ` / ${status.model.id}` : ""}\n`
      : `Selected: ${status.selected_backend ?? "none"} (${status.availability})\n${status.error?.message ?? "No backend is ready."}\n`,
  );
}

function printDoctor(result: DoctorResult): void {
  process.stdout.write(`Request: ${result.request_id}\n`);
  for (const check of result.checks) {
    process.stdout.write(
      `${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.message}\n`,
    );
  }
  process.stdout.write(result.ok ? "Doctor checks passed.\n" : "Doctor checks failed.\n");
}

function printDelegate(result: DelegateResult): void {
  process.stdout.write(`Request: ${result.request_id}\n`);
  if (result.ok) {
    process.stdout.write(
      `Backend: ${result.backend ?? "unknown"}; model: ${result.model?.id ?? "unknown"}; quality: ${result.actual_quality}\n`,
    );
    process.stdout.write(`${result.answer ?? ""}\n`);
  } else {
    process.stdout.write(`Delegation failed: ${result.error?.message ?? "Unknown error."}\n`);
    if (result.error?.startup_hint) process.stdout.write(`${result.error.startup_hint}\n`);
  }
}

function printLeases(result: LeaseCommandResult): void {
  process.stdout.write(`Request: ${result.request_id}\n`);
  process.stdout.write(
    `Registry: ${result.state.healthy ? "healthy" : "degraded"}; active/cooldown leases: ${String(result.state.leases.length)}; queued: ${String(result.state.queue.length)}\n`,
  );
  for (const lease of result.state.leases) {
    process.stdout.write(
      `${lease.lease_id} ${lease.state} ${lease.backend}/${lease.model} [${lease.resource_groups.join(", ")}] expires ${lease.expires_at}\n`,
    );
  }
  if (result.action === "clear") {
    process.stdout.write(
      result.ok
        ? `Cleared cooldown lease ${result.cleared_lease_id ?? "unknown"}.\n`
        : `Lease was not cleared: ${result.error?.message ?? "unknown failure"}\n`,
    );
  }
}

function printHostConfiguration(result: HostConfigurationResult): void {
  process.stdout.write(
    `${result.applied ? (result.changed ? "Updated" : "Already configured") : "Proposed"} ${result.host} configuration: ${result.target_path}\n`,
  );
  if (result.backup_path !== null) process.stdout.write(`Backup: ${result.backup_path}\n`);
  if (!result.applied) {
    process.stdout.write("\n");
    process.stdout.write(result.content);
    process.stdout.write("\nReview the proposal, then rerun with --apply to write it.\n");
  }
}

function emitUnexpected(command: string | null): void {
  new Logger("info").log({
    level: "error",
    event: "unexpected_error",
    command,
    outcome: "internal_error",
    errorCode: "INTERNAL_ERROR",
  });
}

async function serve(service: StatusService, delegation: DelegationService): Promise<number> {
  service.logger.log({ level: "info", event: "process_start", command: "serve", outcome: "ready" });
  const handle = serveStdio(() => createMcpServer(service, delegation), {
    onerror: () => emitUnexpected("serve"),
  });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    service.logger.log({
      level: "info",
      event: "process_shutdown",
      command: "serve",
      outcome: "closed",
    });
    await handle.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  return await new Promise<number>((resolve) => {
    process.stdin.once("end", () => void close().finally(() => resolve(0)));
  });
}

export async function runCli(arguments_: string[]): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(arguments_);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n`);
    process.stderr.write("Run local-mlx-delegate --help for usage.\n");
    return 2;
  }
  if (parsed.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (parsed.command === "configure") {
    try {
      const result = await configureHost({
        host: HostNameSchema.parse(parsed.host),
        workspaceRoot: parsed.workspaceRoot ?? "",
        apply: parsed.apply,
      });
      if (parsed.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else printHostConfiguration(result);
      new Logger("info").log({
        level: "info",
        event: "request_complete",
        requestId: result.request_id,
        command: `configure_${result.host}`,
        outcome: result.changed ? (result.applied ? "updated" : "proposed") : "unchanged",
      });
      return 0;
    } catch (error) {
      if (error instanceof HostConfigurationError) {
        process.stderr.write(`${error.message}\n`);
        return 2;
      }
      emitUnexpected("configure");
      return 70;
    }
  }

  try {
    const delegateWorkspace =
      parsed.command === "delegate" && parsed.workspaceRoot === undefined ? parsed.cwd : undefined;
    const workspaceOverride = parsed.workspaceRoot ?? delegateWorkspace;
    const config = await loadConfig({
      ...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
      ...(workspaceOverride === undefined ? {} : { workspaceRoot: workspaceOverride }),
    });
    const service = new StatusService(config);
    if (parsed.command === "serve") {
      if (config.workspace_root === null) {
        process.stderr.write("serve requires --workspace-root or a configured workspace root.\n");
        return 2;
      }
      const delegation = await DelegationService.create({ config, statusService: service });
      return await serve(service, delegation);
    }

    service.logger.log({
      level: "info",
      event: "process_start",
      command: parsed.command,
      backend: parsed.backend === "auto" ? null : BackendNameSchema.parse(parsed.backend),
      outcome: "running",
    });
    if (parsed.command === "status") {
      const status = await service.status({ backend: parsed.backend, command: "status" });
      if (parsed.json) process.stdout.write(`${JSON.stringify(status)}\n`);
      else printStatus(status);
      service.logger.log({
        level: "info",
        event: "process_shutdown",
        command: "status",
        outcome: status.ok ? "success" : "diagnostic_failure",
      });
      return status.ok ? 0 : 1;
    }
    if (parsed.command === "doctor") {
      const doctor = await runDoctor(service, { backend: parsed.backend });
      if (parsed.json) process.stdout.write(`${JSON.stringify(doctor)}\n`);
      else printDoctor(doctor);
      service.logger.log({
        level: "info",
        event: "process_shutdown",
        command: "doctor",
        outcome: doctor.ok ? "success" : "diagnostic_failure",
      });
      return doctor.ok ? 0 : 1;
    }
    if (parsed.command === "leases") {
      const requestId = randomUUID();
      let inspection = await service.coordinator.inspect();
      let error = inspection.error;
      let clearedLeaseId: string | null = null;
      if (parsed.leaseAction === "clear" && error === null) {
        const lease = inspection.leases.find((item) => item.lease_id === parsed.leaseId);
        if (lease?.state !== "cooldown") {
          error = stableError(
            "INVALID_REQUEST",
            "Only an existing cooldown lease may be administratively cleared.",
            { retryable: false },
          );
        } else {
          const health = await service.status({
            backend: lease.backend,
            requestId,
            command: "leases_clear_health",
            logCompletion: false,
          });
          const backendHealth = health.configured_backends.find(
            (backend) => backend.backend === lease.backend,
          );
          if (backendHealth?.health !== true || backendHealth.models.length === 0) {
            error = stableError(
              "BACKEND_UNAVAILABLE",
              "The lease was not cleared because its backend health check did not pass.",
              { backend: lease.backend, startupHint: backendHealth?.startup_hint ?? null },
            );
          } else if (await service.coordinator.clearCooldown(lease.lease_id)) {
            clearedLeaseId = lease.lease_id;
            inspection = await service.coordinator.inspect();
          } else {
            error = stableError(
              "INVALID_REQUEST",
              "The cooldown lease changed before it could be cleared.",
              { retryable: false },
            );
          }
        }
      }
      const result = LeaseCommandResultSchema.parse({
        request_id: requestId,
        ok: error === null && (parsed.leaseAction === "inspect" || clearedLeaseId !== null),
        action: parsed.leaseAction,
        cleared_lease_id: clearedLeaseId,
        state: inspection,
        error,
      });
      if (parsed.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else printLeases(result);
      service.logger.log({
        level: result.ok ? "info" : "warn",
        event: "process_shutdown",
        command: parsed.leaseAction === "clear" ? "leases_clear" : "leases_inspect",
        outcome: result.ok ? "success" : "diagnostic_failure",
        errorCode: result.error?.code ?? null,
      });
      return result.ok ? 0 : 1;
    }

    const input = DelegateInputSchema.safeParse({
      task: parsed.task,
      cwd: parsed.cwd,
      paths: parsed.paths,
      include_diff: parsed.includeDiff,
      quality: parsed.quality,
      backend: parsed.backend,
      busy_behavior: parsed.busyBehavior,
      max_wait_seconds: parsed.maxWaitSeconds,
      max_input_chars: parsed.maxInputChars,
      max_output_tokens: parsed.maxOutputTokens,
    });
    if (!input.success) {
      process.stderr.write("Invalid delegate arguments.\n");
      return 2;
    }
    const delegation = await DelegationService.create({ config, statusService: service });
    const result = await delegation.delegate(input.data, { command: "delegate" });
    if (parsed.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else printDelegate(result);
    service.logger.log({
      level: "info",
      event: "process_shutdown",
      command: "delegate",
      outcome: result.ok ? "success" : "diagnostic_failure",
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof DomainError) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    emitUnexpected(parsed.command);
    return 70;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = await runCli(process.argv.slice(2));
}
