import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { CoordinationConfig } from "./config.js";
import {
  LeaseInspectionSchema,
  LeaseRecordSchema,
  WaitTicketSchema,
  type Availability,
  type BackendName,
  type LeaseInspection,
  type LeaseRecord,
  type ResourceAvailability,
  type StableError,
  type WaitTicket,
} from "./contracts.js";
import { DomainError, stableError } from "./errors.js";

const STATE_SCHEMA_VERSION = 1 as const;
const STATE_FILE_NAME = "availability-v1.json";
const MUTEX_DIRECTORY_NAME = "availability-v1.lock";
const MAXIMUM_STATE_BYTES = 4 * 1_048_576;

const RegistryStateSchema = z
  .object({
    schema_version: z.literal(STATE_SCHEMA_VERSION),
    leases: z.array(LeaseRecordSchema).max(10_000),
    queue: z.array(WaitTicketSchema).max(10_000),
    rate_events: z.array(z.number().int().nonnegative()).max(100_000),
  })
  .strict()
  .superRefine((state, context) => {
    const leaseIds = new Set<string>();
    const reservedResources = new Set<string>();
    for (const [index, lease] of state.leases.entries()) {
      if (leaseIds.has(lease.lease_id)) {
        context.addIssue({
          code: "custom",
          path: ["leases", index, "lease_id"],
          message: "lease IDs must be unique",
        });
      }
      leaseIds.add(lease.lease_id);
      for (const resource of lease.resource_groups) {
        if (reservedResources.has(resource)) {
          context.addIssue({
            code: "custom",
            path: ["leases", index, "resource_groups"],
            message: "a resource group may be reserved by only one lease",
          });
        }
        reservedResources.add(resource);
      }
    }
    const ticketIds = new Set<string>();
    for (const [index, ticket] of state.queue.entries()) {
      if (ticketIds.has(ticket.ticket_id)) {
        context.addIssue({
          code: "custom",
          path: ["queue", index, "ticket_id"],
          message: "ticket IDs must be unique",
        });
      }
      ticketIds.add(ticket.ticket_id);
    }
  });
type RegistryState = z.infer<typeof RegistryStateSchema>;

export type AcquireRequest = {
  requestId: string;
  backend: BackendName;
  resourceGroups: string[];
  model: string;
  busyBehavior: "fail" | "wait";
  maximumWaitMs: number;
  signal?: AbortSignal;
};

export type AcquiredLease = {
  lease: LeaseRecord;
  queueSeconds: number;
};

type AttemptResult =
  | { kind: "acquired"; lease: LeaseRecord }
  | { kind: "wait"; ticket: WaitTicket }
  | { kind: "error"; error: StableError };

class RegistryError extends Error {
  constructor() {
    super("The shared availability registry could not be reconciled safely.");
    this.name = "RegistryError";
  }
}

function emptyState(): RegistryState {
  return { schema_version: STATE_SCHEMA_VERSION, leases: [], queue: [], rate_events: [] };
}

function intersects(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.some((value) => values.has(value));
}

function seconds(milliseconds: number): number {
  return Number((Math.max(0, milliseconds) / 1_000).toFixed(3));
}

function registryStableError(): StableError {
  return stableError("INTERNAL_ERROR", "Shared availability state is degraded.", {
    retryable: false,
    details: { availability_state: "degraded" },
  });
}

async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DomainError(cancelledError());
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new DomainError(cancelledError()));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function cancelledError(): StableError {
  return stableError("BACKEND_BUSY", "The bounded queue wait was cancelled.", {
    details: { cancelled: true },
  });
}

export class AvailabilityCoordinator {
  readonly ownerInstanceId = randomUUID();
  private readonly statePath: string;
  private readonly mutexPath: string;

  constructor(readonly config: CoordinationConfig) {
    this.statePath = join(config.state_directory, STATE_FILE_NAME);
    this.mutexPath = join(config.state_directory, MUTEX_DIRECTORY_NAME);
  }

  async inspect(): Promise<LeaseInspection> {
    try {
      await access(this.statePath, constants.F_OK);
    } catch {
      return this.publicInspection(emptyState());
    }
    try {
      return await this.transaction((state) => this.publicInspection(state));
    } catch {
      return LeaseInspectionSchema.parse({
        schema_version: STATE_SCHEMA_VERSION,
        healthy: false,
        leases: [],
        queue: [],
        rate_limit_count: 0,
        rate_limit_maximum: this.config.rate_limit_requests,
        rate_limit_window_seconds: this.config.rate_limit_window_ms / 1_000,
        error: registryStableError(),
      });
    }
  }

  async acquire(request: AcquireRequest): Promise<AcquiredLease> {
    const startedAt = Date.now();
    const deadline = startedAt + request.maximumWaitMs;
    let ticketId: string | null = null;
    try {
      for (;;) {
        if (request.signal?.aborted) throw new DomainError(cancelledError());
        const attempted = await this.transaction((state, now) =>
          this.attemptAcquire(state, now, request, ticketId),
        );
        if (attempted.kind === "acquired") {
          return {
            lease: attempted.lease,
            queueSeconds: ticketId === null ? 0 : seconds(Date.now() - startedAt),
          };
        }
        if (attempted.kind === "error") throw new DomainError(attempted.error);
        ticketId = attempted.ticket.ticket_id;
        if (Date.now() >= deadline) {
          throw new DomainError(
            stableError("BACKEND_BUSY", "The bounded queue wait expired before capacity opened.", {
              backend: request.backend,
              details: {
                queue_timeout_seconds: seconds(Date.now() - startedAt),
                retry_after_seconds: 1,
              },
            }),
          );
        }
        await wait(
          Math.min(this.config.queue_poll_interval_ms, Math.max(1, deadline - Date.now())),
          request.signal,
        );
      }
    } catch (error) {
      if (ticketId !== null) await this.removeTicket(ticketId).catch(() => undefined);
      if (error instanceof DomainError) {
        if (error.stable.details.cancelled === true) {
          throw new DomainError({
            ...error.stable,
            backend: request.backend,
            details: {
              ...error.stable.details,
              queue_seconds: seconds(Date.now() - startedAt),
            },
          });
        }
        throw error;
      }
      throw new DomainError(registryStableError());
    }
  }

  startHeartbeat(leaseId: string): () => void {
    let running = false;
    const timer = setInterval(() => {
      if (running) return;
      running = true;
      void this.heartbeat(leaseId).finally(() => {
        running = false;
      });
    }, this.config.heartbeat_interval_ms);
    timer.unref();
    return () => clearInterval(timer);
  }

  async release(leaseId: string, ambiguous: boolean): Promise<void> {
    try {
      await this.transaction((state, now) => {
        const index = state.leases.findIndex((lease) => lease.lease_id === leaseId);
        if (index < 0) return;
        const lease = state.leases[index];
        if (lease === undefined) return;
        if (ambiguous) {
          state.leases[index] = {
            ...lease,
            state: "cooldown",
            heartbeat_at: new Date(now).toISOString(),
            expires_at: new Date(now + this.config.cooldown_ms).toISOString(),
          };
        } else {
          state.leases.splice(index, 1);
        }
      });
    } catch {
      throw new DomainError(registryStableError());
    }
  }

  async clearCooldown(leaseId: string): Promise<boolean> {
    try {
      return await this.transaction((state) => {
        const index = state.leases.findIndex((lease) => lease.lease_id === leaseId);
        if (index < 0 || state.leases[index]?.state !== "cooldown") return false;
        state.leases.splice(index, 1);
        return true;
      });
    } catch {
      throw new DomainError(registryStableError());
    }
  }

  resourceStates(inspection: LeaseInspection, resourceGroups: string[]): ResourceAvailability[] {
    const now = Date.now();
    return resourceGroups.map((resourceGroup) => {
      const lease = inspection.leases.find((candidate) =>
        candidate.resource_groups.includes(resourceGroup),
      );
      const queueDepth = inspection.queue.filter((ticket) =>
        ticket.resource_groups.includes(resourceGroup),
      ).length;
      let availability: Availability = "ready";
      if (!inspection.healthy) availability = "degraded";
      else if (lease?.state === "cooldown") availability = "cooldown";
      else if (lease?.state === "active") availability = "busy";
      else if (queueDepth > 0) availability = "queued";
      return {
        resource_group: resourceGroup,
        availability,
        lease_id: lease?.lease_id ?? null,
        backend: lease?.backend ?? null,
        model: lease?.model ?? null,
        lease_age_seconds: lease ? seconds(now - Date.parse(lease.started_at)) : null,
        cooldown_remaining_seconds:
          lease?.state === "cooldown" ? seconds(Date.parse(lease.expires_at) - now) : null,
        queue_depth: queueDepth,
      };
    });
  }

  private attemptAcquire(
    state: RegistryState,
    now: number,
    request: AcquireRequest,
    ticketId: string | null,
  ): AttemptResult {
    const conflicting = state.leases.find((lease) =>
      intersects(lease.resource_groups, request.resourceGroups),
    );
    const ownTicket =
      ticketId === null ? undefined : state.queue.find((ticket) => ticket.ticket_id === ticketId);
    const ownTicketIndex =
      ownTicket === undefined
        ? state.queue.length
        : state.queue.findIndex((ticket) => ticket.ticket_id === ownTicket.ticket_id);
    const earlierTicket = state.queue
      .slice(0, ownTicketIndex)
      .find((ticket) => intersects(ticket.resource_groups, request.resourceGroups));
    const rateRetryAt = state.rate_events.at(0);
    const rateLimited = state.rate_events.length >= this.config.rate_limit_requests;

    if (conflicting === undefined && earlierTicket === undefined && !rateLimited) {
      if (ownTicket !== undefined) {
        state.queue = state.queue.filter((ticket) => ticket.ticket_id !== ownTicket.ticket_id);
      }
      const timestamp = new Date(now).toISOString();
      const lease = LeaseRecordSchema.parse({
        lease_id: randomUUID(),
        request_id: request.requestId,
        owner_pid: process.pid,
        owner_instance_id: this.ownerInstanceId,
        backend: request.backend,
        resource_groups: [...request.resourceGroups],
        model: request.model,
        started_at: timestamp,
        heartbeat_at: timestamp,
        expires_at: new Date(now + this.config.lease_ttl_ms).toISOString(),
        state: "active",
      });
      state.leases.push(lease);
      state.rate_events.push(now);
      return { kind: "acquired", lease };
    }

    if (request.busyBehavior === "fail" || request.maximumWaitMs === 0) {
      if (conflicting?.state === "cooldown") {
        return {
          kind: "error",
          error: stableError("BACKEND_COOLDOWN", undefined, {
            backend: request.backend,
            details: {
              lease_id: conflicting.lease_id,
              active_backend: conflicting.backend,
              active_model: conflicting.model,
              cooldown_remaining_seconds: seconds(Date.parse(conflicting.expires_at) - now),
              retry_after_seconds: Math.max(
                1,
                Math.ceil((Date.parse(conflicting.expires_at) - now) / 1_000),
              ),
            },
          }),
        };
      }
      if (rateLimited) {
        const retryMs = Math.max(1, (rateRetryAt ?? now) + this.config.rate_limit_window_ms - now);
        return {
          kind: "error",
          error: stableError("RATE_LIMITED", undefined, {
            backend: request.backend,
            details: {
              retry_after_seconds: Math.max(1, Math.ceil(retryMs / 1_000)),
              limit: this.config.rate_limit_requests,
              window_seconds: this.config.rate_limit_window_ms / 1_000,
            },
          }),
        };
      }
      const busyLease = conflicting;
      return {
        kind: "error",
        error: stableError("BACKEND_BUSY", undefined, {
          backend: request.backend,
          details: {
            lease_id: busyLease?.lease_id ?? null,
            active_backend: busyLease?.backend ?? null,
            active_model: busyLease?.model ?? null,
            busy_seconds: busyLease ? seconds(now - Date.parse(busyLease.started_at)) : 0,
            queue_depth: state.queue.filter((ticket) =>
              intersects(ticket.resource_groups, request.resourceGroups),
            ).length,
            retry_after_seconds: 1,
          },
        }),
      };
    }

    if (ownTicket !== undefined) return { kind: "wait", ticket: ownTicket };
    if (state.queue.length >= this.config.queue_capacity) {
      return {
        kind: "error",
        error: stableError("BACKEND_BUSY", "The bounded wait queue is full.", {
          backend: request.backend,
          details: { queue_capacity: this.config.queue_capacity, retry_after_seconds: 1 },
        }),
      };
    }
    const created = WaitTicketSchema.parse({
      ticket_id: randomUUID(),
      request_id: request.requestId,
      owner_pid: process.pid,
      owner_instance_id: this.ownerInstanceId,
      backend: request.backend,
      resource_groups: [...request.resourceGroups],
      model: request.model,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + request.maximumWaitMs).toISOString(),
    });
    state.queue.push(created);
    return { kind: "wait", ticket: created };
  }

  private async heartbeat(leaseId: string): Promise<void> {
    try {
      await this.transaction((state, now) => {
        const index = state.leases.findIndex((lease) => lease.lease_id === leaseId);
        const lease = index < 0 ? undefined : state.leases[index];
        if (lease?.state !== "active" || lease.owner_instance_id !== this.ownerInstanceId) {
          return;
        }
        state.leases[index] = {
          ...lease,
          heartbeat_at: new Date(now).toISOString(),
          expires_at: new Date(now + this.config.lease_ttl_ms).toISOString(),
        };
      });
    } catch {
      // The active lease remains conservative: missed heartbeats expire into cooldown.
    }
  }

  private async removeTicket(ticketId: string): Promise<void> {
    await this.transaction((state) => {
      state.queue = state.queue.filter((ticket) => ticket.ticket_id !== ticketId);
    });
  }

  private publicInspection(state: RegistryState): LeaseInspection {
    return LeaseInspectionSchema.parse({
      schema_version: STATE_SCHEMA_VERSION,
      healthy: true,
      leases: state.leases,
      queue: state.queue,
      rate_limit_count: state.rate_events.length,
      rate_limit_maximum: this.config.rate_limit_requests,
      rate_limit_window_seconds: this.config.rate_limit_window_ms / 1_000,
      error: null,
    });
  }

  private cleanup(state: RegistryState, now: number): void {
    state.rate_events = state.rate_events.filter(
      (timestamp) => timestamp > now - this.config.rate_limit_window_ms,
    );
    state.queue = state.queue.filter((ticket) => Date.parse(ticket.expires_at) > now);
    const leases: LeaseRecord[] = [];
    for (const lease of state.leases) {
      const expires = Date.parse(lease.expires_at);
      if (lease.state === "cooldown") {
        if (expires > now) leases.push(lease);
        continue;
      }
      if (expires > now) {
        leases.push(lease);
      } else {
        leases.push({
          ...lease,
          state: "cooldown",
          heartbeat_at: new Date(now).toISOString(),
          expires_at: new Date(now + this.config.cooldown_ms).toISOString(),
        });
      }
    }
    state.leases = leases;
  }

  private async transaction<T>(operation: (state: RegistryState, now: number) => T): Promise<T> {
    const mutex = await this.acquireMutex();
    try {
      const state = await this.readState();
      const now = Date.now();
      this.cleanup(state, now);
      const result = operation(state, now);
      await mutex.assertOwned();
      await this.writeState(state);
      return result;
    } finally {
      await mutex.release();
    }
  }

  private async readState(): Promise<RegistryState> {
    let source: string;
    try {
      source = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw new RegistryError();
    }
    if (Buffer.byteLength(source) > MAXIMUM_STATE_BYTES) throw new RegistryError();
    try {
      return RegistryStateSchema.parse(JSON.parse(source) as unknown);
    } catch {
      throw new RegistryError();
    }
  }

  private async writeState(state: RegistryState): Promise<void> {
    const parsed = RegistryStateSchema.parse(state);
    const temporaryPath = join(
      this.config.state_directory,
      `.availability-v1.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    let handle;
    let renamed = false;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.statePath);
      renamed = true;
      const directory = await open(this.config.state_directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (!renamed) await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async acquireMutex(): Promise<{
    assertOwned: () => Promise<void>;
    release: () => Promise<void>;
  }> {
    await mkdir(this.config.state_directory, { recursive: true, mode: 0o700 });
    await chmod(this.config.state_directory, 0o700);
    const deadline = Date.now() + this.config.mutex_timeout_ms;
    for (;;) {
      try {
        await mkdir(this.mutexPath, { mode: 0o700 });
        const ownerPath = join(this.mutexPath, "owner.json");
        const mutexId = randomUUID();
        let owner;
        try {
          owner = await open(ownerPath, "wx", 0o600);
          await owner.writeFile(
            `${JSON.stringify({ mutex_id: mutexId, owner_pid: process.pid, owner_instance_id: this.ownerInstanceId, created_at: new Date().toISOString() })}\n`,
            "utf8",
          );
          await owner.sync();
        } catch (error) {
          await unlink(ownerPath).catch(() => undefined);
          await rmdir(this.mutexPath).catch(() => undefined);
          throw error;
        } finally {
          await owner?.close();
        }
        const owned = async (): Promise<boolean> => {
          try {
            const value = JSON.parse(await readFile(ownerPath, "utf8")) as {
              mutex_id?: unknown;
            };
            return value.mutex_id === mutexId;
          } catch {
            return false;
          }
        };
        return {
          assertOwned: async () => {
            if (!(await owned())) throw new RegistryError();
          },
          release: async () => {
            if (!(await owned())) return;
            await unlink(ownerPath).catch(() => undefined);
            await rmdir(this.mutexPath).catch(() => undefined);
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new RegistryError();
      }

      let mutexModifiedAt: number;
      try {
        const metadata = await stat(this.mutexPath);
        mutexModifiedAt = metadata.mtimeMs;
      } catch {
        continue;
      }
      if (Date.now() - mutexModifiedAt > this.config.mutex_stale_ms) {
        const stalePath = join(
          this.config.state_directory,
          `.availability-v1.stale.${randomUUID()}`,
        );
        try {
          await rename(this.mutexPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch {
          // Another process recovered or acquired the mutex first.
        }
      }
      if (Date.now() >= deadline) throw new RegistryError();
      await wait(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }
}
