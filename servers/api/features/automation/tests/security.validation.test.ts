import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createActionExecutor, type ActionExecutionResult } from "../action.executor.js";
import { createActionHandlerRegistry } from "../action.handler.js";
import { buildAuditRecord } from "../audit.record.js";
import { createInMemoryAuditLog } from "../audit.log.js";
import { createInMemoryAuditStore } from "../audit.port.js";
import { createInMemoryAutomationRepository, type AutomationHeader } from "../automation.repository.js";
import { createAutomationTelemetry } from "../automation.telemetry.js";
import { createPrincipalResolver, type Principal, type WorkspaceScope } from "../automation.ports.js";
import { createDeadLetterService, createInMemoryRecoveryAuditStore } from "../dead-letter.service.js";
import { createExecutionContextResolver } from "../execution.context.js";
import { createInMemoryInboxRepository } from "../inbox.repository.js";
import { createAutomationLifecycleTransitionService } from "../lifecycle.transition.service.js";
import { createNotificationSendHandler } from "../notification.action.js";
import { createInMemoryOutboxRepository } from "../outbox.repository.js";
import { decideRetry, defaultRetryPolicy } from "../retry.policy.js";
import { validateRuleDraft } from "../rule.validation.js";
import { createInMemoryRecoveryIdempotencyStore } from "../run.recovery.idempotency.js";
import { createRunRecoveryService } from "../run.recovery.service.js";
import { createInMemoryRunHistoryRepository } from "../run.history.repository.js";
import type { StoredRun } from "../run.repository.js";
import {
  evaluateSecurityGate,
  knownFindings,
  type RiskException,
  type SecurityFinding
} from "../security.findings.js";
import {
  buildSecurityReport,
  renderSecurityReportMarkdown,
  type TestEvidence
} from "../security.report.js";
import { createInMemoryMetrics } from "../telemetry.metrics.js";
import { isSensitiveKey, redactError, redactValue, scrubText } from "../telemetry.redaction.js";
import { createTriggerMatcher } from "../trigger.matcher.js";
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
const T0 = "2026-10-20T09:00:00.000Z";
const featureDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const strip = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------
// TC-0721 cross-tenant attack matrix
// ---------------------------------------------------------------------------

const runFor = (runId: string, workspaceId: string): StoredRun => Object.freeze({
  runId,
  eventId: `event-${runId}`,
  workspaceId,
  automationId: "automation-1",
  version: 1,
  contentHash: "hash-1",
  status: "queued" as const,
  revision: 0,
  fencingToken: 0,
  runAfter: T0,
  createdAt: T0,
  updatedAt: T0
});

const eventFor = (workspaceId: string) => ({
  eventId: "event-1",
  eventType: "task.status_changed",
  schemaVersion: 1,
  occurredAt: T0,
  workspaceId,
  actor: { type: "user", id: "user-1" },
  aggregate: { type: "task", id: "task-1" },
  payload: { task: { status: "done", previousStatus: "open", priority: "high", isArchived: false } }
});

void test("TC-0721 automations: another workspace and a forged scope reach nothing", async () => {
  const a = await scopeFor("workspace-a");
  const b = await scopeFor("workspace-b");
  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  const store = createInMemoryAutomationRepository(resolver.ownsScope);
  const repository = store.repository;
  const created = await repository.createDraft(a, {
    automationId: "auto-a", name: "A", createdBy: "user-a", draft: { x: 1 },
    idempotencyKey: "key-1", requestHash: "hash-1", now: T0
  });
  assert.equal(created.kind, "created");

  assert.equal(await repository.findById(b, "auto-a"), undefined);
  assert.equal(await repository.updateDraft(b, "auto-a", 0, { y: 2 }, T0), "not-found");
  assert.deepEqual((await repository.list(b, { after: undefined, limit: 10 })).items, []);
  assert.deepEqual(await repository.listVersions(b, "auto-a"), []);
  assert.equal(await repository.compareAndSetCurrentVersion(b, "auto-a", 0, 1), "not-found");
  assert.equal(
    await repository.transitionStatus(b, "auto-a", { revision: 0, status: "draft" }, "enabled", T0),
    "not-found"
  );
  assert.equal((await repository.findById(a, "auto-a"))?.rev, 0);

  const before = store.driverCallCount();
  await assert.rejects(repository.findById(forged, "auto-a"));
  await assert.rejects(repository.list(forged, { after: undefined, limit: 10 }));
  assert.equal(store.driverCallCount(), before);
});

void test("TC-0721 runs and run history: another workspace and a forged scope reach nothing", async () => {
  const a = await scopeFor("workspace-a");
  const b = await scopeFor("workspace-b");
  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  const runs = createInMemoryRunRepository(resolver.ownsScope).repository;
  await runs.insert(a, runFor("r1", "workspace-a"));
  const claim = await runs.claimNext(a, "worker-1", T0, 60_000);
  assert.equal(claim.kind, "claimed");

  assert.equal(await runs.findById(b, "r1"), undefined);
  assert.deepEqual(await runs.claimNext(b, "worker-b", T0, 60_000), { kind: "none" });
  assert.equal(await runs.transition(b, "r1", 1, "running", "completed", T0, 1), "not-found");
  assert.deepEqual(await runs.renewLease(b, "r1", "worker-1", 1, T0, 60_000), { kind: "stale" });
  assert.equal(await runs.interruptRun(b, "r1", 1, T0, "WORKER_SHUTDOWN"), "stale");
  assert.deepEqual(await runs.recoverExpiredLeases(b, "2027-01-01T00:00:00.000Z", 10), []);
  assert.deepEqual(await runs.listActionAttempts(b, "r1"), []);
  assert.equal(await runs.requeueDeadLetter(b, "r1", 1, T0), "not-found");
  assert.equal(
    await runs.deadLetterRun(b, "r1", 1, T0, { reason: "MAX_ATTEMPTS_EXHAUSTED", attempts: 5, firstAttemptAt: T0 }),
    "stale"
  );
  assert.deepEqual(await runs.deadLetterBacklog(b, T0), { count: 0, oldestAgeMs: undefined });
  assert.equal((await runs.findById(a, "r1"))?.status, "running");
  await assert.rejects(runs.findById(forged, "r1"));
  await assert.rejects(runs.claimNext(forged, "worker-x", T0, 60_000));

  const history = createInMemoryRunHistoryRepository(resolver.ownsScope);
  history.seedRun(runFor("h1", "workspace-a"));
  history.seedAttempt({
    runId: "h1", workspaceId: "workspace-a", actionIndex: 0, attempt: 1, status: "failed", createdAt: T0, updatedAt: T0
  });
  assert.deepEqual((await history.repository.listRuns(b, "automation-1", { after: undefined, limit: 10 })).items, []);
  assert.equal(await history.repository.findRun(b, "h1"), undefined);
  assert.deepEqual(await history.repository.listActionAttempts(b, "h1"), []);
  await assert.rejects(history.repository.findRun(forged, "h1"));
});

void test("TC-0721 outbox, inbox, audit and recovery idempotency stay inside their workspace", async () => {
  const a = await scopeFor("workspace-a");
  const b = await scopeFor("workspace-b");
  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;

  const outbox = createInMemoryOutboxRepository(resolver.ownsScope).repository;
  await outbox.insertPending(a, {
    outboxId: "o1", workspaceId: "workspace-a", eventType: "task.status_changed", payload: {}, createdAt: T0
  }, undefined);
  assert.equal(await outbox.findById(b, "o1"), undefined);
  assert.equal(await outbox.markPublished(b, "o1", T0), "not-found");
  assert.equal(await outbox.countByStatus(b, "pending"), 0);
  assert.deepEqual(await outbox.claimNextPending(b, T0, 1_000), { kind: "none" });
  assert.equal(await outbox.getOldestPendingAgeMs(b, T0), undefined);
  await assert.rejects(outbox.findById(forged, "o1"));

  const inbox = createInMemoryInboxRepository({ ownsScope: resolver.ownsScope });
  assert.equal((await inbox.record(a, { eventId: "e1", receivedAt: T0 })).kind, "accepted");
  assert.deepEqual(await inbox.record(b, { eventId: "e1", receivedAt: T0 }), {
    kind: "rejected",
    reason: "event-id-conflicts-with-workspace"
  });
  assert.equal(await inbox.findByEventId(b, "e1"), undefined);
  await assert.rejects(Promise.resolve().then(() => inbox.record(forged, { eventId: "e2", receivedAt: T0 })));

  const audit = createInMemoryAuditLog(resolver.ownsScope).log;
  const built = buildAuditRecord({
    recordId: "rec-1",
    workspaceId: "workspace-a",
    input: {
      actor: { type: "user", id: "user-1" },
      action: "run.retry",
      target: { type: "run", id: "run-1" },
      outcome: "succeeded",
      correlationId: "corr-1",
      occurredAt: T0,
      details: {}
    }
  });
  if (!built.ok) throw new Error("audit record must build");
  assert.equal(await audit.append(a, built.record), "appended");
  assert.deepEqual((await audit.list(b, { targetId: undefined, after: undefined, limit: 10 })).items, []);
  await assert.rejects(audit.append(b, built.record));
  await assert.rejects(audit.list(forged, { targetId: undefined, after: undefined, limit: 10 }));

  const idempotency = createInMemoryRecoveryIdempotencyStore(resolver.ownsScope);
  assert.equal((await idempotency.reserve(a, "key", "hash", T0)).kind, "reserved");
  await idempotency.complete(a, "key", { kind: "requeued", runId: "r1", revision: 3 });
  assert.equal((await idempotency.reserve(a, "key", "hash", T0)).kind, "replay");
  // Workspace B never sees A's stored receipt, even with the same key and hash.
  assert.equal((await idempotency.reserve(b, "key", "hash", T0)).kind, "reserved");
  assert.equal((await idempotency.reserve(b, "key", "hash", T0)).kind, "in-progress");
  await assert.rejects(idempotency.reserve(forged, "key", "hash", T0));
});

void test("TC-0721 a forged workspace id in an event or run is refused by matcher and executor", async () => {
  const b = await scopeFor("workspace-b");
  const matcher = createTriggerMatcher({
    candidates: { findEligible: () => Promise.resolve([]) },
    runs: { createIdempotently: () => Promise.resolve("created" as const) }
  });
  const matched = await matcher.match(b, eventFor("workspace-a"));
  assert.equal(matched.kind, "rejected");
  assert.equal(matched.reason, "workspace-conflict");

  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => Promise.resolve(true) },
    handlers: createActionHandlerRegistry([])
  });
  const result = await executor.execute({
    scope: b,
    run: { runId: "run-1", workspaceId: "workspace-a", automationId: "automation-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: {} }
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "ACTION_SCOPE_MISMATCH");
  assert.equal(result.handlerInvoked, false);
});

// ---------------------------------------------------------------------------
// TC-0722 sensitive data redaction
// ---------------------------------------------------------------------------

const secretMarkers = ["sk-live-999", "hunter2", "supersecret", "abc123xyz", "lead-secret-1"] as const;

const assertNoSecrets = (value: unknown, label: string): void => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const marker of secretMarkers) {
    assert.equal(text.includes(marker), false, `${label} leaked ${marker}`);
  }
};

void test("TC-0722 key and text redaction cover tokens, passwords and credentials", () => {
  for (const key of ["authorization", "Cookie", "accessToken", "client_secret", "password", "apiKey", "privateKey"]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  assert.equal(isSensitiveKey("fencingToken"), false);

  const redacted = redactValue({
    password: "hunter2",
    nested: { apiKey: "sk-live-999", note: "Bearer abc123xyz" },
    list: [{ token: "supersecret" }]
  });
  assertNoSecrets(redacted, "redactValue");

  assertNoSecrets(scrubText("Bearer abc123xyz"), "bearer");
  // Synthetic credential assembled at runtime so no credential-shaped literal is committed
  // (AE-T-072.1); the runtime string is identical to what scrubText must redact.
  const fakeAuthority = `${["admin", "hunter2"].join(":")}@`;
  assertNoSecrets(scrubText(`uri mongodb://${fakeAuthority}db.local/automation`), "url password");
  assertNoSecrets(scrubText("failed token=supersecret key"), "key=value");

  const reduced = redactError(new Error("token=supersecret Bearer abc123xyz"));
  assertNoSecrets(reduced, "redactError");
  assert.equal("stack" in reduced, false);
});

void test("TC-0722 exception logging, audit details and validation errors never carry secrets", () => {
  const entries: Readonly<Record<string, unknown>>[] = [];
  const sink = (_message: string, context: Readonly<Record<string, unknown>>): void => { entries.push(context); };
  const telemetry = createAutomationTelemetry({
    logger: { info: sink, warn: sink, error: sink },
    metrics: createInMemoryMetrics().metrics
  });
  // Synthetic credential assembled at runtime (AE-T-072.1): no literal in source.
  const fakeAuthority = `${["admin", "hunter2"].join(":")}@db`;
  telemetry.logFailure(
    "Action failed.",
    new Error(`connect failed Bearer abc123xyz token=supersecret mongodb://${fakeAuthority}.local/x`),
    { workspaceId: "workspace-a", runId: "run-1", errorCode: "ACTION_HANDLER_ERROR" }
  );
  assertNoSecrets(entries, "logFailure");
  assert.equal(JSON.stringify(entries).includes("stack"), false);

  const built = buildAuditRecord({
    recordId: "rec-2",
    workspaceId: "workspace-a",
    input: {
      actor: { type: "system", id: "system-1" },
      action: "flag.change",
      target: { type: "flag", id: "execute" },
      outcome: "succeeded",
      correlationId: "corr-2",
      occurredAt: T0,
      details: { token: "sk-live-999", apiKey: "hunter2", note: "Bearer abc123xyz", nested: { secret: "supersecret" } }
    }
  });
  if (!built.ok) throw new Error("audit record must build");
  assertNoSecrets(built.record, "audit record");

  const rule = {
    schemaVersion: 1,
    name: "Rule",
    trigger: { type: "task.status_changed", config: { toStatus: "done", allowAutomationOrigin: false } },
    conditions: { field: "task.isArchived", op: "eq", value: false },
    actions: [{
      type: "notification.send",
      config: { recipient: { type: "project_lead" }, template: "task_completed", password: "hunter2" },
      onStale: "skip"
    }],
    executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
  };
  const validation = validateRuleDraft(rule);
  assert.equal(validation.valid, false);
  assertNoSecrets(validation, "validation errors");
});

void test("TC-0722 a failing action never returns provider detail or recipient data", async () => {
  const scope = await scopeFor("workspace-1");
  const handler = createNotificationSendHandler({
    directory: { findProjectLeadForRun: () => Promise.resolve({ userId: "lead-secret-1", status: "active" }) },
    notifications: { send: () => Promise.reject(new Error("token=sk-live-999 rejected lead-secret-1")) },
    variables: { forRun: () => Promise.resolve({ taskTitle: "Plan", actorName: "Sara" }) }
  });
  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => Promise.resolve(true) },
    handlers: createActionHandlerRegistry([handler])
  });
  const result: ActionExecutionResult = await executor.execute({
    scope,
    run: { runId: "run-1", workspaceId: "workspace-1", automationId: "automation-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: { recipient: { type: "project_lead" }, template: "task_completed" } }
  });
  assert.equal(result.status, "failed");
  assertNoSecrets(result, "executor result");
});

void test("TC-0722 source scan: no raw console output or stack access in feature code", () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(featureDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = strip(readFileSync(path.join(featureDirectory, entry.name), "utf8"));
    if (/\bconsole\./.test(source) || /\.stack\b/.test(source)) offenders.push(entry.name);
  }
  assert.deepEqual(offenders, []);
});

// ---------------------------------------------------------------------------
// TC-0723 permission bypass and replay abuse
// ---------------------------------------------------------------------------

const ops: Principal = { type: "user", id: "ops-1" };
const automationPrincipal: Principal = { type: "automation", id: "automation:automation-1" };

type AttemptSeed = Readonly<{
  actionIndex: number;
  status: "failed" | "unknown_outcome";
}>;

const recoverySetup = async (grants: readonly string[]) => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const audit = createInMemoryRecoveryAuditStore(resolver.ownsScope);
  const counter = { n: 0 };
  const scope = await scopeFor("workspace-1");
  const policy = { authorize: (principal: Principal, permission: string) =>
    Promise.resolve(grants.includes(`${principal.id}:${permission}`)) };
  const clock = { now: () => T0 };
  const rng = { nextId: () => `corr-${String(++counter.n)}` };
  const metrics = { increment: () => undefined };
  const deadLetters = createDeadLetterService({
    runs: store.repository, policy, audit: audit.auditPort, metrics, clock, rng, ownsScope: resolver.ownsScope
  });
  const recovery = createRunRecoveryService({
    runs: store.repository,
    deadLetters,
    policy,
    audit: audit.auditPort,
    metrics,
    idempotency: createInMemoryRecoveryIdempotencyStore(resolver.ownsScope),
    clock,
    rng,
    ownsScope: resolver.ownsScope
  });

  const claim = async (runId: string): Promise<StoredRun> => {
    // Seeded runs predate any replay run (whose runAfter equals the clock's NOW): equal
    // timestamps tie-break on insertion order, so an earlier runAfter keeps the claim
    // deterministic when a replay run was queued before this seed (AE-T-072.1).
    await store.repository.insert(scope, {
      ...runFor(runId, "workspace-1"),
      runAfter: "2026-10-20T08:00:00.000Z"
    });
    const claimed = await store.repository.claimNext(scope, "worker-1", T0, 60_000);
    if (claimed.kind !== "claimed") throw new Error("Expected a claim.");
    if (claimed.run.runId !== runId) {
      throw new Error(`Expected to claim ${runId}, but claimNext returned ${claimed.run.runId}.`);
    }
    return claimed.run;
  };
  const seedDeadLetter = async (runId: string, attempts: readonly AttemptSeed[]): Promise<StoredRun> => {
    const run = await claim(runId);
    for (const seed of attempts) {
      await store.repository.insertActionAttempt(scope, {
        runId, workspaceId: scope.workspaceId, actionIndex: seed.actionIndex, attempt: 5,
        status: seed.status, createdAt: T0, updatedAt: T0, actionType: "notification.send"
      });
    }
    const decision = decideRetry(
      { errorClass: "transient", attempt: 5, firstAttemptAt: T0, now: T0 },
      defaultRetryPolicy,
      () => 0.5
    );
    const recorded = await deadLetters.recordDeadLetter(scope, {
      runId, fencingToken: run.fencingToken, decision, attempt: 5, firstAttemptAt: T0
    });
    assert.equal(recorded, "dead_lettered");
    const stored = await store.repository.findById(scope, runId);
    if (!stored) throw new Error("Seeded run must exist.");
    return stored;
  };
  const seedCompleted = async (runId: string): Promise<void> => {
    const run = await claim(runId);
    const moved = await store.repository.transition(
      scope, runId, run.revision, "running", "completed", T0, run.fencingToken
    );
    assert.equal(moved, "updated");
  };

  return { store, audit, scope, recovery, seedDeadLetter, seedCompleted };
};

const fullGrants = ["ops-1:automation.run.read", "ops-1:automation.run.replay", "reader-1:automation.run.read"];

void test("TC-0723 automation principals and callers without replay permission cannot recover", async () => {
  const t = await recoverySetup(fullGrants);
  const run = await t.seedDeadLetter("r1", [{ actionIndex: 0, status: "failed" }]);
  const base = { runId: "r1", reason: "Provider outage resolved" };

  assert.deepEqual(
    await t.recovery.retry(t.scope, automationPrincipal, { ...base, idempotencyKey: "k1", expectedRevision: run.revision }),
    { kind: "invalid", code: "RECOVERY_INVALID_PRINCIPAL" }
  );
  assert.deepEqual(
    await t.recovery.replay(t.scope, automationPrincipal, { ...base, idempotencyKey: "k2" }),
    { kind: "invalid", code: "RECOVERY_INVALID_PRINCIPAL" }
  );

  for (const id of ["stranger-1", "reader-1"]) {
    const caller: Principal = { type: "user", id };
    assert.deepEqual(
      await t.recovery.retry(t.scope, caller, { ...base, idempotencyKey: `retry-${id}`, expectedRevision: run.revision }),
      { kind: "not-found" }
    );
    assert.deepEqual(
      await t.recovery.replay(t.scope, caller, { ...base, idempotencyKey: `replay-${id}` }),
      { kind: "not-found" }
    );
  }

  const stored = await t.store.repository.findById(t.scope, "r1");
  assert.equal(stored?.status, "dead_letter");
  assert.equal(stored.revision, run.revision);
  const events = await t.audit.read(t.scope, "r1");
  assert.equal(events.length, 4);
  assert.equal(events.every((event) => event.outcome === "denied"), true);
});

void test("TC-0723 replay abuse: duplicate keys, changed payloads and unsafe sources", async () => {
  const t = await recoverySetup(fullGrants);
  await t.seedDeadLetter("r1", [{ actionIndex: 0, status: "failed" }]);
  const request = { runId: "r1", reason: "Replay after fix", idempotencyKey: "replay-key" };

  const first = await t.recovery.replay(t.scope, ops, request);
  assert.ok(first.kind === "replayed");
  assert.equal(first.idempotentReplay, false);

  // The same request again returns the same replay run and creates nothing new.
  const again = await t.recovery.replay(t.scope, ops, request);
  assert.ok(again.kind === "replayed");
  assert.equal(again.idempotentReplay, true);
  assert.equal(again.replayRunId, first.replayRunId);

  // The same key with a different payload is refused.
  assert.deepEqual(
    await t.recovery.replay(t.scope, ops, { ...request, reason: "A different reason" }),
    { kind: "idempotency-conflict" }
  );

  const replayRun = await t.store.repository.findById(t.scope, first.replayRunId);
  assert.equal(replayRun?.replayOf, "r1");
  assert.equal(replayRun.status, "queued");
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");

  // An action with an unknown outcome can never be confirmed away.
  await t.seedDeadLetter("r2", [{ actionIndex: 0, status: "unknown_outcome" }]);
  const blocked = await t.recovery.replay(t.scope, ops, {
    runId: "r2", reason: "Force it", idempotencyKey: "force-key", confirmedActionIndexes: [0]
  });
  assert.deepEqual(blocked, { kind: "blocked", code: "RECONCILIATION_REQUIRED", actionIndexes: [0] });

  // A completed run is not replayable.
  await t.seedCompleted("r3");
  assert.deepEqual(
    await t.recovery.replay(t.scope, ops, { runId: "r3", reason: "Replay done run", idempotencyKey: "done-key" }),
    { kind: "not-retryable" }
  );
});

void test("TC-0723 retry abuse: stale revision, double retry, invalid input and another workspace", async () => {
  const t = await recoverySetup(fullGrants);
  const run = await t.seedDeadLetter("r1", [{ actionIndex: 0, status: "failed" }]);
  const base = { runId: "r1", reason: "Provider outage resolved" };

  assert.deepEqual(
    await t.recovery.retry(t.scope, ops, { ...base, idempotencyKey: "stale", expectedRevision: run.revision - 1 }),
    { kind: "conflict" }
  );
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");

  assert.deepEqual(
    await t.recovery.retry(t.scope, ops, { ...base, reason: "   ", idempotencyKey: "k", expectedRevision: run.revision }),
    { kind: "invalid", code: "RECOVERY_REASON_REQUIRED" }
  );
  assert.deepEqual(
    await t.recovery.retry(t.scope, ops, { ...base, idempotencyKey: "", expectedRevision: run.revision }),
    { kind: "invalid", code: "RECOVERY_IDEMPOTENCY_KEY_REQUIRED" }
  );

  const done = await t.recovery.retry(t.scope, ops, { ...base, idempotencyKey: "ok", expectedRevision: run.revision });
  assert.ok(done.kind === "requeued");

  // A second retry with a fresh key must not requeue again.
  assert.deepEqual(
    await t.recovery.retry(t.scope, ops, { ...base, idempotencyKey: "second", expectedRevision: run.revision + 1 }),
    { kind: "not-retryable" }
  );

  const other = await scopeFor("workspace-2");
  assert.deepEqual(
    await t.recovery.retry(other, ops, { ...base, idempotencyKey: "cross", expectedRevision: run.revision }),
    { kind: "not-found" }
  );
  assert.deepEqual(await t.audit.read(other, "r1"), []);
});

void test("TC-0723 execution-time authorization: revoked creator permission and lost ownership deny work", async () => {
  const scope = await scopeFor("workspace-a");
  const handler = createNotificationSendHandler({
    directory: { findProjectLeadForRun: () => Promise.resolve({ userId: "lead-1", status: "active" }) },
    notifications: { send: () => Promise.resolve({ notificationId: "n-1", deduplicated: false }) },
    variables: { forRun: () => Promise.resolve({ taskTitle: "t", actorName: "a" }) }
  });
  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    // The delegated automation principal is allowed; the creator lost the permission.
    policy: { authorize: (principal) => Promise.resolve(principal.type === "automation") },
    handlers: createActionHandlerRegistry([handler])
  });
  const result = await executor.execute({
    scope,
    run: { runId: "run-1", workspaceId: "workspace-a", automationId: "auto-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: { recipient: { type: "project_lead" }, template: "task_completed" } }
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "ACTION_PERMISSION_DENIED");
  assert.equal(result.handlerInvoked, false);

  const header: AutomationHeader = Object.freeze({
    automationId: "auto-1", workspaceId: "workspace-a", name: "A", createdBy: "creator-1", rev: 0,
    status: "enabled" as const, draft: {}, hasDraft: true, currentVersion: 1, createdAt: T0, updatedAt: T0
  });
  const contexts = createExecutionContextResolver({
    ownsScope: resolver.ownsScope,
    automations: { findById: () => Promise.resolve(header) },
    creators: { lookup: () => Promise.resolve("removed" as const) }
  });
  const resolved = await contexts.resolve(scope, { runId: "run-1", workspaceId: "workspace-a", automationId: "auto-1" });
  assert.equal(resolved.kind, "denied");
  assert.equal(resolved.code, "OWNER_ACCESS_LOST");
  assert.equal(resolved.pauseAutomation, true);
});

void test("TC-0723 an automation principal cannot drive the lifecycle API", async () => {
  const scope = await scopeFor("workspace-a");
  const repository = createInMemoryAutomationRepository(resolver.ownsScope).repository;
  const lifecycle = createAutomationLifecycleTransitionService({
    repository,
    policy: { authorize: () => Promise.resolve(true) },
    auditPort: createInMemoryAuditStore(resolver.ownsScope).auditPort,
    clock: { now: () => T0 },
    rng: { nextId: () => "corr-1" }
  });
  assert.deepEqual(
    await lifecycle.transition(scope, automationPrincipal, { automationId: "auto-1", action: "enable", expectedRevision: 0 }),
    { kind: "not-found" }
  );
});

// ---------------------------------------------------------------------------
// TC-0724 findings have disposition and owners
// ---------------------------------------------------------------------------

const finding = (overrides: Partial<SecurityFinding> = {}): SecurityFinding => ({
  id: "F-1",
  title: "Example",
  severity: "high",
  source: "code-review",
  owner: "Abid Ullah",
  status: "open",
  evidence: "doc.md",
  ...overrides
});

const exception: RiskException = {
  approver: "Abid Ullah",
  owner: "Abid Ullah",
  impact: "Limited to internal workspaces.",
  mitigation: "Feature flag stays off.",
  rollbackTrigger: "Any cross-tenant read.",
  approvedAt: "2026-10-01T00:00:00.000Z",
  reviewBy: "2026-12-01T00:00:00.000Z"
};

void test("TC-0724 every known finding has an owner, evidence and a stable disposition", () => {
  assert.equal(new Set(knownFindings.map((item) => item.id)).size, knownFindings.length);
  for (const item of knownFindings) {
    assert.equal(item.owner.trim().length > 0, true, `${item.id} owner`);
    assert.equal(item.evidence.trim().length > 0, true, `${item.id} evidence`);
  }

  const gate = evaluateSecurityGate(knownFindings, NOW);
  const expected = knownFindings
    .filter((item) => (item.severity === "critical" || item.severity === "high") && item.status === "open")
    .map((item) => item.id);
  assert.deepEqual(gate.blockers.filter((item) => item.code === "UNRESOLVED").map((item) => item.findingId), expected);
  assert.equal(gate.blockers.every((item) => item.code === "UNRESOLVED"), true);
  assert.equal(gate.passed, expected.length === 0);
});

void test("TC-0724 the gate blocks unresolved high risk and accepts only complete, unexpired dispositions", () => {
  assert.equal(evaluateSecurityGate([finding()], NOW).blockers[0]?.code, "UNRESOLVED");
  assert.equal(evaluateSecurityGate([finding({ severity: "critical" })], NOW).passed, false);

  const lowOpen = evaluateSecurityGate([finding({ severity: "low" })], NOW);
  assert.equal(lowOpen.passed, true);
  assert.equal(lowOpen.warnings[0]?.code, "UNRESOLVED");

  assert.equal(evaluateSecurityGate([finding({ status: "fixed" })], NOW).passed, true);
  assert.equal(evaluateSecurityGate([finding({ status: "false-positive" })], NOW).passed, true);

  const accepted = finding({ status: "accepted-risk", exception });
  assert.equal(evaluateSecurityGate([accepted], NOW).passed, true);
  assert.equal(evaluateSecurityGate([accepted], "2027-01-01T00:00:00.000Z").blockers[0]?.code, "EXCEPTION_EXPIRED");

  assert.equal(
    evaluateSecurityGate([finding({ status: "accepted-risk" })], NOW).blockers[0]?.code,
    "EXCEPTION_INCOMPLETE"
  );
  assert.equal(
    evaluateSecurityGate([finding({ status: "accepted-risk", exception: { ...exception, mitigation: " " } })], NOW)
      .blockers[0]?.code,
    "EXCEPTION_INCOMPLETE"
  );
  assert.equal(
    evaluateSecurityGate([finding({ status: "accepted-risk", exception: { ...exception, reviewBy: exception.approvedAt } })], NOW)
      .blockers[0]?.code,
    "EXCEPTION_INCOMPLETE"
  );

  assert.equal(evaluateSecurityGate([finding({ owner: "" })], NOW).blockers[0]?.code, "INVALID_FINDING");
  assert.equal(
    evaluateSecurityGate([finding({ status: "fixed" }), finding({ status: "fixed" })], NOW).blockers[0]?.code,
    "DUPLICATE_ID"
  );
  assert.equal(evaluateSecurityGate([finding({ status: "fixed" })], "not-a-date").blockers[0]?.code, "INVALID_TIME");
  assert.deepEqual(evaluateSecurityGate([finding(), finding({ id: "F-2", severity: "medium" })], NOW).unresolved, {
    critical: 0, high: 1, medium: 1, low: 0
  });
});

void test("TC-0724 the report is approved only with a passing gate, passing evidence and a reviewer", () => {
  const passed: readonly TestEvidence[] = ["TC-0721", "TC-0722", "TC-0723", "TC-0724"]
    .map((testId) => ({ testId, result: "passed" as const }));
  const approval = { reviewer: "Abid Ullah", approvedAt: NOW, scope: "commit abc123" };
  const clean = [finding({ status: "fixed" })];

  assert.equal(buildSecurityReport({ generatedAt: NOW, findings: clean, evidence: passed }).status, "pending-review");
  assert.equal(buildSecurityReport({ generatedAt: NOW, findings: clean, evidence: passed, approval }).status, "approved");
  assert.equal(
    buildSecurityReport({ generatedAt: NOW, findings: clean, evidence: passed, approval: { ...approval, reviewer: " " } }).status,
    "pending-review"
  );

  // An open high finding blocks even with a reviewer approval.
  assert.equal(buildSecurityReport({ generatedAt: NOW, findings: [finding()], evidence: passed, approval }).status, "blocked");

  const gaps = buildSecurityReport({
    generatedAt: NOW,
    findings: clean,
    evidence: [{ testId: "TC-0721", result: "passed" }, { testId: "TC-0722", result: "failed" }, { testId: "TC-0723", result: "not-run" }],
    approval
  });
  assert.equal(gaps.status, "blocked");
  assert.deepEqual(gaps.evidenceGaps, ["TC-0722: failed", "TC-0723: not-run", "TC-0724: not provided"]);

  const markdown = renderSecurityReportMarkdown(buildSecurityReport({
    generatedAt: NOW,
    findings: [finding({ title: "Has | pipe" })],
    evidence: passed
  }));
  assert.match(markdown, /Status: \*\*blocked\*\*/);
  assert.match(markdown, /Has \\\| pipe/);
  assert.match(markdown, /Pending\. No reviewer approval is attached\./);
});