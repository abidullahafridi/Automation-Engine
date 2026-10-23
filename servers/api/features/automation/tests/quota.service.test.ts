import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  createInMemoryQuotaCounters,
  createInMemoryQuotaTelemetry,
  createQuotaService,
  type QuotaConfig,
  type QuotaCounterPort,
  type QuotaDecision,
  type QuotaOverridePort,
  type QuotaTelemetry
} from "../quota.service.js";
import { createWorkspaceConcurrencyGate } from "../workspace.concurrency.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const limits = (workspaceLimit: number, globalLimit: number) =>
  ({ windowMs: 60_000, workspaceLimit, globalLimit });

const configOf = (workspaceLimit: number, globalLimit: number): QuotaConfig => ({
  events: limits(workspaceLimit, globalLimit),
  runs: limits(workspaceLimit, globalLimit)
});

const createClock = (initial: string) => {
  let current = initial;
  return {
    clock: { now: (): string => current },
    set: (next: string): void => { current = next; }
  };
};

const build = (options: Readonly<{
  config: QuotaConfig;
  overrides?: QuotaOverridePort;
  counters?: QuotaCounterPort;
  telemetry?: QuotaTelemetry;
  start?: string;
}>) => {
  const store = createInMemoryQuotaCounters(resolver.ownsScope);
  const recorder = createInMemoryQuotaTelemetry();
  const time = createClock(options.start ?? "2026-10-15T12:00:30.000Z");
  const service = createQuotaService({
    ownsScope: resolver.ownsScope,
    counters: options.counters ?? store.counters,
    clock: time.clock,
    telemetry: options.telemetry ?? recorder.telemetry,
    config: options.config,
    ...(options.overrides ? { overrides: options.overrides } : {})
  });
  return { service, store, recorder, time };
};

const denyOf = (decision: QuotaDecision) => {
  if (decision.kind !== "deny") throw new Error("Expected a deny decision.");
  return decision;
};

const usedOf = (decision: QuotaDecision): number => (decision.kind === "allow" ? decision.used : -1);

void test("TC-0415 quota within limit succeeds and warns once at 80%", async () => {
  const scope = await scopeFor("workspace-a");
  const { service, store, recorder } = build({ config: configOf(5, 100) });
  const decisions: QuotaDecision[] = [];
  for (let index = 0; index < 5; index += 1) decisions.push(await service.admit(scope, "runs"));

  assert.deepEqual(decisions.map(usedOf), [1, 2, 3, 4, 5]);
  assert.equal(store.used("workspace-a", "runs:workspace"), 5);
  assert.deepEqual(recorder.nearLimits(), [{ kind: "runs", workspaceId: "workspace-a", used: 4, limit: 5 }]);
  assert.deepEqual(recorder.rejections(), []);
});

void test("TC-0416 excess gets controlled backpressure, denied calls spend nothing, next window recovers", async () => {
  const scope = await scopeFor("workspace-a");
  const { service, store, recorder, time } = build({ config: configOf(5, 100) });
  for (let index = 0; index < 5; index += 1) await service.admit(scope, "runs");

  const denied = denyOf(await service.admit(scope, "runs"));
  assert.equal(denied.code, "WORKSPACE_QUOTA_EXCEEDED");
  assert.equal(denied.retryable, true);
  assert.equal(denied.retryAfterMs, 30_000);
  assert.ok(denied.message.length > 0);
  assert.equal(store.used("workspace-a", "runs:workspace"), 5);
  assert.deepEqual(recorder.countsByCode(), { WORKSPACE_QUOTA_EXCEEDED: 1 });

  time.set("2026-10-15T12:01:00.000Z");
  assert.equal(usedOf(await service.admit(scope, "runs")), 1);
});

void test("TC-0417 one workspace cannot consume another workspace's share", async () => {
  const scopeA = await scopeFor("workspace-a");
  const scopeB = await scopeFor("workspace-b");
  const { service, store } = build({ config: configOf(5, 10) });

  for (let index = 0; index < 5; index += 1) await service.admit(scopeA, "runs");
  assert.equal(denyOf(await service.admit(scopeA, "runs")).code, "WORKSPACE_QUOTA_EXCEEDED");
  // A's rejected attempts did not touch the global counter.
  assert.equal(store.usedGlobal("runs:global"), 5);

  const decisions: QuotaDecision[] = [];
  for (let index = 0; index < 5; index += 1) decisions.push(await service.admit(scopeB, "runs"));
  assert.deepEqual(decisions.map(usedOf), [1, 2, 3, 4, 5]);
});

void test("TC-0417 global saturation denies and refunds the workspace unit", async () => {
  const scopeA = await scopeFor("workspace-a");
  const scopeB = await scopeFor("workspace-b");
  const scopeC = await scopeFor("workspace-c");
  const { service, store } = build({ config: configOf(3, 4) });

  for (let index = 0; index < 3; index += 1) await service.admit(scopeA, "runs");
  assert.equal(usedOf(await service.admit(scopeB, "runs")), 1);

  // Global capacity (4) is now full. C is denied globally and its workspace unit is refunded.
  assert.equal(denyOf(await service.admit(scopeC, "runs")).code, "GLOBAL_QUOTA_EXCEEDED");
  assert.equal(store.used("workspace-a", "runs:workspace"), 3);
  assert.equal(store.used("workspace-b", "runs:workspace"), 1);
  assert.equal(store.used("workspace-c", "runs:workspace"), 0);
  assert.equal(store.usedGlobal("runs:global"), 4);
});

void test("TC-0417 worker capacity: a noisy workspace cannot starve a quiet one", () => {
  const gate = createWorkspaceConcurrencyGate({ maxPerWorkspace: 2, maxTotal: 4 });
  const picks: (string | undefined)[] = [];
  for (let index = 0; index < 5; index += 1) picks.push(gate.acquireFair(["a", "b"]));
  assert.deepEqual(picks, ["a", "b", "a", "b", undefined]);

  const noisy = createWorkspaceConcurrencyGate({ maxPerWorkspace: 2, maxTotal: 10 });
  assert.equal(noisy.acquireFair(["noisy"]), "noisy");
  assert.equal(noisy.acquireFair(["noisy"]), "noisy");
  assert.equal(noisy.acquireFair(["noisy"]), undefined);
  assert.equal(noisy.acquireFair(["noisy", "quiet"]), "quiet");

    noisy.release("noisy");
  assert.equal(noisy.inFlight("noisy"), 1);
  assert.equal(noisy.inFlight("quiet"), 1);
  assert.equal(noisy.totalInFlight(), 2);
  noisy.release("unknown");
  assert.equal(noisy.totalInFlight(), 2);
  assert.equal(noisy.acquire(""), false);
  assert.throws(() => createWorkspaceConcurrencyGate({ maxPerWorkspace: 5, maxTotal: 2 }));
});

void test("TC-0418 counters stay exact under concurrent admissions", async () => {
  const scope = await scopeFor("workspace-a");
  const single = build({ config: configOf(5, 100) });
  const results = await Promise.all(Array.from({ length: 50 }, () => single.service.admit(scope, "runs")));
  assert.equal(results.filter((item) => item.kind === "allow").length, 5);
  assert.equal(single.store.used("workspace-a", "runs:workspace"), 5);
  assert.equal(single.store.usedGlobal("runs:global"), 5);

  const scopeB = await scopeFor("workspace-b");
  const shared = build({ config: configOf(5, 8) });
  const both = await Promise.all([
    ...Array.from({ length: 30 }, () => shared.service.admit(scope, "runs")),
    ...Array.from({ length: 30 }, () => shared.service.admit(scopeB, "runs"))
  ]);
  assert.equal(both.filter((item) => item.kind === "allow").length, 8);
  assert.equal(shared.store.usedGlobal("runs:global"), 8);
  assert.equal(
    shared.store.used("workspace-a", "runs:workspace") + shared.store.used("workspace-b", "runs:workspace"),
    8
  );
});

void test("admin override is bounded and never trusted blindly", async () => {
  const scope = await scopeFor("workspace-a");
  const withOverride = (value: () => Promise<number | undefined>) => build({
    config: configOf(5, 10),
    overrides: { workspaceLimit: value }
  });

  const lowered = withOverride(() => Promise.resolve(2));
  const first = await lowered.service.admit(scope, "runs");
  assert.equal(first.kind === "allow" && first.overrideApplied, true);
  await lowered.service.admit(scope, "runs");
  assert.equal(denyOf(await lowered.service.admit(scope, "runs")).code, "WORKSPACE_QUOTA_EXCEEDED");

  for (const bad of [999, 0, -3, 1.5]) {
    const ignored = withOverride(() => Promise.resolve(bad));
    const decision = await ignored.service.admit(scope, "runs");
    assert.equal(decision.kind === "allow" && decision.overrideApplied, false);
    assert.equal(decision.kind === "allow" && decision.limit, 5);
  }

  const failing = withOverride(() => Promise.reject(new Error("store down")));
  const fallback = await failing.service.admit(scope, "runs");
  assert.equal(fallback.kind === "allow" && fallback.limit, 5);
});

void test("quota fails closed: forged scope, storage outage, bad clock, bad config, telemetry failure", async () => {
  const scope = await scopeFor("workspace-a");
  const base = build({ config: configOf(5, 10) });

  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  const scopeDenied = denyOf(await base.service.admit(forged, "runs"));
  assert.equal(scopeDenied.code, "SCOPE_MISSING");
  assert.equal(scopeDenied.retryable, false);
  assert.equal(base.store.usedGlobal("runs:global"), 0);

  const down: QuotaCounterPort = {
    consume: () => Promise.reject(new Error("db down")),
    consumeGlobal: () => Promise.reject(new Error("db down")),
    refund: () => Promise.reject(new Error("db down"))
  };
  const outage = denyOf(await build({ config: configOf(5, 10), counters: down }).service.admit(scope, "runs"));
  assert.equal(outage.code, "QUOTA_UNAVAILABLE");
  assert.equal(outage.retryable, true);

  const globalDown = build({ config: configOf(5, 10) });
  const partial: QuotaCounterPort = {
    consume: globalDown.store.counters.consume,
    consumeGlobal: () => Promise.reject(new Error("db down")),
    refund: globalDown.store.counters.refund
  };
  const refunded = build({ config: configOf(5, 10), counters: partial });
  assert.equal(denyOf(await refunded.service.admit(scope, "runs")).code, "QUOTA_UNAVAILABLE");

  const badClock = build({ config: configOf(5, 10), start: "not-a-date" });
  assert.equal(denyOf(await badClock.service.admit(scope, "runs")).code, "QUOTA_UNAVAILABLE");

  assert.throws(() => build({ config: configOf(0, 10) }));
  assert.throws(() => build({ config: configOf(20, 10) }));

  const noisyTelemetry = build({
    config: configOf(1, 10),
    telemetry: {
      rejected: () => { throw new Error("sink down"); },
      nearLimit: () => { throw new Error("sink down"); }
    }
  });
  await noisyTelemetry.service.admit(scope, "runs");
  assert.equal(denyOf(await noisyTelemetry.service.admit(scope, "runs")).code, "WORKSPACE_QUOTA_EXCEEDED");
});