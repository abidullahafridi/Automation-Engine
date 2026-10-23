import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { PublishedAutomationVersion } from "../automation.repository.js";
import {
  createInMemoryChainBudget,
  createInMemoryLoopTelemetry,
  createLoopGuard,
  type ChainBudgetPort
} from "../loop.guard.js";
import {
  createInMemoryQuotaCounters,
  createInMemoryQuotaTelemetry,
  createQuotaService,
  type QuotaConfig
} from "../quota.service.js";
import {
  createTriggerMatcher,
  type AutomationRun,
  type MatcherRunRepository,
  type RunProtection,
  type TriggerCandidate,
  type TriggerCandidateRepository
} from "../trigger.matcher.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const rule = (allowAutomationOrigin: boolean) => ({
  schemaVersion: 1,
  name: "Notify",
  trigger: { type: "task.status_changed", config: { toStatus: "done", allowAutomationOrigin } },
  conditions: { all: [{ field: "task.isArchived", op: "eq", value: false }] },
  actions: [],
  executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
});

const candidate = (automationId: string, allowAutomationOrigin = false): TriggerCandidate => ({
  automationId,
  createdBy: "creator-1",
  version: {
    automationId,
    workspaceId: "workspace-a",
    version: 1,
    schemaVersion: 1,
    contentHash: "hash-1",
    publishKey: `publish-${automationId}`,
    rule: rule(allowAutomationOrigin) as unknown as PublishedAutomationVersion["rule"],
    createdAt: "2026-10-15T12:00:00.000Z"
  }
});

const userEvent = (eventId = "evt-1") => ({
  eventId,
  eventType: "task.status_changed",
  schemaVersion: 1,
  occurredAt: "2026-10-15T12:00:00.000Z",
  workspaceId: "workspace-a",
  correlationId: "corr-1",
  actor: { type: "user", id: "user-1" },
  aggregate: { type: "task", id: "task-1" },
  payload: { task: { status: "done", previousStatus: "open", priority: "high", isArchived: false } }
});

const automationEvent = (hop: number, originAutomationId: string) => ({
  ...userEvent("evt-auto"),
  actor: { type: "automation", id: `automation:${originAutomationId}` },
  origin: { automationId: originAutomationId, runId: "run-0", hop }
});

const candidatesOf = (
  items: readonly TriggerCandidate[],
  calls: { count: number }
): TriggerCandidateRepository => ({
  findEligible: () => {
    calls.count += 1;
    return Promise.resolve(items);
  }
});

const makeRuns = (existing: ReadonlySet<string> = new Set<string>()) => {
  const created: AutomationRun[] = [];
  const runs: MatcherRunRepository = {
    createIdempotently: (_scope, run) => {
      created.push(run);
      return Promise.resolve("created" as const);
    },
    exists: (_scope, runId) => Promise.resolve(existing.has(runId))
  };
  return { runs, created };
};

const protectionOf = (config: QuotaConfig) => {
  const counters = createInMemoryQuotaCounters(resolver.ownsScope);
  const chain = createInMemoryChainBudget(resolver.ownsScope);
  const loopSignals = createInMemoryLoopTelemetry();
  const quotaSignals = createInMemoryQuotaTelemetry();
  const protection: RunProtection = {
    loopGuard: createLoopGuard({
      ownsScope: resolver.ownsScope,
      budget: chain.budget,
      telemetry: loopSignals.telemetry
    }),
    quota: createQuotaService({
      ownsScope: resolver.ownsScope,
      counters: counters.counters,
      clock: { now: () => "2026-10-15T12:00:30.000Z" },
      telemetry: quotaSignals.telemetry,
      config
    })
  };
  return { protection, chain, loopSignals, quotaSignals };
};

const roomy: QuotaConfig = {
  events: { windowMs: 60_000, workspaceLimit: 100, globalLimit: 1_000 },
  runs: { windowMs: 60_000, workspaceLimit: 100, globalLimit: 1_000 }
};

void test("without protection the matcher behaves exactly as before", async () => {
  const scope = await scopeFor("workspace-a");
  const calls = { count: 0 };
  const { runs, created } = makeRuns();
  const matcher = createTriggerMatcher({ candidates: candidatesOf([candidate("auto-1")], calls), runs });
  const result = await matcher.match(scope, userEvent());
  assert.deepEqual(result, { kind: "matched", candidateCount: 1, createdRuns: 1, idempotentRuns: 0 });
  assert.deepEqual(created.map((run) => run.chainKey), [undefined]);
});

void test("with protection a run is created with causation lineage", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns();
  const { protection, chain } = protectionOf(roomy);
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-1")], { count: 0 }),
    runs,
    protection
  });
  const result = await matcher.match(scope, userEvent());
  assert.deepEqual(result, { kind: "matched", candidateCount: 1, createdRuns: 1, idempotentRuns: 0 });
  assert.deepEqual(created.map((run) => [run.chainKey, run.hop]), [["corr-1", 0]]);
  assert.equal(chain.used("workspace-a", "corr-1"), 1);
});

void test("event quota exhaustion rejects before any candidate lookup", async () => {
  const scope = await scopeFor("workspace-a");
  const calls = { count: 0 };
  const { runs } = makeRuns();
  const { protection } = protectionOf({
    events: { windowMs: 60_000, workspaceLimit: 2, globalLimit: 100 },
    runs: roomy.runs
  });
  const matcher = createTriggerMatcher({ candidates: candidatesOf([candidate("auto-1")], calls), runs, protection });
  await matcher.match(scope, userEvent("evt-1"));
  await matcher.match(scope, userEvent("evt-2"));
  const rejected = await matcher.match(scope, userEvent("evt-3"));
  assert.equal(rejected.kind, "rejected");
  assert.equal(rejected.reason, "quota-exceeded");
  assert.equal(rejected.retryAfterMs, 30_000);
  assert.equal(calls.count, 2);
});

void test("run quota defers extra runs with backpressure and does not touch chain budget", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns();
  const { protection, chain } = protectionOf({
    events: roomy.events,
    runs: { windowMs: 60_000, workspaceLimit: 1, globalLimit: 100 }
  });
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-1"), candidate("auto-2")], { count: 0 }),
    runs,
    protection
  });
  const result = await matcher.match(scope, userEvent());
  assert.equal(result.kind, "matched");
  assert.equal(result.createdRuns, 1);
  assert.equal(result.quotaRejectedRuns, 1);
  assert.equal(result.retryAfterMs, 30_000);
  assert.equal(created.length, 1);
  assert.equal(chain.used("workspace-a", "corr-1"), 1);
});

void test("loop protection blocks self-trigger and invalid lineage before a run exists", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns();
  const { protection, loopSignals } = protectionOf(roomy);
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-1", true)], { count: 0 }),
    runs,
    protection
  });

  const selfTrigger = await matcher.match(scope, automationEvent(1, "auto-1"));
  assert.equal(selfTrigger.createdRuns, 0);
  assert.equal(selfTrigger.blockedRuns, 1);

  const invalidLineage = await matcher.match(scope, automationEvent(0, "auto-2"));
  assert.equal(invalidLineage.blockedRuns, 1);

    assert.deepEqual(
    created.map((run) => [run.status, run.skipReason]),
    [["skipped", "SELF_TRIGGER"], ["skipped", "LINEAGE_INVALID"]]
  );
  assert.deepEqual(loopSignals.signals().map((signal) => signal.code), ["SELF_TRIGGER", "LINEAGE_INVALID"]);
});

void test("a legitimate chained event is allowed with its hop recorded", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns();
  const { protection } = protectionOf(roomy);
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-2", true)], { count: 0 }),
    runs,
    protection
  });
  const result = await matcher.match(scope, automationEvent(2, "auto-1"));
  assert.equal(result.createdRuns, 1);
  assert.deepEqual(created.map((run) => run.hop), [2]);
});

void test("redelivery of an existing run spends no chain budget", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns(new Set(["evt-1:auto-1:1"]));
  const { protection, chain } = protectionOf(roomy);
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-1")], { count: 0 }),
    runs,
    protection
  });
  const result = await matcher.match(scope, userEvent());
  assert.deepEqual(result, { kind: "matched", candidateCount: 1, createdRuns: 0, idempotentRuns: 1 });
  assert.equal(created.length, 0);
  assert.equal(chain.used("workspace-a", "corr-1"), 0);
});

void test("protection without an exists check is refused at construction", () => {
  const { protection } = protectionOf(roomy);
  const runs: MatcherRunRepository = { createIdempotently: () => Promise.resolve("created" as const) };
  assert.throws(() => createTriggerMatcher({
    candidates: candidatesOf([], { count: 0 }),
    runs,
    protection
  }));
});

void test("an infrastructure fault in loop protection is not recorded as a permanent skip", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns();
  const failing: ChainBudgetPort = { consume: () => Promise.reject(new Error("db down")) };
  const base = protectionOf(roomy);
  const protection: RunProtection = {
    quota: base.protection.quota,
    loopGuard: createLoopGuard({
      ownsScope: resolver.ownsScope,
      budget: failing,
      telemetry: base.loopSignals.telemetry
    })
  };
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-1")], { count: 0 }),
    runs,
    protection
  });
  const result = await matcher.match(scope, userEvent());
  assert.equal(result.blockedRuns, 1);
  assert.equal(result.createdRuns, 0);
  assert.equal(created.length, 0);
});

void test("trace context is copied to the run and runs are reported to telemetry", async () => {
  const scope = await scopeFor("workspace-a");
  const { runs, created } = makeRuns();
  const recorded: string[] = [];
  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const matcher = createTriggerMatcher({
    candidates: candidatesOf([candidate("auto-1")], { count: 0 }),
    runs,
    telemetry: { recordRun: (status, triggerType) => { recorded.push(`${status}:${triggerType}`); } }
  });
  const result = await matcher.match(scope, { ...userEvent(), traceparent });
  assert.equal(result.createdRuns, 1);
  assert.deepEqual(created.map((run) => run.traceparent), [traceparent]);
  assert.deepEqual(recorded, ["queued:task.status_changed"]);

  const invalid = await matcher.match(scope, { ...userEvent("evt-2"), traceparent: "garbage" });
  assert.equal(invalid.reason, "invalid-event");
});