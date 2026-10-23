import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type Principal, type WorkspaceScope } from "../automation.ports.js";
import {
  createReleaseControlService,
  type ReleaseControlResult
} from "../release.control.service.js";
import { createInMemoryReleaseAuditStore } from "../release.audit.js";
import {
  createDefaultReleaseSnapshot,
  findExpiredFlagDefinitions,
  type ReleaseSnapshot
} from "../release.flags.js";
import { createReleaseGate } from "../release.gate.js";
import { createInMemoryReleaseControlStore, type ReleaseControlStore } from "../release.store.js";
import {
  createTriggerMatcher,
  type MatcherRunRepository,
  type TriggerCandidateRepository
} from "../trigger.matcher.js";
import { createRunWorker, type Scheduler } from "../run.worker.js";
import type { StoredRun } from "../run.repository.js";
import { createInMemoryRunRepository } from "./run.repository.in-memory.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const NOW = "2026-10-20T10:00:00.000Z";
const ops: Principal = { type: "user", id: "ops-1" };
const allGrants = [
  "ops-1:automation.release.flag.write",
  "ops-1:automation.release.killswitch.engage",
  "ops-1:automation.release.killswitch.release"
] as const;

const setup = async (
  grants: readonly string[] = allGrants,
  store: ReleaseControlStore = createInMemoryReleaseControlStore(createDefaultReleaseSnapshot(NOW))
) => {
  const audit = createInMemoryReleaseAuditStore();
  const state = { counter: 0 };
  const control = createReleaseControlService({
    ownsScope: resolver.ownsScope,
    store,
    policy: { authorize: (principal, permission) => Promise.resolve(grants.includes(`${principal.id}:${permission}`)) },
    audit: audit.port,
    clock: { now: () => NOW },
    rng: { nextId: () => `corr-${String(++state.counter)}` }
  });
  const gate = createReleaseGate({ ownsScope: resolver.ownsScope, store });
  const opsScope = await scopeFor("workspace-ops");
  const revision = async (): Promise<number> => (await store.read()).revision;

  const openAll = async (): Promise<void> => {
    for (const flag of ["ingest", "execute"] as const) {
      const result = await control.setRollout(opsScope, ops, {
        flag, mode: "all", workspaceIds: [], expectedRevision: await revision(), reason: "open for test"
      });
      assert.equal(result.kind, "applied");
    }
  };
  const engage = async (mode: "pause-execution" | "pause-intake"): Promise<ReleaseControlResult> =>
    control.engageKillSwitch(opsScope, ops, { mode, expectedRevision: await revision(), reason: "incident" });
  const release = async (): Promise<ReleaseControlResult> =>
    control.releaseKillSwitch(opsScope, ops, {
      expectedRevision: await revision(), reason: "cause reviewed", reviewConfirmed: true
    });

  return { store, audit, control, gate, opsScope, revision, openAll, engage, release };
};

const appliedOf = (result: ReleaseControlResult): ReleaseSnapshot => {
  if (result.kind !== "applied") throw new Error(`Expected applied, got ${result.kind}.`);
  return result.snapshot;
};

const T0 = "2026-10-20T09:00:00.000Z";
const queuedRun = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-worker", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});
const idleScheduler: Scheduler = { every: () => () => undefined };

const statusChangedEvent = {
  eventId: "event-1",
  eventType: "task.status_changed",
  schemaVersion: 1,
  occurredAt: "2026-10-20T09:00:00.000Z",
  workspaceId: "workspace-a",
  actor: { type: "user", id: "user-1" },
  aggregate: { type: "task", id: "task-1" },
  payload: { task: { status: "done", previousStatus: "open", priority: "high", isArchived: false } }
};

void test("every flag defaults to OFF and the gate fails closed", async () => {
  const t = await setup();
  const scope = await scopeFor("workspace-a");
  assert.deepEqual(await t.gate.decideIntake(scope), { kind: "deny", code: "FLAG_OFF", retryable: false });
  assert.deepEqual(await t.gate.decideExecution(scope), { kind: "deny", code: "FLAG_OFF", retryable: false });

  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  assert.deepEqual(await t.gate.decideExecution(forged), { kind: "deny", code: "SCOPE_MISSING", retryable: false });
  assert.equal(await t.gate.claimGateFor(forged)(), false);

  const broken: ReleaseControlStore = {
    read: () => Promise.reject(new Error("store down")),
    compareAndSet: () => Promise.resolve("conflict")
  };
  const down = createReleaseGate({ ownsScope: resolver.ownsScope, store: broken });
  assert.deepEqual(await down.decideIntake(scope), { kind: "deny", code: "FLAGS_UNAVAILABLE", retryable: true });
  assert.equal(await down.allowsIntake(scope), false);
});

void test("cohort and shadow rollout apply to listed workspaces only", async () => {
  const t = await setup();
  const inCohort = await scopeFor("workspace-a");
  const outside = await scopeFor("workspace-b");

  appliedOf(await t.control.setRollout(t.opsScope, ops, {
    flag: "execute", mode: "cohort", workspaceIds: ["workspace-a"], expectedRevision: 0, reason: "canary"
  }));
  assert.deepEqual(await t.gate.decideExecution(inCohort), { kind: "allow" });
  assert.deepEqual(await t.gate.decideExecution(outside), { kind: "deny", code: "NOT_IN_COHORT", retryable: false });

  appliedOf(await t.control.setRollout(t.opsScope, ops, {
    flag: "ingest", mode: "shadow", workspaceIds: ["workspace-a"], expectedRevision: 1, reason: "shadow run"
  }));
  assert.deepEqual(await t.gate.decideIntake(inCohort), { kind: "shadow" });
  // Shadow is held: no plan-only execution path exists yet, so it never creates real runs.
  assert.equal(await t.gate.allowsIntake(inCohort), false);
  assert.deepEqual(await t.gate.decideIntake(outside), { kind: "deny", code: "NOT_IN_COHORT", retryable: false });
});

void test("TC-0711 kill switch stops new claims and intake as defined", async () => {
  const t = await setup();
  await t.openAll();
  const scope = await scopeFor("workspace-worker");
  assert.deepEqual(await t.gate.decideExecution(scope), { kind: "allow" });

  // pause-execution: claims stop, intake continues (events are still accepted and stored).
  appliedOf(await t.engage("pause-execution"));
  assert.deepEqual(await t.gate.decideExecution(scope), { kind: "deny", code: "KILL_SWITCH", retryable: true });
  assert.deepEqual(await t.gate.decideIntake(scope), { kind: "allow" });
  assert.equal((await t.engage("pause-intake")).kind, "already-engaged");

  const runs = createInMemoryRunRepository(resolver.ownsScope);
  await runs.repository.insert(scope, queuedRun("r1"));
  const worker = createRunWorker({
    scope,
    workerId: "worker-1",
    runs: runs.repository,
    handler: async ({ run }) => {
      await runs.repository.transition(scope, run.runId, run.revision, "running", "completed", T0, run.fencingToken);
    },
    clock: { now: () => T0 },
    leaseDurationMs: 60_000,
    renewIntervalMs: 20_000,
    scheduler: idleScheduler,
    claimGate: t.gate.claimGateFor(scope)
  });
  assert.equal(await worker.tick(), "paused");
  assert.equal((await runs.repository.findById(scope, "r1"))?.status, "queued");

  // Release needs explicit review, never resumes by itself, and then claims work again.
  assert.deepEqual(await t.control.releaseKillSwitch(t.opsScope, ops, {
    expectedRevision: await t.revision(), reason: "cause reviewed", reviewConfirmed: false
  }), { kind: "invalid", code: "RELEASE_REVIEW_REQUIRED" });
  assert.equal(await worker.tick(), "paused");
  appliedOf(await t.release());
  assert.equal(await worker.tick(), "processed");
  assert.equal((await runs.repository.findById(scope, "r1"))?.status, "completed");

  // pause-intake additionally stops matching: rejected before any candidate lookup.
  const matcherScope = await scopeFor("workspace-a");
  const lookups = { count: 0 };
  const candidates: TriggerCandidateRepository = {
    findEligible: () => { lookups.count += 1; return Promise.resolve([]); }
  };
  const created: MatcherRunRepository = { createIdempotently: () => Promise.resolve("created" as const) };
  const matcher = createTriggerMatcher({
    candidates, runs: created, intakeGate: t.gate.allowsIntake
  });
  appliedOf(await t.engage("pause-intake"));
  const paused = await matcher.match(matcherScope, statusChangedEvent);
  assert.equal(paused.kind, "rejected");
  assert.equal(paused.reason, "intake-paused");
  assert.equal(lookups.count, 0);
  appliedOf(await t.release());
  assert.equal((await matcher.match(matcherScope, statusChangedEvent)).kind, "matched");
  assert.equal(lookups.count, 1);
});

void test("TC-0712 a run already in flight finishes; only new claims stop", async () => {
  const t = await setup();
  await t.openAll();
  const scope = await scopeFor("workspace-worker");
  const runs = createInMemoryRunRepository(resolver.ownsScope);
  await runs.repository.insert(scope, queuedRun("r1"));
  await runs.repository.insert(scope, queuedRun("r2"));

  const worker = createRunWorker({
    scope,
    workerId: "worker-1",
    runs: runs.repository,
    handler: async ({ run }) => {
      // The kill switch is engaged while this run is executing.
      appliedOf(await t.engage("pause-execution"));
      await runs.repository.transition(scope, run.runId, run.revision, "running", "completed", T0, run.fencingToken);
    },
    clock: { now: () => T0 },
    leaseDurationMs: 60_000,
    renewIntervalMs: 20_000,
    scheduler: idleScheduler,
    claimGate: t.gate.claimGateFor(scope)
  });

  assert.equal(await worker.tick(), "processed");
  assert.equal((await runs.repository.findById(scope, "r1"))?.status, "completed");
  assert.equal(await worker.tick(), "paused");
  assert.equal((await runs.repository.findById(scope, "r2"))?.status, "queued");
});

void test("TC-0713 engaging and releasing the kill switch preserves run and action evidence", async () => {
  const t = await setup();
  await t.openAll();
  const scope = await scopeFor("workspace-worker");
  const runs = createInMemoryRunRepository(resolver.ownsScope);
  await runs.repository.insert(scope, queuedRun("r1"));
  await runs.repository.insertActionAttempt(scope, {
    runId: "r1", workspaceId: scope.workspaceId, actionIndex: 0, attempt: 1,
    status: "unknown_outcome", createdAt: T0, updatedAt: T0, actionType: "notification.send"
  });
  const before = {
    run: await runs.repository.findById(scope, "r1"),
    attempts: await runs.repository.listActionAttempts(scope, "r1")
  };

  appliedOf(await t.engage("pause-intake"));
  appliedOf(await t.release());

  assert.deepEqual(await runs.repository.findById(scope, "r1"), before.run);
  assert.deepEqual(await runs.repository.listActionAttempts(scope, "r1"), before.attempts);
  // Releasing does not touch rollout flags: nothing resumes by itself.
  const flags = (await t.store.read()).flags;
  assert.equal(flags.ingest.mode, "all");
  assert.equal(flags.execute.mode, "all");
});

void test("TC-0714 flag and kill-switch changes are permission-checked and audited", async () => {
  const t = await setup(["ops-1:automation.release.flag.write"]);
  const request = {
    flag: "execute" as const, mode: "all" as const, workspaceIds: [], expectedRevision: 0, reason: "go live"
  };

  // Permission-checked: another user, and a permission the operator lacks.
  const stranger: Principal = { type: "user", id: "stranger-1" };
  assert.deepEqual(await t.control.setRollout(t.opsScope, stranger, request), { kind: "denied" });
  assert.deepEqual(await t.control.engageKillSwitch(t.opsScope, ops, {
    mode: "pause-execution", expectedRevision: 0, reason: "incident"
  }), { kind: "denied" });
  assert.equal((await t.store.read()).revision, 0);
  assert.equal((await t.store.read()).flags.execute.mode, "off");
  assert.deepEqual(t.audit.events().map((event) => [event.change, event.outcome, event.actor.id]), [
    ["rollout", "denied", "stranger-1"],
    ["killswitch.engage", "denied", "ops-1"]
  ]);

  // Audited success with the previous and new mode, and no secrets.
  const applied = await t.control.setRollout(t.opsScope, ops, request);
  assert.equal(appliedOf(applied).revision, 1);
  assert.equal(applied.kind === "applied" && applied.audited, true);
  const last = t.audit.events()[2];
  assert.ok(last);
  assert.deepEqual(
    [last.change, last.target, last.outcome],
    ["rollout", "execute", "succeeded"]
  );
  assert.deepEqual(last.details, {
    flag: "execute", fromMode: "off", toMode: "all", cohortSize: 0, reason: "go live", revision: 1
  });

  // Concurrency and validation.
  assert.deepEqual(await t.control.setRollout(t.opsScope, ops, request), { kind: "conflict" });
  const bad = { ...request, expectedRevision: 1 };
  assert.deepEqual(await t.control.setRollout(t.opsScope, ops, { ...bad, reason: "   " }),
    { kind: "invalid", code: "RELEASE_REASON_REQUIRED" });
  assert.deepEqual(await t.control.setRollout(t.opsScope, ops, { ...bad, mode: "cohort", workspaceIds: [] }),
    { kind: "invalid", code: "RELEASE_INVALID_ROLLOUT" });
  assert.deepEqual(await t.control.setRollout(t.opsScope, ops, { ...bad, flag: "nope" as "ingest" }),
    { kind: "invalid", code: "RELEASE_UNKNOWN_FLAG" });
  assert.deepEqual(await t.control.setRollout(t.opsScope, ops, { ...bad, expectedRevision: -1 }),
    { kind: "invalid", code: "RELEASE_INVALID_REVISION" });

  // Principal and scope are checked before anything else.
  const automation: Principal = { type: "automation", id: "automation:a1" };
  assert.deepEqual(await t.control.setRollout(t.opsScope, automation, bad),
    { kind: "invalid", code: "RELEASE_INVALID_PRINCIPAL" });
  const forged = { workspaceId: "workspace-ops" } as unknown as WorkspaceScope;
  assert.deepEqual(await t.control.setRollout(forged, ops, bad),
    { kind: "invalid", code: "RELEASE_SCOPE_MISSING" });
  assert.equal((await t.store.read()).revision, 1);
});

void test("kill switch emergency path is not blocked by a failing audit store", async () => {
  const store = createInMemoryReleaseControlStore(createDefaultReleaseSnapshot(NOW));
  const control = createReleaseControlService({
    ownsScope: resolver.ownsScope,
    store,
    policy: { authorize: () => Promise.resolve(true) },
    audit: { append: () => Promise.reject(new Error("audit down")) },
    clock: { now: () => NOW },
    rng: { nextId: () => "corr-x" }
  });
  const scope = await scopeFor("workspace-ops");
  const result = await control.engageKillSwitch(scope, ops, {
    mode: "pause-execution", expectedRevision: 0, reason: "incident"
  });
  assert.equal(result.kind === "applied" && result.audited, false);
  assert.equal((await store.read()).killSwitch.engaged, true);

  assert.deepEqual(await control.releaseKillSwitch(scope, ops, {
    expectedRevision: 0, reason: "stale", reviewConfirmed: true
  }), { kind: "conflict" });
  const idle = createInMemoryReleaseControlStore(createDefaultReleaseSnapshot(NOW));
  const other = createReleaseControlService({
    ownsScope: resolver.ownsScope, store: idle, policy: { authorize: () => Promise.resolve(true) },
    audit: { append: () => Promise.resolve() }, clock: { now: () => NOW }, rng: { nextId: () => "c" }
  });
  assert.deepEqual(await other.releaseKillSwitch(scope, ops, {
    expectedRevision: 0, reason: "nothing to release", reviewConfirmed: true
  }), { kind: "not-engaged" });
});

void test("stale flag definitions are reported", () => {
  assert.deepEqual(findExpiredFlagDefinitions(NOW), []);
  assert.deepEqual(findExpiredFlagDefinitions("2030-01-01T00:00:00.000Z"), ["ingest", "execute"]);
  assert.deepEqual(findExpiredFlagDefinitions("not-a-date"), ["ingest", "execute"]);
});