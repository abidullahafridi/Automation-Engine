import assert from "node:assert/strict";
import test from "node:test";
import type { ActionExecutionRequest, ActionExecutionResult, ActionExecutor } from "../action.executor.js";
import { createAutomationTelemetry, type TelemetryLogger } from "../automation.telemetry.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { AutomationHeader, AutomationRepository, PublishedAutomationVersion } from "../automation.repository.js";
import { createInMemoryAuditLog } from "../audit.log.js";
import { createAuditRecorder } from "../audit.recorder.js";
import { createExecutionContextResolver, type CreatorStanding } from "../execution.context.js";
import { createRunExecutionHandler, type AutomationPauser } from "../run.execution.js";
import type { ActionAttempt, RunRepository, RunStatus, RunTransitionResult, StoredRun } from "../run.repository.js";
import { createInMemoryMetrics } from "../telemetry.metrics.js";
import { createTraceFactory } from "../telemetry.trace.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const only = <T>(items: readonly T[]): T => {
  const [item] = items;
  if (items.length !== 1 || item === undefined) throw new Error("Expected exactly one item.");
  return item;
};

const parentTraceId = "0af7651916cd43dd8448eb211c80319c";
const traceparent = `00-${parentTraceId}-b7ad6b7169203331-01`;

const storedRun = (fencingToken: number): StoredRun => Object.freeze({
  runId: "run-1",
  eventId: "evt-1",
  workspaceId: "workspace-a",
  automationId: "auto-1",
  version: 1,
  contentHash: "hash-1",
  status: "running" as const,
  revision: 3,
  fencingToken,
  runAfter: "2026-10-17T10:00:00.000Z",
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z",
  chainKey: "corr-1",
  hop: 0,
  traceparent
});

const header: AutomationHeader = Object.freeze({
  automationId: "auto-1",
  workspaceId: "workspace-a",
  name: "Automation",
  createdBy: "creator-1",
  rev: 0,
  status: "enabled" as const,
  draft: {},
  hasDraft: true,
  currentVersion: 1,
  createdAt: "2026-10-17T10:00:00.000Z",
  updatedAt: "2026-10-17T10:00:00.000Z"
});

const twoActions = [
  { type: "notification.send", config: {} },
  { type: "notification.send", config: {} }
] as const;

const versionOf = (contentHash: string, actions: readonly unknown[]): PublishedAutomationVersion => ({
  automationId: "auto-1",
  workspaceId: "workspace-a",
  version: 1,
  schemaVersion: 1,
  contentHash,
  publishKey: "publish-1",
  rule: { trigger: { type: "task.status_changed", config: {} }, actions } as unknown as PublishedAutomationVersion["rule"],
  createdAt: "2026-10-17T10:00:00.000Z"
});

const succeeded: ActionExecutionResult = {
  status: "succeeded",
  handlerInvoked: true,
  idempotencyKey: "key-1",
  output: {}
};

const failedWith = (errorClass: "transient" | "permanent" | "ambiguous"): ActionExecutionResult => ({
  status: "failed",
  handlerInvoked: true,
  idempotencyKey: "key-1",
  failure: { code: "ACTION_HANDLER_ERROR", errorClass, message: "Action failed." }
});

type TransitionCall = Readonly<{ to: RunStatus; revision: number; fencingToken: number | undefined }>;
type RetryCall = Readonly<{ runAfter: string; firstAttemptAt: string; failureCode: string }>;

type Options = Readonly<{
  results?: readonly ActionExecutionResult[];
  standing?: CreatorStanding | "throw";
  versions?: readonly PublishedAutomationVersion[];
  transitionResult?: RunTransitionResult;
  maxAttempts?: number;
  pauser?: AutomationPauser;
}>;

const setup = (options: Options = {}) => {
  const transitions: TransitionCall[] = [];
  const attempts: ActionAttempt[] = [];
  const attemptStatusesAtEffect: ActionAttempt["status"][][] = [];
  const requests: ActionExecutionRequest[] = [];
  const results = options.results ?? [];
  let nextResult = 0;

  const retryCalls: RetryCall[] = [];
  const deadLetters: string[] = [];
  const runs: Pick<RunRepository, "transition" | "insertActionAttempt" | "updateActionAttempt" | "scheduleRetry" | "deadLetterRun" | "listActionAttempts"> = {
    transition: (_scope, _runId, revision, _from, to, _now, fencingToken) => {
      transitions.push({ to, revision, fencingToken });
      return Promise.resolve(options.transitionResult ?? "updated");
    },
    insertActionAttempt: (_scope, attempt) => {
      attempts.push(attempt);
      return Promise.resolve("created" as const);
    },
    updateActionAttempt: (_scope, attempt) => {
      const index = attempts.findIndex((item) => item.runId === attempt.runId && item.actionIndex === attempt.actionIndex && item.attempt === attempt.attempt);
      if (index < 0) return Promise.resolve("not-found" as const);
      attempts[index] = attempt;
      return Promise.resolve("updated" as const);
    },
    scheduleRetry: (_scope, _runId, _revision, _fencingToken, _now, runAfter, firstAttemptAt, failureCode) => {
      retryCalls.push({ runAfter, firstAttemptAt, failureCode });
      return Promise.resolve("updated" as const);
    },
    deadLetterRun: (_scope, _runId, _fencingToken, _now, detail) => {
      deadLetters.push(detail.reason);
      return Promise.resolve("dead_lettered" as const);
    },
    listActionAttempts: (_scope, runId) => Promise.resolve(attempts.filter((item) => item.runId === runId))
  };

  const versions = options.versions ?? [versionOf("hash-1", twoActions)];
  const automations: Pick<AutomationRepository, "findById" | "listVersions"> = {
    findById: (scope, automationId) =>
      Promise.resolve(scope.workspaceId === header.workspaceId && automationId === header.automationId ? header : undefined),
    listVersions: () => Promise.resolve(versions)
  };

  const executor: ActionExecutor = {
    execute: (request) => {
      requests.push(request);
      attemptStatusesAtEffect.push(attempts.map((attempt) => attempt.status));
      const next = results[nextResult];
      nextResult += 1;
      return next === undefined ? Promise.reject(new Error("No scripted result.")) : Promise.resolve(next);
    }
  };

  const standing = options.standing ?? "member";
  const contexts = createExecutionContextResolver({
    ownsScope: resolver.ownsScope,
    automations,
    creators: {
      lookup: () => standing === "throw" ? Promise.reject(new Error("platform down")) : Promise.resolve(standing)
    }
  });

  const entries: { level: string; context: Readonly<Record<string, unknown>> }[] = [];
  const sink = (level: string) => (_message: string, context: Readonly<Record<string, unknown>>): void => {
    entries.push({ level, context });
  };
  const logger: TelemetryLogger = { info: sink("info"), warn: sink("warn"), error: sink("error") };
  const store = createInMemoryMetrics();
  const telemetry = createAutomationTelemetry({ logger, metrics: store.metrics });

  const auditStore = createInMemoryAuditLog(resolver.ownsScope);
  let counter = 0;
  const audit = createAuditRecorder({
    ownsScope: resolver.ownsScope,
    log: auditStore.log,
    clock: { now: (): string => "2026-10-17T10:00:05.000Z" },
    ids: { nextId: (): string => { counter += 1; return `rec-${String(counter)}`; } }
  });

  const handler = createRunExecutionHandler({
    contexts,
    automations,
    runs,
    executor,
    telemetry,
    audit,
    traces: createTraceFactory(),
    clock: { now: (): string => "2026-10-17T10:00:05.000Z" },
    retryJitter: () => 0,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.pauser ? { pauser: options.pauser } : {})
  });

  return { handler, transitions, attempts, requests, attemptStatusesAtEffect, entries, store, auditStore, retryCalls, deadLetters };
};

const invoke = async (
  fixture: ReturnType<typeof setup>,
  fencingToken = 1,
  signal: AbortSignal = new AbortController().signal
): Promise<void> => {
  const scope = await scopeFor("workspace-a");
  await fixture.handler({ scope, run: storedRun(fencingToken), signal });
};

void test("successful run executes every action, completes with fencing, and shares one trace", async () => {
  const fixture = setup({ results: [succeeded, succeeded] });
  await invoke(fixture, 2);

  assert.deepEqual(fixture.transitions, [{ to: "completed", revision: 3, fencingToken: 2 }]);
  assert.deepEqual(
    fixture.attempts.map((item) => [item.actionIndex, item.attempt, item.status]),
    [[0, 2, "succeeded"], [1, 2, "succeeded"]]
  );
  const scope = await scopeFor("workspace-a");
  assert.equal(fixture.requests.length, 2);
  assert.equal(only(fixture.requests.slice(0, 1)).run.runId, "run-1");
  assert.equal(fixture.requests.every((request) => resolver.ownsScope(request.scope)), true);
  assert.equal(scope.workspaceId, "workspace-a");

  assert.equal(fixture.store.counter("automation_runs_total", { status: "completed", trigger_type: "task.status_changed" }), 1);
  assert.equal(fixture.store.counter("automation_action_attempts_total", { action_type: "notification.send", outcome: "succeeded" }), 2);
  assert.equal(fixture.entries.every((entry) => entry.context.traceId === parentTraceId), true);
  assert.equal(fixture.entries.every((entry) => entry.context.correlationId === "corr-1"), true);
});

void test("permanent action failure stops the run and records failure", async () => {
  const fixture = setup({ results: [failedWith("permanent")] });
  await invoke(fixture);

  assert.equal(fixture.requests.length, 1);
  assert.deepEqual(fixture.transitions.map((item) => item.to), ["failed"]);
  assert.deepEqual(fixture.attempts.map((item) => item.status), ["failed"]);
  assert.equal(fixture.store.counter("automation_runs_total", { status: "failed", trigger_type: "task.status_changed" }), 1);
  assert.equal(fixture.entries.some((entry) => entry.context.errorCode === "ACTION_HANDLER_ERROR"), true);
});

void test("transient failure persists bounded retry_wait backoff and dead-letters exhausted retries", async () => {
  const retrying = setup({ results: [failedWith("transient")], maxAttempts: 3 });
  await invoke(retrying, 1);
  assert.deepEqual(retrying.transitions, []);
  assert.deepEqual(retrying.retryCalls, [{ runAfter: "2026-10-17T10:00:05.000Z", firstAttemptAt: "2026-10-17T10:00:05.000Z", failureCode: "ACTION_HANDLER_ERROR" }]);
  assert.equal(retrying.attempts[0]?.status, "failed");
  assert.equal(retrying.store.counter("automation_retries_total", { action_type: "notification.send", reason: "transient" }), 1);

  const exhausted = setup({ results: [failedWith("transient")], maxAttempts: 3 });
  await invoke(exhausted, 3);
  assert.deepEqual(exhausted.deadLetters, ["MAX_ATTEMPTS_EXHAUSTED"]);
  assert.equal(exhausted.store.counter("automation_retries_total", { action_type: "notification.send", reason: "exhausted" }), 1);
});

void test("write-ahead attempt exists before effect and previously succeeded actions are skipped", async () => {
  const fixture = setup({ results: [succeeded] });
  fixture.attempts.push(Object.freeze({ runId: "run-1", workspaceId: "workspace-a", actionIndex: 0, attempt: 1,
    status: "succeeded", createdAt: "2026-10-17T10:00:00.000Z", updatedAt: "2026-10-17T10:00:01.000Z", actionType: "notification.send" }));
  await invoke(fixture, 2);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0]?.actionIndex, 1);
  assert.deepEqual(fixture.attemptStatusesAtEffect, [["succeeded", "running"]]);
  assert.deepEqual(fixture.attempts.map((item) => [item.actionIndex, item.status]), [[0, "succeeded"], [1, "succeeded"]]);
});

void test("unknown prior action outcome is not blindly repeated", async () => {
  const fixture = setup({ results: [succeeded] });
  fixture.attempts.push(Object.freeze({ runId: "run-1", workspaceId: "workspace-a", actionIndex: 0, attempt: 1,
    status: "unknown_outcome", createdAt: "2026-10-17T10:00:00.000Z", updatedAt: "2026-10-17T10:00:01.000Z", actionType: "notification.send" }));
  await invoke(fixture, 2);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.transitions.map((item) => item.to), ["failed"]);
  assert.equal(fixture.entries.some((entry) => entry.context.errorCode === "ACTION_OUTCOME_UNKNOWN"), true);
});

void test("ambiguous failure is never retried and is recorded as unknown_outcome", async () => {
  const fixture = setup({ results: [failedWith("ambiguous")] });
  await invoke(fixture);

  assert.deepEqual(fixture.attempts.map((item) => item.status), ["unknown_outcome"]);
  assert.deepEqual(fixture.transitions.map((item) => item.to), ["failed"]);
  assert.equal(fixture.store.counter("automation_retries_total", { action_type: "notification.send", reason: "transient" }), 0);
});

void test("owner access lost: audited, paused, run fails, no action executes", async () => {
  const paused: string[] = [];
  const fixture = setup({
    standing: "removed",
    pauser: { pause: (_scope, automationId, reason) => { paused.push(`${automationId}:${reason}`); return Promise.resolve(); } }
  });
  await invoke(fixture);

  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(paused, ["auto-1:OWNER_ACCESS_LOST"]);
  assert.deepEqual(fixture.transitions.map((item) => item.to), ["failed"]);

  const scope = await scopeFor("workspace-a");
  const record = only((await fixture.auditStore.log.list(scope, { targetId: "run-1", after: undefined, limit: 10 })).items);
  assert.equal(record.action, "execution.denied");
  assert.equal(record.outcome, "denied");
  assert.equal(record.details.code, "OWNER_ACCESS_LOST");
});

void test("a platform outage is retried without writing a permanent audit denial", async () => {
  const fixture = setup({ standing: "throw" });
  await invoke(fixture, 1);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.auditStore.size(), 0);
  assert.deepEqual(fixture.transitions, []);
  assert.equal(fixture.retryCalls.length, 1);
});

void test("version integrity, missing version and invalid rule fail the run before any action", async () => {
  const tampered = setup({ versions: [versionOf("other-hash", twoActions)] });
  await invoke(tampered);
  assert.equal(tampered.requests.length, 0);
  assert.equal(tampered.entries.some((entry) => entry.context.errorCode === "VERSION_INTEGRITY"), true);

  const missing = setup({ versions: [] });
  await invoke(missing);
  assert.equal(missing.entries.some((entry) => entry.context.errorCode === "VERSION_NOT_FOUND"), true);

  const invalid = setup({ versions: [versionOf("hash-1", [{ nope: true }])] });
  await invoke(invalid);
  assert.equal(invalid.entries.some((entry) => entry.context.errorCode === "VERSION_INVALID"), true);
  assert.deepEqual(invalid.transitions.map((item) => item.to), ["failed"]);
});

void test("a stale write is not reported as this worker's outcome", async () => {
  const fixture = setup({ results: [succeeded, succeeded], transitionResult: "stale" });
  await invoke(fixture);
  assert.equal(fixture.store.counter("automation_runs_total", { status: "completed", trigger_type: "task.status_changed" }), 0);
  assert.equal(fixture.entries.some((entry) => entry.context.errorCode === "STALE_WRITE"), true);
});

void test("an aborted run performs no actions and no writes", async () => {
  const controller = new AbortController();
  controller.abort();
  const fixture = setup({ results: [succeeded] });
  await invoke(fixture, 1, controller.signal);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.transitions, []);
});

void test("a run beyond its attempt budget fails without executing", async () => {
  const fixture = setup({ results: [succeeded], maxAttempts: 3 });
  await invoke(fixture, 4);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.transitions.map((item) => item.to), ["failed"]);
});

void test("invalid attempt budget is refused at construction", () => {
  assert.throws(() => setup({ maxAttempts: 0 }));
});
