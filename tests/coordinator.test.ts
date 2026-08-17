import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendProbe } from "../src/backends/types.js";
import { DEFAULT_CONFIG, type CoordinationConfig, type DelegateConfig } from "../src/config.js";
import { AvailabilityCoordinator } from "../src/coordinator.js";
import { LeaseInspectionSchema, StatusResultSchema } from "../src/contracts.js";
import { DomainError } from "../src/errors.js";
import { Logger } from "../src/logging.js";
import { StatusService } from "../src/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function registryConfig(
  overrides: Partial<CoordinationConfig> = {},
): Promise<CoordinationConfig> {
  const stateDirectory = await mkdtemp(join(tmpdir(), "local-mlx-coordinator-"));
  temporaryDirectories.push(stateDirectory);
  return {
    ...DEFAULT_CONFIG.coordination,
    state_directory: stateDirectory,
    queue_poll_interval_ms: 10,
    ...overrides,
  };
}

function request(
  backend: "controller" | "worker" | "cluster",
  resourceGroups: string[],
  overrides: { busyBehavior?: "fail" | "wait"; maximumWaitMs?: number } = {},
) {
  return {
    requestId: randomUUID(),
    backend,
    resourceGroups,
    model: `${backend}-model`,
    busyBehavior: overrides.busyBehavior ?? "fail",
    maximumWaitMs: overrides.maximumWaitMs ?? 0,
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for coordinator state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("cross-process availability coordinator", () => {
  it("atomically reserves every cluster resource while allowing disjoint hosts", async () => {
    const config = await registryConfig();
    const firstProcess = new AvailabilityCoordinator(config);
    const secondProcess = new AvailabilityCoordinator(config);
    const controller = await firstProcess.acquire(request("controller", ["controller"]));
    const worker = await secondProcess.acquire(request("worker", ["worker"]));

    await expect(
      secondProcess.acquire(request("cluster", ["controller", "worker"])),
    ).rejects.toMatchObject({ stable: { code: "BACKEND_BUSY" } });
    expect((await firstProcess.inspect()).leases).toHaveLength(2);

    await Promise.all([
      firstProcess.release(controller.lease.lease_id, false),
      secondProcess.release(worker.lease.lease_id, false),
    ]);
    expect((await firstProcess.inspect()).leases).toEqual([]);
  });

  it("serves bounded waiters FIFO for overlapping resources", async () => {
    const config = await registryConfig();
    const owner = new AvailabilityCoordinator(config);
    const firstWaiter = new AvailabilityCoordinator(config);
    const secondWaiter = new AvailabilityCoordinator(config);
    const active = await owner.acquire(request("controller", ["controller"]));

    const firstPromise = firstWaiter.acquire(
      request("controller", ["controller"], { busyBehavior: "wait", maximumWaitMs: 2_000 }),
    );
    await waitFor(async () => (await owner.inspect()).queue.length === 1);
    const secondPromise = secondWaiter.acquire(
      request("controller", ["controller"], { busyBehavior: "wait", maximumWaitMs: 2_000 }),
    );
    await waitFor(async () => (await owner.inspect()).queue.length === 2);

    await owner.release(active.lease.lease_id, false);
    const first = await firstPromise;
    expect(first.queueSeconds).toBeGreaterThan(0);
    expect((await owner.inspect()).queue).toHaveLength(1);
    await firstWaiter.release(first.lease.lease_id, false);
    const second = await secondPromise;
    expect(second.queueSeconds).toBeGreaterThan(0);
    expect(Date.parse(second.lease.started_at)).toBeGreaterThanOrEqual(
      Date.parse(first.lease.started_at),
    );
    await secondWaiter.release(second.lease.lease_id, false);
  });

  it("removes a cancelled wait ticket without releasing another request", async () => {
    const config = await registryConfig();
    const owner = new AvailabilityCoordinator(config);
    const waiter = new AvailabilityCoordinator(config);
    const active = await owner.acquire(request("controller", ["controller"]));
    const abort = new AbortController();
    const waiting = waiter.acquire({
      ...request("controller", ["controller"], {
        busyBehavior: "wait",
        maximumWaitMs: 2_000,
      }),
      signal: abort.signal,
    });
    await waitFor(async () => (await owner.inspect()).queue.length === 1);
    abort.abort();
    await expect(waiting).rejects.toMatchObject({
      stable: { code: "BACKEND_BUSY", details: { cancelled: true } },
    });
    expect((await owner.inspect()).queue).toEqual([]);
    expect((await owner.inspect()).leases[0]?.lease_id).toBe(active.lease.lease_id);
    await owner.release(active.lease.lease_id, false);
  });

  it("bounds queue capacity and removes tickets after wait deadlines", async () => {
    const config = await registryConfig({ queue_capacity: 1 });
    const owner = new AvailabilityCoordinator(config);
    const firstWaiter = new AvailabilityCoordinator(config);
    const secondWaiter = new AvailabilityCoordinator(config);
    const active = await owner.acquire(request("controller", ["controller"]));
    const waiting = firstWaiter.acquire(
      request("controller", ["controller"], { busyBehavior: "wait", maximumWaitMs: 1_000 }),
    );
    await waitFor(async () => (await owner.inspect()).queue.length === 1);
    await expect(
      secondWaiter.acquire(
        request("controller", ["controller"], {
          busyBehavior: "wait",
          maximumWaitMs: 1_000,
        }),
      ),
    ).rejects.toMatchObject({
      stable: { code: "BACKEND_BUSY", details: { queue_capacity: 1 } },
    });
    const timedOut = await waiting.then(
      () => null,
      (error: unknown) => error,
    );
    expect(timedOut).toBeInstanceOf(DomainError);
    if (!(timedOut instanceof DomainError)) throw new Error("Expected a domain timeout");
    expect(timedOut.stable.code).toBe("BACKEND_BUSY");
    expect(typeof timedOut.stable.details.queue_timeout_seconds).toBe("number");
    expect((await owner.inspect()).queue).toEqual([]);
    await owner.release(active.lease.lease_id, false);
  });

  it("moves ambiguous and expired active leases through cooldown", async () => {
    const config = await registryConfig({ lease_ttl_ms: 70, cooldown_ms: 90 });
    const coordinator = new AvailabilityCoordinator(config);
    const ambiguous = await coordinator.acquire(request("controller", ["controller"]));
    await coordinator.release(ambiguous.lease.lease_id, true);
    let state = LeaseInspectionSchema.parse(await coordinator.inspect());
    expect(state.leases[0]?.state).toBe("cooldown");
    await expect(coordinator.acquire(request("controller", ["controller"]))).rejects.toMatchObject({
      stable: { code: "BACKEND_COOLDOWN" },
    });
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect((await coordinator.inspect()).leases).toEqual([]);

    const expired = await coordinator.acquire(request("controller", ["controller"]));
    await new Promise((resolve) => setTimeout(resolve, 80));
    state = await coordinator.inspect();
    expect(state.leases.find((lease) => lease.lease_id === expired.lease.lease_id)?.state).toBe(
      "cooldown",
    );
  });

  it("heartbeats keep an owned active lease from expiring", async () => {
    const config = await registryConfig({
      heartbeat_interval_ms: 20,
      lease_ttl_ms: 70,
      cooldown_ms: 90,
    });
    const coordinator = new AvailabilityCoordinator(config);
    const active = await coordinator.acquire(request("controller", ["controller"]));
    const stop = coordinator.startHeartbeat(active.lease.lease_id);
    await new Promise((resolve) => setTimeout(resolve, 130));
    expect((await coordinator.inspect()).leases[0]?.state).toBe("active");
    stop();
    await coordinator.release(active.lease.lease_id, false);
  });

  it("shares a generation-start rate window across coordinator instances", async () => {
    const config = await registryConfig({ rate_limit_requests: 1, rate_limit_window_ms: 1_500 });
    const firstProcess = new AvailabilityCoordinator(config);
    const secondProcess = new AvailabilityCoordinator(config);
    const first = await firstProcess.acquire(request("controller", ["controller"]));
    await firstProcess.release(first.lease.lease_id, false);
    await expect(
      secondProcess.acquire(request("controller", ["controller"])),
    ).rejects.toMatchObject({ stable: { code: "RATE_LIMITED" } });
    const waiting = secondProcess.acquire(
      request("controller", ["controller"], {
        busyBehavior: "wait",
        maximumWaitMs: 3_000,
      }),
    );
    await waitFor(async () => (await firstProcess.inspect()).queue.length === 1);
    const queuedState = await firstProcess.inspect();
    expect(firstProcess.resourceStates(queuedState, ["controller"])[0]?.availability).toBe(
      "queued",
    );
    const second = await waiting;
    await secondProcess.release(second.lease.lease_id, false);
  });

  it("reports corrupt state as degraded instead of replacing it", async () => {
    const config = await registryConfig();
    await writeFile(join(config.state_directory, "availability-v1.json"), "private invalid body");
    const coordinator = new AvailabilityCoordinator(config);
    const inspection = await coordinator.inspect();
    expect(inspection).toMatchObject({
      healthy: false,
      leases: [],
      error: { code: "INTERNAL_ERROR", details: { availability_state: "degraded" } },
    });
    await expect(coordinator.acquire(request("controller", ["controller"]))).rejects.toMatchObject({
      stable: { code: "INTERNAL_ERROR" },
    });
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(config.state_directory, "availability-v1.json"), "utf8"),
      ),
    ).toBe("private invalid body");
  });

  it("recovers an abandoned short-lived mutex without clearing leases", async () => {
    const config = await registryConfig({ mutex_timeout_ms: 100, mutex_stale_ms: 20 });
    const coordinator = new AvailabilityCoordinator(config);
    const acquired = await coordinator.acquire(request("controller", ["controller"]));
    const mutex = join(config.state_directory, "availability-v1.lock");
    await mkdir(mutex);
    await writeFile(join(mutex, "owner.json"), '{"owner_pid":999999}\n');
    const old = new Date(Date.now() - 1_000);
    await utimes(mutex, old, old);
    expect((await coordinator.inspect()).leases[0]?.lease_id).toBe(acquired.lease.lease_id);
    await coordinator.release(acquired.lease.lease_id, false);
  });

  it("projects busy and cooldown diagnostics into status", async () => {
    const coordination = await registryConfig({
      rate_limit_requests: 1,
      rate_limit_window_ms: 60_000,
    });
    const config: DelegateConfig = structuredClone(DEFAULT_CONFIG);
    config.coordination = coordination;
    config.backends.worker.enabled = false;
    config.backends.cluster.enabled = false;
    const probe: BackendProbe = {
      probe(request) {
        return Promise.resolve({
          backend: request.backend,
          enabled: true,
          health: true,
          availability: "ready",
          models: [{ id: "model", object: null, created: null, owned_by: null }],
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
        });
      },
    };
    const coordinator = new AvailabilityCoordinator(coordination);
    const service = new StatusService(
      config,
      probe,
      new Logger("error", () => undefined),
      coordinator,
    );
    const active = await coordinator.acquire(request("controller", ["controller"]));
    const busy = StatusResultSchema.parse(await service.status({ backend: "controller" }));
    expect(busy).toMatchObject({
      ok: false,
      availability: "busy",
      queue_depth: 0,
      error: { code: "BACKEND_BUSY" },
    });
    expect(busy.resource_states[0]).toMatchObject({ availability: "busy" });
    await coordinator.release(active.lease.lease_id, true);
    const cooldown = await service.status({ backend: "controller" });
    expect(cooldown).toMatchObject({
      availability: "cooldown",
      error: { code: "BACKEND_COOLDOWN" },
    });
    expect(cooldown.cooldown_remaining_seconds).toBeGreaterThan(0);
    expect(await coordinator.clearCooldown(active.lease.lease_id)).toBe(true);
    const abort = new AbortController();
    const waiting = coordinator.acquire({
      ...request("controller", ["controller"], {
        busyBehavior: "wait",
        maximumWaitMs: 2_000,
      }),
      signal: abort.signal,
    });
    await waitFor(async () => (await coordinator.inspect()).queue.length === 1);
    const queued = await service.status({ backend: "controller" });
    expect(queued).toMatchObject({
      availability: "queued",
      queue_depth: 1,
      error: { code: "BACKEND_BUSY" },
    });
    abort.abort();
    await expect(waiting).rejects.toMatchObject({
      stable: { code: "BACKEND_BUSY", details: { cancelled: true } },
    });
    expect((await service.status({ backend: "controller" })).availability).toBe("ready");
  });
});
