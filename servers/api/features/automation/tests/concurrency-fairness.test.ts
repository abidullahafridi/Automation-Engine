import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { Clock } from "../automation.service.js";
import { parseRetryAfter, decideRetry, type RetryPolicy } from "../retry.policy.js";
import type { StoredRun } from "../run.repository.js";
import { createRunWorker, type RunHandler, type Scheduler } from "../run.worker.js";
import { createWorkspaceConcurrencyGate } from "../workspace.concurrency.js";
import { createInMemoryRunRepository } from "./run.repository.in-memory.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const T0 = "2026-10-19T10:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

const buildRun = (workspaceId: string, runId: string, createdAt = T0): StoredRun => Object.freeze({
  runId,
  eventId: `event-${runId}`,
  workspaceId,
  automationId: `auto-${runId}`,
  version: 1,
  contentHash: "hash-1",
  status: "queued" as const,
  revision: 0,
  fencingToken: 0,
  runAfter: createdAt,
  createdAt,
  updatedAt: createdAt
});

const manualScheduler = (): Scheduler => ({
  every: () => () => undefined
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const resolved = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (resolved.kind !== "resolved") throw new Error("scope required");
  return resolved.scope;
};

void test("TC-0611 burst queue drains within measured target", async () => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-burst");
  const burstCount = 20;

  for (let i = 0; i < burstCount; i += 1) {
    await store.repository.insert(scope, buildRun("workspace-burst", `run-burst-${String(i)}`));
  }

  let processedCount = 0;
  const clock: Clock = { now: () => T0 };
  const handler: RunHandler = async ({ run }) => {
    processedCount += 1;
    await store.repository.transition(scope, run.runId, run.revision, "running", "completed", clock.now(), run.fencingToken);
  };

  const worker = createRunWorker({
    scope,
    workerId: "burst-worker",
    runs: store.repository,
    handler,
    clock,
    leaseDurationMs: 60_000,
    renewIntervalMs: 20_000,
    scheduler: manualScheduler()
  });

  // Drain the burst
  for (let i = 0; i < burstCount; i += 1) {
    const outcome = await worker.tick();
    assert.equal(outcome, "processed");
  }

  assert.equal(processedCount, burstCount);
  assert.equal(await worker.tick(), "idle");
});

void test("TC-0612 one tenant cannot starve all others (fairness and round-robin)", () => {
  const gate = createWorkspaceConcurrencyGate({ maxPerWorkspace: 2, maxTotal: 5 });

  const heavyWorkspace = "ws-heavy";
  const quietWorkspace1 = "ws-quiet-1";
  const quietWorkspace2 = "ws-quiet-2";

  // Heavy workspace tries to acquire more than its allowance
  assert.equal(gate.acquire(heavyWorkspace), true);
  assert.equal(gate.acquire(heavyWorkspace), true);
  assert.equal(gate.acquire(heavyWorkspace), false); // Capped at maxPerWorkspace (2)

  // Candidate pool with heavy and quiet tenants
  const candidates = [heavyWorkspace, quietWorkspace1, quietWorkspace2];

  // acquireFair must give slot to quiet workspace instead of being starved by heavy
  const firstFair = gate.acquireFair(candidates);
  assert.equal(firstFair, quietWorkspace1);

  const secondFair = gate.acquireFair(candidates);
  assert.equal(secondFair, quietWorkspace2);

  // Total in-flight is 4 (2 heavy + 1 quiet1 + 1 quiet2)
  assert.equal(gate.totalInFlight(), 4);
  assert.equal(gate.inFlight(heavyWorkspace), 2);
  assert.equal(gate.inFlight(quietWorkspace1), 1);
  assert.equal(gate.inFlight(quietWorkspace2), 1);

  // Release a slot for quiet1 and verify release decrement
  gate.release(quietWorkspace1);
  assert.equal(gate.inFlight(quietWorkspace1), 0);
  assert.equal(gate.totalInFlight(), 3);
});

void test("TC-0613 provider 429 responses cause bounded throughput and backoff", () => {
  const policy: RetryPolicy = {
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    maxAgeMs: 120_000,
    maxAttempts: 5
  };

  const parsedHeader = parseRetryAfter("10", Date.parse(T0));
  assert.equal(parsedHeader, 10_000); // 10 seconds converted to ms

  const decision = decideRetry(
    {
      attempt: 1,
      firstAttemptAt: T0,
      now: at(1_000),
      errorClass: "transient",
      retryAfterMs: parsedHeader
    },
    policy,
    () => 0.5 // deterministic jitter
  );

  assert.equal(decision.decision, "retry");
  assert.equal(decision.delayMs >= 10_000, true);
  assert.equal(decision.honouredRetryAfter, true);

  // When Retry-After exceeds maxAgeMs budget, decision must be dead_letter
  const exceededDecision = decideRetry(
    {
      attempt: 2,
      firstAttemptAt: T0,
      now: at(100_000),
      errorClass: "transient",
      retryAfterMs: 50_000 // 100k + 50k > 120k maxAgeMs
    },
    policy,
    () => 0.5
  );

  assert.equal(exceededDecision.decision, "stop");
  assert.equal(exceededDecision.outcome, "dead_letter");
  assert.equal(exceededDecision.reason, "MAX_AGE_EXHAUSTED");
});

void test("TC-0614 worker scale-in does not lose acknowledged work", async () => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-scale-in");
  const run = buildRun("workspace-scale-in", "run-interrupted");

  await store.repository.insert(scope, run);

  let runStartedResolve: () => void = () => undefined;
  const runStarted = new Promise<void>((r) => { runStartedResolve = r; });

  const clock: Clock = { now: () => T0 };
  const handler: RunHandler = async ({ signal }) => {
    runStartedResolve();
    // Simulate long-running task waiting for abort signal
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => { resolve(); });
    });
  };

  const worker = createRunWorker({
    scope,
    workerId: "scale-in-worker",
    runs: store.repository,
    handler,
    clock,
    leaseDurationMs: 60_000,
    renewIntervalMs: 20_000,
    scheduler: manualScheduler()
  });

  // Start tick asynchronously
  const tickPromise = worker.tick();
  await runStarted;

  // Scale in / shutdown worker with small grace window
  const shutdownReport = await worker.shutdown({ graceMs: 10 });
  await tickPromise;

  assert.equal(shutdownReport.interrupted, 1);
  assert.equal(shutdownReport.drained, 0);

  // Verify run was safely returned to queued status without being lost
  const stored = await store.repository.findById(scope, "run-interrupted");
  assert.ok(stored);
  assert.equal(stored.status, "queued");
  assert.equal(stored.interruptedReason, "WORKER_SHUTDOWN");
  assert.equal(stored.revision, 2); // 0 (insert) -> 1 (claimed) -> 2 (requeued on shutdown)
});
