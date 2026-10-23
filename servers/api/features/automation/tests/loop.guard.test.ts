import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  analyzeAuthoringLoops,
  createInMemoryChainBudget,
  createInMemoryLoopTelemetry,
  createLoopGuard,
  type ChainBudgetPort,
  type LoopDecision,
  type LoopGuardInput
} from "../loop.guard.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const input = (
  automationId: string,
  origin: LoopGuardInput["origin"],
  chainKey = "chain-1"
): LoopGuardInput => Object.freeze({
  workspaceId: "workspace-a",
  automationId,
  eventId: `event-${automationId}`,
  chainKey,
  origin
});

const blockOf = (decision: LoopDecision) => {
  if (decision.kind !== "block") throw new Error("Expected a block decision.");
  return decision;
};

const build = (limits?: { maxHops: number; maxRunsPerChain: number }) => {
  const store = createInMemoryChainBudget(resolver.ownsScope);
  const recorder = createInMemoryLoopTelemetry();
  const guard = createLoopGuard({
    ownsScope: resolver.ownsScope,
    budget: store.budget,
    telemetry: recorder.telemetry,
    ...(limits ? { limits } : {})
  });
  return { guard, store, recorder };
};

void test("TC-0411 simple self-loop is detected at runtime and at authoring", async () => {
  const scope = await scopeFor("workspace-a");
  const { guard } = build();
  const decision = blockOf(await guard.evaluate(
    scope,
    input("auto-1", { automationId: "auto-1", runId: "run-1", hop: 1 })
  ));
  assert.equal(decision.code, "SELF_TRIGGER");
  assert.equal(decision.retryable, false);

  const issues = analyzeAuthoringLoops([{
    automationId: "auto-1",
    triggerType: "task.status_changed",
    emittedEventTypes: ["task.status_changed"],
    allowsAutomationOrigin: true
  }]);
    assert.deepEqual(issues, [
    { severity: "error", code: "SELF_CYCLE", automationIds: ["auto-1"] }
  ]);
});

void test("TC-0411 authoring: indirect cycle warns, and no opt-in means no cycle", () => {
  const nodes = (allowsB: boolean) => [
    { automationId: "a", triggerType: "t.a", emittedEventTypes: ["t.b"], allowsAutomationOrigin: true },
    { automationId: "b", triggerType: "t.b", emittedEventTypes: ["t.a"], allowsAutomationOrigin: allowsB }
  ];
  const warned = analyzeAuthoringLoops(nodes(true));
    assert.deepEqual(warned, [
    { severity: "warning", code: "INDIRECT_CYCLE", automationIds: ["a", "b"] }
  ]);

  // Automation-origin events cannot trigger b (spec D-13), so there is no runtime cycle.
  assert.deepEqual(analyzeAuthoringLoops(nodes(false)), []);
});

void test("TC-0412 legitimate bounded chain succeeds", async () => {
  const scope = await scopeFor("workspace-a");
  const { guard, store, recorder } = build();
  const first = await guard.evaluate(scope, input("auto-a", undefined));
  const second = await guard.evaluate(scope, input("auto-b", { automationId: "auto-a", runId: "run-a", hop: 1 }));
  const third = await guard.evaluate(scope, input("auto-c", { automationId: "auto-b", runId: "run-b", hop: 2 }));

  assert.deepEqual(first, { kind: "allow", hop: 0 });
  assert.deepEqual(second, { kind: "allow", hop: 1 });
  assert.deepEqual(third, { kind: "allow", hop: 2 });
  assert.equal(store.used("workspace-a", "chain-1"), 3);
  assert.equal(recorder.signals().length, 0);
});

void test("TC-0413 hop limit terminates further runs, exact boundary is allowed", async () => {
  const scope = await scopeFor("workspace-a");
  const { guard } = build({ maxHops: 5, maxRunsPerChain: 100 });
  const at = (hop: number) => guard.evaluate(
    scope,
    input("auto-z", { automationId: "auto-y", runId: "run-y", hop }, `chain-hop-${String(hop)}`)
  );
  assert.equal((await at(5)).kind, "allow");
  assert.equal(blockOf(await at(6)).code, "HOP_LIMIT_EXCEEDED");
});

void test("TC-0413 chain budget stops fan-out and blocked runs spend nothing", async () => {
  const scope = await scopeFor("workspace-a");
  const { guard, store } = build({ maxHops: 5, maxRunsPerChain: 2 });
  assert.equal((await guard.evaluate(scope, input("auto-1", undefined))).kind, "allow");
  assert.equal((await guard.evaluate(scope, input("auto-2", undefined))).kind, "allow");
  assert.equal(blockOf(await guard.evaluate(scope, input("auto-3", undefined))).code, "CHAIN_BUDGET_EXCEEDED");
  assert.equal(store.used("workspace-a", "chain-1"), 2);
  // A different chain keeps its own budget.
  assert.equal((await guard.evaluate(scope, input("auto-1", undefined, "chain-2"))).kind, "allow");
});

void test("TC-0414 breaker records an actionable reason without payload data", async () => {
  const scope = await scopeFor("workspace-a");
  const { guard, recorder } = build({ maxHops: 1, maxRunsPerChain: 10 });
  await guard.evaluate(scope, input("auto-1", { automationId: "auto-1", runId: "run-1", hop: 1 }));
  await guard.evaluate(scope, input("auto-2", { automationId: "auto-1", runId: "run-1", hop: 2 }));

  const signals = recorder.signals();
  assert.equal(signals.length, 2);
  assert.deepEqual(signals.map((signal) => signal.code), ["SELF_TRIGGER", "HOP_LIMIT_EXCEEDED"]);
  for (const signal of signals) {
    assert.ok(signal.message.length > 0);
    assert.deepEqual(Object.keys(signal).sort(), ["automationId", "code", "eventId", "hop", "message", "workspaceId"]);
  }
  assert.deepEqual(recorder.countsByCode(), { SELF_TRIGGER: 1, HOP_LIMIT_EXCEEDED: 1 });
});

void test("loop guard fails closed: forged scope, bad lineage, budget outage, telemetry failure", async () => {
  const scope = await scopeFor("workspace-a");
  let budgetCalls = 0;
  const countingBudget: ChainBudgetPort = {
    consume: () => {
      budgetCalls += 1;
      return Promise.reject(new Error("db down"));
    }
  };
  const recorder = createInMemoryLoopTelemetry();
  const guard = createLoopGuard({ ownsScope: resolver.ownsScope, budget: countingBudget, telemetry: recorder.telemetry });

  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  assert.equal(blockOf(await guard.evaluate(forged, input("auto-1", undefined))).code, "SCOPE_MISSING");
  assert.equal(blockOf(await guard.evaluate(scope, { ...input("auto-1", undefined), workspaceId: "workspace-b" })).code, "SCOPE_MISSING");
  assert.equal(blockOf(await guard.evaluate(scope, input("auto-1", { automationId: "x", runId: "r", hop: 0 }))).code, "LINEAGE_INVALID");
  assert.equal(blockOf(await guard.evaluate(scope, input("auto-1", { automationId: "x", runId: "r", hop: 1.5 }))).code, "LINEAGE_INVALID");
  assert.equal(budgetCalls, 0);

  const outage = blockOf(await guard.evaluate(scope, input("auto-1", undefined)));
  assert.equal(outage.code, "BUDGET_UNAVAILABLE");
  assert.equal(outage.retryable, true);

  const throwingTelemetry = createLoopGuard({
    ownsScope: resolver.ownsScope,
    budget: createInMemoryChainBudget(resolver.ownsScope).budget,
    telemetry: { tripped: () => { throw new Error("sink down"); } },
    limits: { maxHops: 1, maxRunsPerChain: 5 }
  });
  assert.equal(blockOf(await throwingTelemetry.evaluate(
    scope,
    input("auto-2", { automationId: "auto-2", runId: "run-2", hop: 1 })
  )).code, "SELF_TRIGGER");

  assert.throws(() => createLoopGuard({
    ownsScope: resolver.ownsScope,
    budget: countingBudget,
    telemetry: recorder.telemetry,
    limits: { maxHops: 0, maxRunsPerChain: 5 }
  }));
});

void test("in-memory chain budget is atomic under concurrent callers and scope-checked", async () => {
  const scope = await scopeFor("workspace-a");
  const store = createInMemoryChainBudget(resolver.ownsScope);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => store.budget.consume(scope, "chain-race", 5))
  );
  assert.equal(results.filter((result) => result.allowed).length, 5);
  assert.equal(store.used("workspace-a", "chain-race"), 5);
  await assert.rejects(store.budget.consume({ workspaceId: "workspace-a" } as unknown as WorkspaceScope, "c", 5));
});