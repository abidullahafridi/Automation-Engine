import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { Clock } from "../automation.service.js";
import type { StoredRun } from "../run.repository.js";
import { createRunWorker, type RunHandler, type Scheduler } from "../run.worker.js";
import { createInMemoryRunRepository } from "./run.repository.in-memory.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const T0 = "2026-10-16T10:00:00.000Z";
const TTL = 60_000;
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

const queuedRun = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-worker", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }); });

const manualScheduler = (): Scheduler & { fire: () => void } => {
  const callbacks = new Set<() => void>();
  return {
    every: (_ms, callback) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
    fire: () => { for (const callback of [...callbacks]) callback(); }
  };
};

const setup = async (makeHandler: (context: { store: ReturnType<typeof createInMemoryRunRepository>; scope: WorkspaceScope; clock: Clock }) => RunHandler) => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const resolved = await resolver.resolve({ credential: "user", requestedWorkspaceId: "workspace-worker" });
  if (resolved.kind !== "resolved") throw new Error("scope required");
  const scope = resolved.scope;
  let current = T0;
  const clock: Clock = { now: () => current };
  const scheduler = manualScheduler();
  const worker = createRunWorker({
    scope, workerId: "worker-1", runs: store.repository, handler: makeHandler({ store, scope, clock }),
    clock, leaseDurationMs: TTL, renewIntervalMs: TTL / 3, scheduler
  });
  await store.repository.insert(scope, queuedRun("r1"));
  return { store, scope, worker, scheduler, setNow: (value: string) => { current = value; } };
};

void test("worker claims a queued run and the handler completes it", async () => {
  const f = await setup(({ store, scope, clock }) => async ({ run }) => {
    await store.repository.transition(scope, run.runId, run.revision, "running", "completed", clock.now(), run.fencingToken);
  });
  assert.equal(await f.worker.tick(), "processed");
  assert.equal((await f.store.repository.findById(f.scope, "r1"))?.status, "completed");
  assert.equal(await f.worker.tick(), "idle");
});

void test("TC-0308 graceful shutdown stops new claims", async () => {
  const f = await setup(() => () => Promise.resolve());
  assert.deepEqual(await f.worker.shutdown({ graceMs: 10 }), { drained: 0, interrupted: 0, notInterrupted: 0 });
  assert.equal(await f.worker.tick(), "stopped");
  assert.equal((await f.store.repository.findById(f.scope, "r1"))?.status, "queued");
});

void test("shutdown lets a fast in-flight run drain without interrupting it", async () => {
  const started = deferred();
  const gate = deferred();
  const f = await setup(() => async () => { started.resolve(); await gate.promise; });
  const ticking = f.worker.tick();
  await started.promise;
  const shutting = f.worker.shutdown({ graceMs: 1_000 });
  gate.resolve();
  assert.deepEqual(await shutting, { drained: 1, interrupted: 0, notInterrupted: 0 });
  assert.equal(await ticking, "processed");
});

void test("shutdown interrupts a run that outlives the grace period (requeue, action -> unknown_outcome)", async () => {
  const started = deferred();
  const f = await setup(({ store, scope }) => async ({ run, signal }) => {
    await store.repository.insertActionAttempt(scope, {
      runId: run.runId, workspaceId: scope.workspaceId, actionIndex: 0, attempt: 1, status: "pending", createdAt: T0, updatedAt: T0
    });
    store.startAction(scope.workspaceId, run.runId, 0);
    started.resolve();
    await waitForAbort(signal);
  });
  const ticking = f.worker.tick();
  await started.promise;
  const report = await f.worker.shutdown({ graceMs: 10 });
  await ticking;

  assert.deepEqual(report, { drained: 0, interrupted: 1, notInterrupted: 0 });
  const stored = await f.store.repository.findById(f.scope, "r1");
  if (!stored) throw new Error("Interrupted run must exist.");
  assert.equal(stored.status, "queued");
  assert.equal(stored.interruptedReason, "WORKER_SHUTDOWN");
  assert.deepEqual(f.store.actionStatuses("r1"), ["unknown_outcome"]);
});

void test("heartbeat failure (lease lost) aborts the handler and the reaper recovers the run", async () => {
  const started = deferred();
  const f = await setup(() => async ({ signal }) => { started.resolve(); await waitForAbort(signal); });
  const ticking = f.worker.tick();
  await started.promise;
  f.setNow(at(TTL + 1_000));
  f.scheduler.fire();

  assert.equal(await ticking, "lease_lost");
  const recovered = await f.store.repository.recoverExpiredLeases(f.scope, at(TTL + 1_000), 10);
  assert.equal(recovered.length, 1);
});

void test("a throwing handler does not crash the worker; the reaper recovers the run after lease expiry", async () => {
  const f = await setup(() => () => Promise.reject(new Error("boom")));
  assert.equal(await f.worker.tick(), "handler_error");
  const recovered = await f.store.repository.recoverExpiredLeases(f.scope, at(TTL), 10);
  assert.equal(recovered.length, 1);
});
