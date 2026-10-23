import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createActionExecutor } from "../action.executor.js";
import { createActionHandlerRegistry } from "../action.handler.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  createActionRegistry,
  notificationSendAction,
  type ActionRegistry
} from "../automation.registry.js";
import {
  createInMemoryAutomationRepository,
  type PublishedAutomationVersion
} from "../automation.repository.js";
import { createNotificationSendHandler } from "../notification.action.js";
import { createInMemoryOutboxRepository } from "../outbox.repository.js";
import {
  analyzeRestoredState,
  collectRestoreSnapshot,
  measureRecovery,
  type RestoredSnapshot
} from "../restore.reconciliation.js";
import { createInMemoryRunHistoryRepository } from "../run.history.repository.js";
import type { ActionAttempt, StoredRun } from "../run.repository.js";
import { hashRuleDocument } from "../version.lifecycle.service.js";
import type { RuleDocument } from "../rule.validation.js";
import { createInMemoryRunRepository } from "./run.repository.in-memory.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const T0 = "2026-10-20T10:00:00.000Z";
const NOW = "2026-10-20T12:00:00.000Z";
const WS = "workspace-r";

const rule: RuleDocument = {
  schemaVersion: 1,
  name: "Restore test rule",
  trigger: { type: "task.status_changed", config: { toStatus: "done", allowAutomationOrigin: false } },
  conditions: { field: "task.isArchived", op: "eq", value: false },
  actions: [{
    type: "notification.send",
    config: { recipient: { type: "project_lead" }, template: "task_completed" },
    onStale: "skip"
  }],
  executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
};

const hashed = hashRuleDocument(rule);
if (!hashed.success) throw new Error("Fixture rule must be hashable.");
const contentHash = hashed.contentHash;

const version = (overrides: Partial<PublishedAutomationVersion> = {}): PublishedAutomationVersion => ({
  automationId: "automation-1",
  workspaceId: WS,
  version: 1,
  schemaVersion: 1,
  contentHash,
  publishKey: "publish-1",
  rule,
  createdAt: T0,
  ...overrides
});

const run = (runId: string, status: StoredRun["status"], overrides: Partial<StoredRun> = {}): StoredRun =>
  Object.freeze({
    runId,
    eventId: `event-${runId}`,
    workspaceId: WS,
    automationId: "automation-1",
    version: 1,
    contentHash,
    status,
    revision: 1,
    fencingToken: 1,
    runAfter: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides
  });

const attempt = (
  runId: string,
  actionIndex: number,
  status: ActionAttempt["status"],
  overrides: Partial<ActionAttempt> = {}
): ActionAttempt => Object.freeze({
  runId,
  workspaceId: WS,
  actionIndex,
  attempt: 1,
  status,
  createdAt: T0,
  updatedAt: T0,
  actionType: "notification.send",
  ...overrides
});

const snapshot = (overrides: Partial<RestoredSnapshot> = {}): RestoredSnapshot => Object.freeze({
  workspaceId: WS,
  takenAt: NOW,
  runs: [run("r-done", "completed"), run("r-queued", "queued")],
  attempts: [attempt("r-done", 0, "succeeded")],
  versions: [version()],
  outbox: { pending: 0, published: 3, oldestPendingAgeMs: undefined },
  truncated: false,
  ...overrides
});

const codes = (report: ReturnType<typeof analyzeRestoredState>, severity: string): string[] =>
  report.findings.filter((finding) => finding.severity === severity).map((finding) => finding.code);

const externalActions: ActionRegistry = createActionRegistry([
  notificationSendAction,
  { ...notificationSendAction, type: "test.external", sideEffect: "external" as const, timeoutMs: Object.freeze({ external: 30 }) }
]);

// ---------------------------------------------------------------------------
// TC-0718 restored database passes integrity checks
// ---------------------------------------------------------------------------

void test("TC-0718 a consistent restored snapshot passes integrity and may resume", () => {
  const report = analyzeRestoredState(snapshot());
  assert.equal(report.integrityOk, true);
  assert.deepEqual(report.findings, []);
  assert.equal(report.executionMayResume, true);
  assert.deepEqual(report.counts, { runs: 2, attempts: 1, versions: 1, errors: 0, reviews: 0 });
});

void test("TC-0718 corrupted or inconsistent restored data is reported with stable codes", () => {
  const tampered = version({ rule: { ...rule, name: "Tampered after backup" } });
  const report = analyzeRestoredState(snapshot({
    runs: [
      run("r1", "completed"),
      run("r1", "completed"),                                      // duplicate id
      run("r2", "queued", { eventId: "event-r1" }),                // duplicate natural key vs r1
      run("r3", "completed", { workspaceId: "other-workspace" }),  // wrong workspace
      run("r4", "queued", { version: 9 }),                         // active, version missing
      run("r5", "completed", { contentHash: "different" }),        // pinned hash mismatch
      run("r6", "dead_letter"),                                    // dead letter without info
      run("r7", "queued", { revision: -1 })
    ],
    attempts: [
      attempt("ghost", 0, "succeeded"),                            // orphan
      attempt("r1", 0, "succeeded", { workspaceId: "other-workspace" }),
      attempt("r1", 1, "succeeded"),
      attempt("r1", 1, "succeeded")                                // duplicate
    ],
    versions: [tampered, version({ version: 2, workspaceId: "other-workspace" })],
    truncated: true
  }));

  assert.equal(report.integrityOk, false);
  const errors = new Set(codes(report, "error"));
  for (const code of [
    "SNAPSHOT_TRUNCATED", "RUN_DUPLICATE_ID", "RUN_DUPLICATE_KEY", "RUN_WORKSPACE_MISMATCH",
    "RUN_VERSION_MISSING", "RUN_VERSION_HASH_MISMATCH", "RUN_DEAD_LETTER_INFO_MISSING",
    "RUN_COUNTER_INVALID", "VERSION_TAMPERED", "VERSION_WORKSPACE_MISMATCH",
    "ATTEMPT_ORPHAN", "ATTEMPT_WORKSPACE_MISMATCH", "ATTEMPT_DUPLICATE"
  ]) {
    assert.ok(errors.has(code), `${code} expected`);
  }
  assert.equal(report.executionMayResume, false);
});

void test("TC-0718 a terminal run whose version is gone is a review item, not an error", () => {
  const report = analyzeRestoredState(snapshot({
    runs: [run("r1", "completed", { version: 7 })],
    attempts: []
  }));
  assert.equal(report.integrityOk, true);
  assert.deepEqual(codes(report, "review"), ["RUN_VERSION_MISSING"]);
  assert.equal(report.executionMayResume, false);
});

void test("findings contain only codes and identifiers, never payloads", () => {
  const report = analyzeRestoredState(snapshot({ versions: [version({ rule: { ...rule, name: "SECRET-NAME" } })] }));
  assert.equal(JSON.stringify(report).includes("SECRET-NAME"), false);
});

void test("collector reads existing scoped ports and fails closed when truncated", async () => {
  const scope = await scopeFor(WS);
  const { repository } = createInMemoryAutomationRepository(resolver.ownsScope);
  const created = await repository.createDraft(scope, {
    automationId: "automation-1", name: "A", createdBy: "creator-1", draft: rule,
    idempotencyKey: "k1", requestHash: "h1", now: T0
  });
  assert.equal(created.kind, "created");
  assert.equal((await repository.insertVersion(scope, version())).kind, "inserted");

  const history = createInMemoryRunHistoryRepository(resolver.ownsScope);
  history.seedRun(run("r1", "completed", { createdAt: "2026-10-20T10:00:01.000Z" }));
  history.seedRun(run("r2", "queued", { createdAt: "2026-10-20T10:00:02.000Z" }));
  history.seedAttempt(attempt("r1", 0, "succeeded"));

  const outbox = createInMemoryOutboxRepository(resolver.ownsScope);
  await outbox.repository.insertPending(scope, {
    outboxId: "o1", workspaceId: WS, eventType: "task.status_changed", payload: {}, createdAt: T0
  }, undefined);

  const collected = await collectRestoreSnapshot({
    scope, automations: repository, history: history.repository, outbox: outbox.repository, now: NOW
  });
  assert.equal(collected.truncated, false);
  assert.deepEqual(collected.runs.map((item) => item.runId).sort(), ["r1", "r2"]);
  assert.equal(collected.attempts.length, 1);
  assert.equal(collected.versions.length, 1);
  assert.equal(collected.outbox.pending, 1);

  const report = analyzeRestoredState(collected);
  assert.equal(report.integrityOk, true);
  assert.deepEqual(codes(report, "info"), ["OUTBOX_REPUBLISH_EXPECTED"]);

  const capped = await collectRestoreSnapshot({
    scope, automations: repository, history: history.repository, outbox: outbox.repository, now: NOW, maxRuns: 1
  });
  assert.equal(capped.truncated, true);
  assert.equal(analyzeRestoredState(capped).integrityOk, false);

  const forged = { workspaceId: WS } as unknown as WorkspaceScope;
  await assert.rejects(collectRestoreSnapshot({
    scope: forged, automations: repository, history: history.repository, outbox: outbox.repository, now: NOW
  }), /resolver-minted workspace scope/);
});

// ---------------------------------------------------------------------------
// TC-0719 duplicate replay after restoration does not repeat safe idempotent effects
// ---------------------------------------------------------------------------

const notificationFixture = (store: Map<string, string>) => {
  let sendCalls = 0;
  const handler = createNotificationSendHandler({
    directory: { findProjectLeadForRun: () => Promise.resolve({ userId: "lead-1", status: "active" }) },
    notifications: {
      send: (request) => {
        const existing = store.get(request.idempotencyKey);
        if (existing !== undefined) return Promise.resolve({ notificationId: existing, deduplicated: true });
        sendCalls += 1;
        const id = `n-${String(store.size + 1)}`;
        store.set(request.idempotencyKey, id);
        return Promise.resolve({ notificationId: id, deduplicated: false });
      }
    },
    variables: { forRun: () => Promise.resolve({ taskTitle: "Ship v1", actorName: "Sara" }) }
  });
  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => Promise.resolve(true) },
    handlers: createActionHandlerRegistry([handler])
  });
  return { executor, sends: () => sendCalls };
};

void test("TC-0719 replaying a run action after restoration does not repeat the idempotent effect", async () => {
  const scope = await scopeFor("workspace-1");
  const request = {
    scope,
    run: { runId: "run-1", workspaceId: "workspace-1", automationId: "automation-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: { recipient: { type: "project_lead" }, template: "task_completed" } }
  };
  const expectedKey = createHash("sha256").update("run-1:0", "utf8").digest("hex");

  const before = new Map<string, string>();
  const first = notificationFixture(before);
  const sent = await first.executor.execute(request);
  assert.ok(sent.status === "succeeded");
  assert.deepEqual(sent.output, { notificationId: "n-1", status: "sent" });
  assert.equal(sent.idempotencyKey, expectedKey);

  // "Restore": new process and store rebuilt from the backed-up dedupe records. The run is replayed.
  const restoredStore = new Map(before);
  const second = notificationFixture(restoredStore);
  const replayed = await second.executor.execute(request);
  assert.ok(replayed.status === "succeeded");
  assert.deepEqual(replayed.output, { notificationId: "n-1", status: "already_sent" });
  assert.equal(replayed.idempotencyKey, expectedKey);
  assert.equal(second.sends(), 0);
  assert.equal(restoredStore.size, 1);
});

// ---------------------------------------------------------------------------
// TC-0720 unreconciled external outcome is flagged for review
// ---------------------------------------------------------------------------

const TTL = 60_000;

void test("TC-0720 an action running at backup time is flagged before and after lease recovery", async () => {
  const scope = await scopeFor(WS);
  const store = createInMemoryRunRepository(resolver.ownsScope);
  await store.repository.insert(scope, run("r-crash", "queued", { revision: 0, fencingToken: 0 }));
  const claim = await store.repository.claimNext(scope, "worker-a", T0, TTL);
  assert.ok(claim.kind === "claimed");
  await store.repository.insertActionAttempt(scope, attempt("r-crash", 0, "pending", { actionType: "test.external" }));
  store.startAction(WS, "r-crash", 0);

  const collect = async (now: string): Promise<RestoredSnapshot> => {
    const stored = await store.repository.findById(scope, "r-crash");
    if (!stored) throw new Error("Seeded run must exist.");
    return snapshot({
      takenAt: now,
      runs: [stored],
      attempts: await store.repository.listActionAttempts(scope, "r-crash")
    });
  };

  // Right after restore: still "running", lease long expired, action possibly performed.
  const before = analyzeRestoredState(await collect(NOW), externalActions);
  assert.deepEqual(before.recoverableRunIds, ["r-crash"]);
  assert.deepEqual(before.reviewRequired.map((item) => [item.code, item.repeatSafe]), [
    ["ATTEMPT_RUNNING_AT_RESTORE", false]
  ]);
  assert.equal(before.executionMayResume, false);

  // The reaper runs; the effect is now an explicit unknown_outcome that must be reconciled.
  const recovered = await store.repository.recoverExpiredLeases(scope, NOW, 10);
  assert.equal(recovered.length, 1);
  const after = analyzeRestoredState(await collect(NOW), externalActions);
  assert.deepEqual(after.recoverableRunIds, []);
  assert.deepEqual(after.reviewRequired.map((item) => [item.code, item.subjectId, item.repeatSafe]), [
    ["ATTEMPT_UNKNOWN_OUTCOME", "r-crash#0.1", false]
  ]);
  assert.equal(after.integrityOk, true);
  assert.equal(after.executionMayResume, false);
});

void test("TC-0720 a repeat-safe unknown outcome is still flagged but does not block resume", () => {
  const report = analyzeRestoredState(snapshot({
    runs: [run("r1", "queued")],
    attempts: [attempt("r1", 0, "unknown_outcome", { actionType: "notification.send" })]
  }));
  assert.deepEqual(report.reviewRequired.map((item) => [item.code, item.repeatSafe]), [
    ["ATTEMPT_UNKNOWN_OUTCOME", true]
  ]);
  assert.equal(report.executionMayResume, true);
});

void test("TC-0720 an unknown or unregistered action type is never treated as repeat-safe", () => {
  for (const actionType of ["evil.unregistered", undefined]) {
    const withoutType: ActionAttempt = Object.freeze({
      runId: "r1", workspaceId: WS, actionIndex: 0, attempt: 1,
      status: "unknown_outcome" as const, createdAt: T0, updatedAt: T0
    });
    const report = analyzeRestoredState(snapshot({
      runs: [run("r1", "queued")],
      attempts: [actionType === undefined ? withoutType : attempt("r1", 0, "unknown_outcome", { actionType })]
    }));
    assert.equal(report.reviewRequired[0]?.repeatSafe, false);
    assert.equal(report.executionMayResume, false);
  }
});

void test("a live lease right after restore is not trusted", () => {
  const report = analyzeRestoredState(snapshot({
    runs: [run("r1", "running", { leaseOwner: "w", leaseExpiresAt: "2026-10-20T13:00:00.000Z" })]
  }));
  assert.deepEqual(codes(report, "review"), ["RUN_LEASE_ACTIVE_AFTER_RESTORE"]);
  assert.equal(report.executionMayResume, false);
});

// ---------------------------------------------------------------------------
// RPO / RTO measurement
// ---------------------------------------------------------------------------

void test("measureRecovery reports data-loss window, restore duration and recovery time", () => {
  assert.deepEqual(measureRecovery({
    backupPointInTime: "2026-10-20T10:00:00.000Z",
    incidentAt: "2026-10-20T10:05:00.000Z",
    restoreStartedAt: "2026-10-20T10:10:00.000Z",
    restoreFinishedAt: "2026-10-20T10:25:00.000Z",
    serviceVerifiedAt: "2026-10-20T10:40:00.000Z"
  }), { ok: true, dataLossWindowMs: 300_000, restoreDurationMs: 900_000, recoveryTimeMs: 2_100_000 });

  const base = {
    backupPointInTime: T0, incidentAt: T0, restoreStartedAt: T0, restoreFinishedAt: T0, serviceVerifiedAt: T0
  };
  assert.deepEqual(measureRecovery({ ...base, incidentAt: "nope" }), { ok: false, code: "INVALID_TIME" });
  assert.deepEqual(
    measureRecovery({ ...base, backupPointInTime: "2026-10-20T11:00:00.000Z" }),
    { ok: false, code: "OUT_OF_ORDER" }
  );
});