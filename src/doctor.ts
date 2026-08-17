import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  DoctorResultSchema,
  type BackendSelection,
  type DoctorCheck,
  type DoctorResult,
} from "./contracts.js";
import { stableError } from "./errors.js";
import { StatusService } from "./service.js";

const PACKAGE_VERSION = "0.1.0";
const EXPECTED_NODE_VERSION = "24.19.0";

export type DoctorOptions = {
  backend?: BackendSelection;
  requestId?: string;
  entrypointPath?: string;
};

async function entrypointCheck(path: string): Promise<DoctorCheck> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a file");
    await access(path, constants.R_OK);
    return {
      name: "compiled_entrypoint",
      status: "pass",
      message: "The compiled CLI entrypoint is present and readable.",
      error: null,
    };
  } catch {
    return {
      name: "compiled_entrypoint",
      status: "fail",
      message: "The compiled CLI entrypoint is missing or unreadable; run pnpm build.",
      error: stableError("INVALID_REQUEST", "The compiled CLI entrypoint is unavailable.", {
        retryable: false,
      }),
    };
  }
}

async function workspaceCheck(workspaceRoot: string | null): Promise<DoctorCheck> {
  if (workspaceRoot === null) {
    return {
      name: "workspace",
      status: "skip",
      message: "No workspace root is configured; issue 11 status checks do not require one.",
      error: null,
    };
  }
  try {
    const canonical = await realpath(workspaceRoot);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    await access(canonical, constants.R_OK);
    return {
      name: "workspace",
      status: "pass",
      message: "The workspace resolves canonically to a readable directory.",
      error: null,
    };
  } catch {
    return {
      name: "workspace",
      status: "fail",
      message: "The configured workspace does not resolve to a readable directory.",
      error: stableError("INVALID_WORKSPACE", undefined, { retryable: false }),
    };
  }
}

export async function runDoctor(
  service: StatusService,
  options: DoctorOptions = {},
): Promise<DoctorResult> {
  const requestId = options.requestId ?? randomUUID();
  const requestedBackend = options.backend ?? "auto";
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const entrypoint = options.entrypointPath ?? join(moduleDirectory, "cli.js");
  const checks: DoctorCheck[] = [];

  const exactRuntime = process.versions.node === EXPECTED_NODE_VERSION;
  checks.push({
    name: "runtime_package",
    status: exactRuntime ? "pass" : "warn",
    message: exactRuntime
      ? `Node ${EXPECTED_NODE_VERSION} and local-mlx-delegate ${PACKAGE_VERSION} are compatible.`
      : `Node 24 is required; mise pins ${EXPECTED_NODE_VERSION}. Package version is ${PACKAGE_VERSION}.`,
    error: null,
  });
  checks.push({
    name: "configuration",
    status: "pass",
    message: "The versioned configuration is valid.",
    error: null,
  });
  checks.push(await entrypointCheck(entrypoint));
  checks.push(await workspaceCheck(service.config.workspace_root));

  const availability = await service.coordinator.inspect();
  if (!availability.healthy) {
    checks.push({
      name: "availability_registry",
      status: "fail",
      message: "Shared lease state could not be reconciled safely.",
      error: availability.error,
    });
  } else if (availability.leases.length > 0 || availability.queue.length > 0) {
    checks.push({
      name: "availability_registry",
      status: "warn",
      message: `Shared state contains ${String(availability.leases.length)} active/cooldown lease(s) and ${String(availability.queue.length)} queued request(s).`,
      error: null,
    });
  } else {
    checks.push({
      name: "availability_registry",
      status: "pass",
      message: `Shared lease state is healthy with no active leases or queued requests; ${String(availability.rate_limit_count)}/${String(availability.rate_limit_maximum)} generation starts are in the current rate window.`,
      error: null,
    });
  }

  const status = await service.status({
    backend: requestedBackend,
    requestId,
    command: "doctor",
  });
  for (const backend of status.configured_backends) {
    if (!backend.enabled) {
      checks.push({
        name: `backend_${backend.backend}`,
        status: "skip",
        message: "Backend probing is disabled by configuration.",
        error: null,
      });
      continue;
    }
    if (backend.availability === "ready") {
      checks.push({
        name: `backend_${backend.backend}`,
        status: "pass",
        message: "Backend health and model-list checks passed.",
        error: null,
      });
      continue;
    }
    const required = requestedBackend === backend.backend || !status.ok;
    checks.push({
      name: `backend_${backend.backend}`,
      status: required ? "fail" : "warn",
      message: backend.error?.message ?? "Backend checks did not pass.",
      error: backend.error,
    });
  }

  return DoctorResultSchema.parse({
    request_id: requestId,
    ok: status.ok && !checks.some((check) => check.status === "fail"),
    checks,
    status,
  });
}
