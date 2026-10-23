import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationTelemetry,
  toLogContext,
  type TelemetryLogger
} from "../automation.telemetry.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import { createInMemoryChainBudget, createLoopGuard } from "../loop.guard.js";
import { createInMemoryQuotaCounters, createQuotaService } from "../quota.service.js";
import {
  createInMemoryMetrics,
  metricCatalog,
  type MetricName,
  type MetricsPort
} from "../telemetry.metrics.js";
import { redactValue, scrubText } from "../telemetry.redaction.js";
import { createTraceFactory, formatTraceparent, parseTraceparent } from "../telemetry.trace.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

type LogEntry = Readonly<{
  level: "info" | "warn" | "error";
  message: string;
  context: Readonly<Record<string, unknown>>;
}>;

const createLogCapture = () => {
  const entries: LogEntry[] = [];
  const sink = (level: LogEntry["level"]) =>
    (message: string, context: Readonly<Record<string, unknown>>): void => {
      entries.push({ level, message, context });
    };
  const logger: TelemetryLogger = { info: sink("info"), warn: sink("warn"), error: sink("error") };
  return { logger, entries };
};

const build = () => {
  const capture = createLogCapture();
  const store = createInMemoryMetrics();
  const telemetry = createAutomationTelemetry({ logger: capture.logger, metrics: store.metrics });
  return { ...capture, store, telemetry };
};

const sequentialHex = () => {
  let counter = 0;
  return (bytes: number): string => {
    counter += 1;
    return counter.toString(16).padStart(bytes * 2, "0");
  };
};

void test("TC-0421 end-to-end correlation: event, run and action share one trace", () => {
  const traces = createTraceFactory(sequentialHex());
  const eventTrace = traces.root();
  const runTrace = traces.child(formatTraceparent(eventTrace));
  const actionTrace = traces.child(formatTraceparent(runTrace));

  assert.equal(runTrace.traceId, eventTrace.traceId);
  assert.equal(actionTrace.traceId, eventTrace.traceId);
  assert.equal(new Set([eventTrace.spanId, runTrace.spanId, actionTrace.spanId]).size, 3);
  assert.deepEqual(parseTraceparent(formatTraceparent(actionTrace)), actionTrace);

  // Missing or malformed parents start a new trace instead of failing.
  assert.notEqual(traces.child(undefined).traceId, eventTrace.traceId);
  assert.notEqual(traces.child("garbage").traceId, eventTrace.traceId);

  const invalid = [
    "00-00000000000000000000000000000000-0000000000000001-01",
    "00-00000000000000000000000000000001-0000000000000000-01",
    "01-00000000000000000000000000000001-0000000000000001-01",
    "00-0000000000000000000000000000000A-0000000000000001-01",
    "00-0001-0001-01"
  ];
  for (const value of invalid) assert.equal(parseTraceparent(value), undefined);
});

void test("TC-0421 logs for event, run and action carry the same correlation identifiers", () => {
  const { telemetry, entries } = build();
  const traces = createTraceFactory(sequentialHex());
  const eventTrace = traces.root();
  const runTrace = traces.child(formatTraceparent(eventTrace));
  const base = { workspaceId: "workspace-a", automationId: "auto-1", eventId: "evt-1", correlationId: "corr-1", traceId: runTrace.traceId };

  telemetry.logRun("info", "Run started.", { ...base, runId: "run-1", automationVersion: 1, fencingToken: 3 });
  telemetry.logRun("info", "Action finished.", { ...base, runId: "run-1", actionIndex: 0, actionType: "notification.send", attempt: 1, durationMs: 12 });

  assert.deepEqual(entries.map((entry) => entry.context.correlationId), ["corr-1", "corr-1"]);
  assert.deepEqual(entries.map((entry) => entry.context.traceId), [eventTrace.traceId, eventTrace.traceId]);
  assert.deepEqual(entries.map((entry) => entry.context.runId), ["run-1", "run-1"]);
  assert.deepEqual(entries.map((entry) => entry.context.fencingToken), [3, undefined]);
});

void test("log context keeps only the documented fields", () => {
  const context = toLogContext({
    workspaceId: "workspace-a",
    ...({ password: "hunter2", payload: { secret: "x" } } as unknown as Record<string, never>)
  });
  assert.deepEqual(context, { workspaceId: "workspace-a" });
});

void test("TC-0422 required metrics increment on success and failure", () => {
  const { telemetry, store } = build();
  telemetry.recordEvent("task.status_changed", "accepted");
  telemetry.recordEvent("task.status_changed", "duplicate");
  telemetry.recordRun("completed", "task.status_changed");
  telemetry.recordRun("failed", "task.status_changed");
  telemetry.recordRunDuration("completed", 250);
  telemetry.recordAction({ actionType: "notification.send", outcome: "succeeded", durationMs: 40 });
  telemetry.recordAction({ actionType: "notification.send", outcome: "failed", durationMs: 60 });
  telemetry.recordRetry("notification.send", "transient");

  assert.equal(store.counter("automation_events_total", { event_type: "task.status_changed", result: "accepted" }), 1);
  assert.equal(store.counter("automation_events_total", { event_type: "task.status_changed", result: "duplicate" }), 1);
  assert.equal(store.counter("automation_runs_total", { status: "completed", trigger_type: "task.status_changed" }), 1);
  assert.equal(store.counter("automation_runs_total", { status: "failed", trigger_type: "task.status_changed" }), 1);
  assert.equal(store.counter("automation_action_attempts_total", { action_type: "notification.send", outcome: "succeeded" }), 1);
  assert.equal(store.counter("automation_action_attempts_total", { action_type: "notification.send", outcome: "failed" }), 1);
  assert.equal(store.counter("automation_retries_total", { action_type: "notification.send", reason: "transient" }), 1);
  assert.deepEqual(store.histogram("automation_run_duration_seconds", { status: "completed" }), { count: 1, sum: 0.25 });
  assert.deepEqual(store.histogram("automation_action_duration_seconds", { action_type: "notification.send" }), { count: 2, sum: 0.1 });
  assert.deepEqual(store.rejections(), []);
});

void test("TC-0422 loop guard and quota signals reach the sink through the real components", async () => {
  const scope = await scopeFor("workspace-a");
  const { telemetry, store, entries } = build();

  const guard = createLoopGuard({
    ownsScope: resolver.ownsScope,
    budget: createInMemoryChainBudget(resolver.ownsScope).budget,
    telemetry: telemetry.loopGuardTelemetry
  });
  const decision = await guard.evaluate(scope, {
    workspaceId: "workspace-a",
    automationId: "auto-1",
    eventId: "evt-1",
    chainKey: "chain-1",
    origin: { automationId: "auto-1", runId: "run-1", hop: 1 }
  });
  assert.equal(decision.kind, "block");
  assert.equal(store.counter("automation_loop_guard_trips_total", { reason: "SELF_TRIGGER" }), 1);

  const limits = { windowMs: 60_000, workspaceLimit: 1, globalLimit: 10 };
  const quota = createQuotaService({
    ownsScope: resolver.ownsScope,
    counters: createInMemoryQuotaCounters(resolver.ownsScope).counters,
    clock: { now: () => "2026-10-15T12:00:30.000Z" },
    telemetry: telemetry.quotaTelemetry,
    config: { events: limits, runs: limits }
  });
  await quota.admit(scope, "runs");
  const denied = await quota.admit(scope, "runs");
  assert.equal(denied.kind, "deny");
  assert.equal(store.counter("automation_quota_rejections_total", { quota: "workspace" }), 1);

  assert.deepEqual(entries.map((entry) => [entry.level, entry.context.errorCode]), [
    ["warn", "SELF_TRIGGER"],
    ["info", undefined],
    ["warn", "WORKSPACE_QUOTA_EXCEEDED"]
  ]);
});

void test("TC-0423 metric labels stay bounded and never carry identifiers", () => {
  const forbidden = ["runId", "run_id", "automationId", "automation_id", "workspaceId", "workspace_id", "userId", "user_id", "eventId", "event_id"];
  for (const definition of Object.values(metricCatalog)) {
    for (const label of Object.keys(definition.labels)) assert.equal(forbidden.includes(label), false);
  }

  const store = createInMemoryMetrics();
  const name: MetricName = "automation_runs_total";
  store.metrics.increment(name, { status: "completed", trigger_type: "task.status_changed", runId: "run-123" });
  store.metrics.increment(name, { status: "completed" });
  store.metrics.increment(name, { status: "not-a-status", trigger_type: "task.status_changed" });
  store.metrics.increment(name, { status: "completed", trigger_type: "6f1c2d3e-0000-4000-8000-000000000000" });
  store.metrics.increment("automation_unknown_total" as MetricName, {});
  store.metrics.observe(name, { status: "completed", trigger_type: "task.status_changed" }, 1);
  store.metrics.increment("automation_runs_total", { status: "completed", trigger_type: "task.status_changed" }, 0);

  assert.deepEqual(store.rejections().map((item) => item.reason), [
    "LABEL_KEYS", "LABEL_KEYS", "LABEL_VALUE", "LABEL_VALUE", "UNKNOWN_METRIC", "WRONG_TYPE", "INVALID_AMOUNT"
  ]);
  assert.equal(store.seriesCount(), 0);
});

void test("TC-0423 open labels are capped so series growth is bounded", () => {
  const store = createInMemoryMetrics();
  for (let index = 0; index < 60; index += 1) {
    store.metrics.increment("automation_action_attempts_total", {
      action_type: `action.type_${String(index)}`,
      outcome: "succeeded"
    });
  }
  assert.equal(store.seriesCount(), 50);
  assert.equal(store.rejections().length, 10);
  // A value that was already admitted keeps working at the cap.
  store.metrics.increment("automation_action_attempts_total", { action_type: "action.type_0", outcome: "succeeded" });
  assert.equal(store.counter("automation_action_attempts_total", { action_type: "action.type_0", outcome: "succeeded" }), 2);
});

void test("TC-0424 secrets are redacted on the exception path", () => {
  const { telemetry, entries } = build();
  // Synthetic credentials are assembled at runtime so no credential-shaped literal is
  // committed (AE-T-072.1 / SEC-002); the runtime string is identical for redaction.
  const fakeAuthority = `${["admin", "hunter2"].join(":")}@db.local`;
  const error = new Error(
    `connect failed Bearer abc123xyz token=supersecret uri=mongodb://${fakeAuthority}/automation`
  );
  telemetry.logFailure("Action failed.", error, { workspaceId: "workspace-a", runId: "run-1", errorCode: "ACTION_HANDLER_ERROR" });
  telemetry.logFailure("Provider rejected.", { authorization: "Bearer topsecretvalue", detail: "api_key=k-999" }, { runId: "run-2" });

  const serialized = JSON.stringify(entries);
  for (const secret of ["abc123xyz", "supersecret", "hunter2", "topsecretvalue", "k-999"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be logged`);
  }
  assert.equal(entries.length, 2);
  assert.equal(entries.every((entry) => entry.level === "error"), true);
  assert.equal(serialized.includes("stack"), false);
  assert.equal(serialized.includes("[REDACTED]"), true);
});

void test("TC-0424 redactValue handles keys, jwt text, circular and oversized input", () => {
  assert.deepEqual(
    redactValue({ authorization: "Bearer x", nested: { apiKey: "k", fencingToken: 7, name: "ok" } }),
    { authorization: "[REDACTED]", nested: { apiKey: "[REDACTED]", fencingToken: 7, name: "ok" } }
  );
  assert.equal(
    scrubText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc rest"),
    "jwt [REDACTED] rest"
  );

  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;
  assert.doesNotThrow(() => redactValue(circular));

  const huge = redactValue("x".repeat(5_000));
  assert.equal(typeof huge === "string" && huge.length < 600, true);
  const wide = redactValue(Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`key${String(index)}`, index])));
  assert.equal(Object.keys(wide as Record<string, unknown>).length <= 51, true);
});

void test("telemetry never throws, even when the log or metric sink is down", () => {
  const brokenLogger: TelemetryLogger = {
    info: () => { throw new Error("log down"); },
    warn: () => { throw new Error("log down"); },
    error: () => { throw new Error("log down"); }
  };
  const brokenMetrics: MetricsPort = {
    increment: () => { throw new Error("metrics down"); },
    observe: () => { throw new Error("metrics down"); }
  };
  const telemetry = createAutomationTelemetry({ logger: brokenLogger, metrics: brokenMetrics });
  assert.doesNotThrow(() => {
    telemetry.logRun("info", "x", { runId: "run-1" });
    telemetry.logFailure("x", new Error("boom"), {});
    telemetry.recordEvent("task.status_changed", "accepted");
    telemetry.recordAction({ actionType: "notification.send", outcome: "failed", durationMs: 1 });
    telemetry.loopGuardTelemetry.tripped({ code: "SELF_TRIGGER", workspaceId: "w", automationId: "a", eventId: "e", hop: 1, message: "m" });
    telemetry.quotaTelemetry.rejected({ code: "GLOBAL_QUOTA_EXCEEDED", kind: "runs", workspaceId: "w", retryAfterMs: 1 });
  });
});