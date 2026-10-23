import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPrincipalResolver, type Principal, type WorkspaceScope } from "../automation.ports.js";
import type { AutomationHeader } from "../automation.repository.js";
import {
  createActionRegistry,
  notificationSendAction,
  type ActionRegistry
} from "../automation.registry.js";
import { createDeadLetterService, createInMemoryRecoveryAuditStore } from "../dead-letter.service.js";
import { decideRetry, defaultRetryPolicy } from "../retry.policy.js";
import { createInMemoryOutboxRepository } from "../outbox.repository.js";
import {
  alertRuleIds,
  alertRules,
  createAlertThresholds
} from "../ops.alerts.js";
import {
  criticalMetricNames,
  dashboardPanels,
  findAlertRulesWithoutPanel,
  findInvalidPanels,
  findUncoveredMetrics
} from "../ops.dashboard.js";
import { createOpsMonitor, type AlertTransition } from "../ops.monitor.js";
import { createDlqRunbook } from "../ops.runbook.js";
import { createOutboxHealthSource, type OpsSignalSources } from "../ops.signals.js";
import { createInMemoryRunHistoryRepository } from "../run.history.repository.js";
import { createRunHistoryService } from "../run.history.service.js";
import type { StoredRun } from "../run.repository.js";
import { metricCatalog } from "../telemetry.metrics.js";
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

const T0 = "2026-10-20T10:00:00.000Z";
const at = (milliseconds: number): string => new Date(Date.parse(T0) + milliseconds).toISOString();

const thresholds = createAlertThresholds({
  queueAgeMs: { warning: 60_000, critical: 300_000 },
  leaseStalledCount: { warning: 1, critical: 5 },
  outboxAgeMs: { warning: 60_000, critical: 300_000 },
  deadLetter: { warningCount: 5, criticalCount: 20, warningAgeMs: 60_000, criticalAgeMs: 600_000 }
});

const recordingSink = () => {
  const sent: AlertTransition[] = [];
  return {
    sent,
    sink: {
      notify: (transition: AlertTransition): Promise<void> => {
        sent.push(transition);
        return Promise.resolve();
      }
    }
  };
};

const monitorFor = (
  sources: OpsSignalSources,
  sink: { notify: (transition: AlertTransition) => Promise<void> },
  state: { now: string }
) => createOpsMonitor({
  ownsScope: resolver.ownsScope,
  sources,
  thresholds,
  sink,
  clock: { now: () => state.now }
});

void test("TC-0715 a simulated outbox stall fires an alert, escalates, and resolves after recovery", async () => {
  const scope = await scopeFor("workspace-ops");
  const outbox = createInMemoryOutboxRepository(resolver.ownsScope);
  await outbox.repository.insertPending(scope, {
    outboxId: "o1",
    workspaceId: "workspace-ops",
    eventType: "task.status_changed",
    payload: {},
    createdAt: T0
  }, undefined);

  const { sent, sink } = recordingSink();
  const state = { now: at(30_000) };
  const monitor = monitorFor({ outbox: createOutboxHealthSource(outbox.repository) }, sink, state);

  const quiet = await monitor.tick(scope);
  assert.deepEqual(quiet.evaluation.alerts, []);
  assert.deepEqual(quiet.evaluation.unmonitored, ["queue", "deadLetter", "tenantScope"]);

  state.now = at(120_000);
  const warning = await monitor.tick(scope);
  assert.deepEqual(warning.transitions.map((item) => [item.kind, item.alert.ruleId, item.alert.level]), [
    ["firing", "OUTBOX_STALLED", "warning"]
  ]);
  const fired = warning.transitions[0];
  assert.ok(fired);
  assert.equal(fired.alert.value, 120_000);
  assert.equal(fired.alert.threshold, 60_000);
  assert.equal(fired.alert.owner, "Abid Ullah");
  assert.equal(fired.alert.runbook, "operations-runbooks.md#outbox-stall");
  assert.equal(fired.alert.panelId, "outbox-age");

  // Same fault, same level: deduplicated.
  assert.deepEqual((await monitor.tick(scope)).transitions, []);

  state.now = at(600_000);
  const critical = await monitor.tick(scope);
  assert.deepEqual(critical.transitions.map((item) => [item.kind, item.alert.level]), [["firing", "critical"]]);

  // Recovery: the relay publishes the event.
  await outbox.repository.markPublished(scope, "o1", state.now);
  const recovered = await monitor.tick(scope);
  assert.deepEqual(recovered.transitions.map((item) => [item.kind, item.alert.ruleId]), [
    ["resolved", "OUTBOX_STALLED"]
  ]);
  assert.deepEqual(sent.map((item) => item.kind), ["firing", "firing", "resolved"]);
});

void test("TC-0715 every simulated fault maps to its rule, level, owner and runbook", async () => {
  const scope = await scopeFor("workspace-ops");
  const { sink } = recordingSink();
  const monitor = monitorFor({
    queue: () => Promise.resolve({ queuedCount: 9, oldestEligibleAgeMs: 400_000, expiredRunningCount: 2 }),
    outbox: () => Promise.resolve({ pendingCount: 0, oldestPendingAgeMs: undefined }),
    deadLetter: () => Promise.resolve({ count: 25, oldestAgeMs: 1_000 }),
    tenantScope: () => Promise.resolve(1)
  }, sink, { now: T0 });

  const { evaluation } = await monitor.tick(scope);
  assert.deepEqual(evaluation.alerts.map((item) => [item.ruleId, item.level]), [
    ["QUEUE_AGE", "critical"],
    ["LEASE_STALLED", "warning"],
    ["DEAD_LETTER_BACKLOG", "critical"],
    ["TENANT_SCOPE_VIOLATION", "critical"]
  ]);
  assert.deepEqual(evaluation.unmonitored, []);
  for (const alert of evaluation.alerts) {
    assert.equal(alert.owner, "Abid Ullah");
    assert.equal(alert.runbook, alertRules[alert.ruleId].runbook);
  }
  const dlq = evaluation.alerts.find((item) => item.ruleId === "DEAD_LETTER_BACKLOG");
  assert.deepEqual(dlq?.reasons, ["COUNT"]);

  const healthy = monitorFor({
    queue: () => Promise.resolve({ queuedCount: 3, oldestEligibleAgeMs: undefined, expiredRunningCount: 0 }),
    deadLetter: () => Promise.resolve({ count: 0, oldestAgeMs: undefined }),
    tenantScope: () => Promise.resolve(0)
  }, sink, { now: T0 });
  assert.deepEqual((await healthy.tick(scope)).evaluation.alerts, []);
});

void test("a failing signal source is an alert, not silence; a failing sink is retried", async () => {
  const scope = await scopeFor("workspace-ops");
  const failingSink = { notify: () => Promise.reject(new Error("pager down")) };
  const state = { now: T0 };
  const sources: OpsSignalSources = {
    outbox: () => Promise.reject(new Error("db down")),
    tenantScope: () => Promise.resolve(-1)
  };

  const first = await monitorFor(sources, failingSink, state).tick(scope);
  assert.deepEqual(first.evaluation.alerts.map((item) => item.dedupeKey), [
    "SIGNAL_UNAVAILABLE:outbox",
    "SIGNAL_UNAVAILABLE:tenantScope"
  ]);
  assert.equal(first.sinkFailures, 2);
  assert.deepEqual(first.transitions, []);

  // Not recorded as delivered, so the next tick delivers it.
  const { sent, sink } = recordingSink();
  const monitor = monitorFor(sources, failingSink, state);
  await monitor.tick(scope);
  const retried = monitorFor(sources, sink, state);
  await retried.tick(scope);
  assert.equal(sent.length, 2);

  const forged = { workspaceId: "workspace-ops" } as unknown as WorkspaceScope;
  await assert.rejects(retried.tick(forged), /resolver-minted workspace scope/);
});

void test("thresholds have no defaults and are validated", () => {
  const valid = {
    queueAgeMs: { warning: 1, critical: 2 },
    leaseStalledCount: { warning: 1, critical: 2 },
    outboxAgeMs: { warning: 1, critical: 2 },
    deadLetter: { warningCount: 1, criticalCount: 2, warningAgeMs: 1, criticalAgeMs: 2 }
  };
  assert.doesNotThrow(() => createAlertThresholds(valid));
  assert.throws(() => createAlertThresholds({ ...valid, queueAgeMs: { warning: 5, critical: 2 } }));
  assert.throws(() => createAlertThresholds({ ...valid, outboxAgeMs: { warning: 0, critical: 2 } }));
  assert.throws(() => createAlertThresholds({ ...valid, leaseStalledCount: { warning: 1.5, critical: 2 } }));
  assert.throws(() => createAlertThresholds({ ...valid, deadLetter: { ...valid.deadLetter, warningCount: 9 } }));
});

void test("every critical metric has a panel; every panel has an alert or rationale; every alert has a runbook", () => {
  assert.deepEqual(findUncoveredMetrics(criticalMetricNames), []);
  for (const name of Object.keys(metricCatalog)) {
    assert.equal(criticalMetricNames.includes(name), true, `${name} must be a critical metric`);
  }
  assert.deepEqual(findInvalidPanels(), []);
  assert.deepEqual(findAlertRulesWithoutPanel(), []);
  assert.deepEqual(findUncoveredMetrics(["automation_not_covered_total"]), ["automation_not_covered_total"]);
  assert.deepEqual(findInvalidPanels([...dashboardPanels, dashboardPanels[0] ?? (() => { throw new Error("panel"); })()]).length, 1);

  const featureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const document = readFileSync(path.join(featureDirectory, "operations-runbooks.md"), "utf8");
  const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const headings = new Set([...document.matchAll(/^#{2,3} (.+)$/gm)].map((match) => slug(match[1] ?? "")));
  for (const id of alertRuleIds) {
    const rule = alertRules[id];
    const [file, anchor] = rule.runbook.split("#");
    assert.equal(file, "operations-runbooks.md");
    assert.equal(headings.has(anchor ?? ""), true, `${id} runbook anchor ${rule.runbook} must exist`);
    assert.equal(rule.owner.length > 0, true);
  }
});

// ---- TC-0716 DLQ runbook ----

const queuedRun = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-1", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});

type AttemptSeed = Readonly<{
  actionIndex: number;
  attempt: number;
  status: "failed" | "unknown_outcome" | "succeeded";
  actionType: string;
}>;

const ops: Principal = { type: "user", id: "ops-1" };

const dlqSetup = async (actions?: ActionRegistry) => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const audit = createInMemoryRecoveryAuditStore(resolver.ownsScope);
  const grants = new Set(["ops-1:automation.run.read", "ops-1:automation.run.replay"]);
  const counter = { n: 0 };
  const scope = await scopeFor("workspace-1");
  const deadLetters = createDeadLetterService({
    runs: store.repository,
    policy: { authorize: (principal, permission) => Promise.resolve(grants.has(`${principal.id}:${permission}`)) },
    audit: audit.auditPort,
    metrics: { increment: () => undefined },
    clock: { now: () => T0 },
    rng: { nextId: () => `corr-${String(++counter.n)}` },
    ownsScope: resolver.ownsScope,
    ...(actions === undefined ? {} : { actions })
  });
  const runbook = createDlqRunbook({ deadLetters, ...(actions === undefined ? {} : { actions }) });

  const seed = async (runId: string, attempts: readonly AttemptSeed[]): Promise<void> => {
    await store.repository.insert(scope, queuedRun(runId));
    const claim = await store.repository.claimNext(scope, "worker-1", T0, 60_000);
    if (claim.kind !== "claimed") throw new Error("Expected a claim.");
    for (const item of attempts) {
      await store.repository.insertActionAttempt(scope, {
        runId, workspaceId: scope.workspaceId, actionIndex: item.actionIndex, attempt: item.attempt,
        status: item.status, createdAt: T0, updatedAt: T0, actionType: item.actionType
      });
    }
    const decision = decideRetry(
      { errorClass: "transient", attempt: 5, firstAttemptAt: T0, now: T0 },
      defaultRetryPolicy,
      () => 0.5
    );
    const recorded = await deadLetters.recordDeadLetter(scope, {
      runId, fencingToken: claim.run.fencingToken, decision, attempt: 5, firstAttemptAt: T0
    });
    assert.equal(recorded, "dead_lettered");
  };

  return { store, audit, scope, runbook, seed };
};

const diagnosisOf = async (
  t: Awaited<ReturnType<typeof dlqSetup>>,
  runId: string
) => {
  const result = await t.runbook.diagnose(t.scope, ops, runId);
  if (result.kind !== "diagnosed") throw new Error("Expected a diagnosis.");
  return result.diagnosis;
};

void test("TC-0716 runbook locates, diagnoses and safely resolves an idempotent DLQ item", async () => {
  const t = await dlqSetup();
  await t.seed("r1", [{ actionIndex: 0, attempt: 5, status: "failed", actionType: "notification.send" }]);

  const located = await t.runbook.locate(t.scope, ops, { after: undefined, limit: 10 });
  assert.ok(located.kind === "page");
  assert.deepEqual(located.items.map((item) => item.runId), ["r1"]);

  const diagnosis = await diagnosisOf(t, "r1");
  assert.deepEqual(diagnosis.next, { step: "retry" });
  assert.equal(diagnosis.deadLetter?.reason, "MAX_ATTEMPTS_EXHAUSTED");
  assert.equal(diagnosis.instructions.length > 0, true);
  // Diagnose is read-only: no audit record and the run is untouched.
  assert.deepEqual(await t.audit.read(t.scope, "r1"), []);
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");

  const resolved = await t.runbook.resolve(t.scope, ops, {
    runId: "r1", expectedRevision: diagnosis.revision, reason: "Provider outage resolved"
  });
  assert.deepEqual(resolved, { kind: "requeued", runId: "r1", revision: diagnosis.revision + 1 });
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "queued");
  assert.deepEqual((await t.audit.read(t.scope, "r1")).map((event) => event.outcome), ["succeeded"]);
});

void test("TC-0716 an unknown-outcome item is routed to reconciliation and cannot be resolved", async () => {
  const t = await dlqSetup();
  await t.seed("r2", [{ actionIndex: 0, attempt: 5, status: "unknown_outcome", actionType: "notification.send" }]);

  const diagnosis = await diagnosisOf(t, "r2");
  assert.deepEqual(diagnosis.next, { step: "reconcile-first", actionIndexes: [0] });

  const resolved = await t.runbook.resolve(t.scope, ops, {
    runId: "r2", expectedRevision: diagnosis.revision, reason: "try anyway", confirmedActionIndexes: [0]
  });
  assert.deepEqual(resolved, { kind: "blocked", code: "RECONCILIATION_REQUIRED", actionIndexes: [0] });
  assert.equal((await t.store.repository.findById(t.scope, "r2"))?.status, "dead_letter");
});

void test("TC-0716 a non-idempotent failure needs an explicit confirmation; unauthorized callers see nothing", async () => {
  const actions = createActionRegistry([
    notificationSendAction,
    { ...notificationSendAction, type: "test.external", sideEffect: "external" as const, timeoutMs: Object.freeze({ external: 30 }) }
  ]);
  const t = await dlqSetup(actions);
  await t.seed("r3", [{ actionIndex: 0, attempt: 5, status: "failed", actionType: "test.external" }]);

  const diagnosis = await diagnosisOf(t, "r3");
  assert.deepEqual(diagnosis.next, { step: "confirm-non-idempotent", actionIndexes: [0] });
  const request = { runId: "r3", expectedRevision: diagnosis.revision, reason: "Verified nothing was sent" };

  assert.deepEqual(await t.runbook.resolve(t.scope, ops, request), {
    kind: "blocked", code: "UNCONFIRMED_NON_IDEMPOTENT", actionIndexes: [0]
  });
  assert.equal((await t.runbook.resolve(t.scope, ops, { ...request, confirmedActionIndexes: [0] })).kind, "requeued");

  const stranger: Principal = { type: "user", id: "stranger-1" };
  assert.deepEqual(await t.runbook.diagnose(t.scope, stranger, "r3"), { kind: "not-found" });
  assert.deepEqual(await t.runbook.diagnose(t.scope, ops, "missing-run"), { kind: "not-found" });
});

// ---- TC-0717 support access without the database ----

const header: AutomationHeader = Object.freeze({
  automationId: "automation-1",
  workspaceId: "workspace-1",
  name: "Automation",
  createdBy: "creator-1",
  rev: 0,
  status: "enabled" as const,
  draft: {},
  hasDraft: true,
  currentVersion: 1,
  createdAt: T0,
  updatedAt: T0
});

void test("TC-0717 support inspects run history through the API port, with no internal fields", async () => {
  const history = createInMemoryRunHistoryRepository(resolver.ownsScope);
  const service = createRunHistoryService({
    history: history.repository,
    automations: { findById: (scope, id) => Promise.resolve(scope.workspaceId === "workspace-1" && id === "automation-1" ? header : undefined) },
    policy: { authorize: (principal) => Promise.resolve(principal.id === "support-1") },
    ownsScope: resolver.ownsScope
  });
  const leaky = {
    ...queuedRun("run-1"),
    status: "failed" as const,
    leaseOwner: "worker-secret",
    chainKey: "chain-secret",
    traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    input: { password: "hunter2-sentinel" }
  } as unknown as StoredRun;
  history.seedRun(leaky);
  history.seedAttempt({
    runId: "run-1", workspaceId: "workspace-1", actionIndex: 0, attempt: 1, status: "failed",
    createdAt: T0, updatedAt: T0, actionType: "notification.send"
  });

  const scope = await scopeFor("workspace-1");
  const support: Principal = { type: "user", id: "support-1" };
  const list = await service.listForAutomation(scope, support, "automation-1", { after: undefined, limit: 10 });
  assert.ok(list.kind === "page");
  assert.deepEqual(list.items.map((item) => item.runId), ["run-1"]);

  const detail = await service.get(scope, support, "run-1");
  assert.ok(detail.kind === "found");
  assert.equal(detail.item.status, "failed");
  assert.equal(detail.item.version, 1);
  assert.deepEqual(detail.item.actions.map((action) => action.status), ["failed"]);
  assert.doesNotMatch(
    JSON.stringify(detail),
    /worker-secret|chain-secret|hunter2-sentinel|fencingToken|leaseOwner|traceparent/
  );

  const outsider: Principal = { type: "user", id: "outsider-1" };
  assert.deepEqual(await service.get(scope, outsider, "run-1"), { kind: "not-found" });
  assert.deepEqual(await service.listForAutomation(scope, outsider, "automation-1", { after: undefined, limit: 10 }), {
    kind: "not-found"
  });
});

void test("TC-0717 ops modules never touch the database or the driver", () => {
  const featureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = readdirSync(featureDirectory).filter((name) => name.startsWith("ops.") && name.endsWith(".ts"));
  assert.equal(files.length >= 5, true);
  for (const name of files) {
    const source = strip(readFileSync(path.join(featureDirectory, name), "utf8"));
    assert.equal(/\.collection\s*[<(]/.test(source), false, `${name} must not access collections`);
    assert.equal(/from\s+["'](?:mongodb|mongoose)["']/.test(source), false, `${name} must not import the driver`);
    assert.equal(/from\s+["'][./]*integrations\//.test(source), false, `${name} must not import integrations`);
  }
});