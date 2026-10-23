import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type Principal, type WorkspaceScope } from "../automation.ports.js";
import {
  createActionRegistry,
  notificationSendAction,
  type ActionRegistry
} from "../automation.registry.js";
import { createDeadLetterService, createInMemoryRecoveryAuditStore } from "../dead-letter.service.js";
import { decideRetry, defaultRetryPolicy } from "../retry.policy.js";
import { isLegalRunTransition, type ActionAttempt, type StoredRun } from "../run.repository.js";
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

const T0 = "2026-10-17T10:00:00.000Z";
const at = (milliseconds: number): string => new Date(Date.parse(T0) + milliseconds).toISOString();

const queuedRun = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-1", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});

type AttemptSeed = Readonly<{
  actionIndex: number;
  attempt: number;
  status: ActionAttempt["status"];
  actionType?: string;
}>;

const idempotentFailure: readonly AttemptSeed[] = [
  { actionIndex: 0, attempt: 5, status: "failed", actionType: "notification.send" }
];

const admin: Principal = { type: "user", id: "admin-1" };

const externalActions: ActionRegistry = createActionRegistry([
  notificationSendAction,
  { ...notificationSendAction, type: "test.external", sideEffect: "external" as const, timeoutMs: Object.freeze({ external: 30 }) }
]);

const setup = async (options: Readonly<{ grants?: readonly string[]; actions?: ActionRegistry }> = {}) => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const audit = createInMemoryRecoveryAuditStore(resolver.ownsScope);
  const counters: string[] = [];
  const grants = new Set(options.grants ?? ["admin-1:automation.run.read", "admin-1:automation.run.replay"]);
  const state = { now: T0, nextId: 0 };
  const scope = await scopeFor("workspace-1");

  const service = createDeadLetterService({
    runs: store.repository,
    policy: { authorize: (principal, permission) => Promise.resolve(grants.has(`${principal.id}:${permission}`)) },
    audit: audit.auditPort,
    metrics: {
      increment: (name, labels) => {
        counters.push(`${name}:${Object.values(labels).join(":")}`);
      }
    },
    clock: { now: () => state.now },
    rng: { nextId: () => `correlation-${String(++state.nextId)}` },
    ownsScope: resolver.ownsScope,
    ...(options.actions === undefined ? {} : { actions: options.actions })
  });

  const seed = async (runId: string, attempts: readonly AttemptSeed[] = idempotentFailure): Promise<StoredRun> => {
    await store.repository.insert(scope, queuedRun(runId));
    const claim = await store.repository.claimNext(scope, "worker-1", state.now, 60_000);
    if (claim.kind !== "claimed") throw new Error("Expected a claim.");
    for (const seeded of attempts) {
      await store.repository.insertActionAttempt(scope, {
        runId,
        workspaceId: scope.workspaceId,
        actionIndex: seeded.actionIndex,
        attempt: seeded.attempt,
        status: seeded.status,
        createdAt: T0,
        updatedAt: T0,
        ...(seeded.actionType === undefined ? {} : { actionType: seeded.actionType })
      });
    }
    const decision = decideRetry(
      { errorClass: "transient", attempt: 5, firstAttemptAt: T0, now: state.now },
      defaultRetryPolicy,
      () => 0.5
    );
    const recorded = await service.recordDeadLetter(scope, {
      runId,
      fencingToken: claim.run.fencingToken,
      decision,
      attempt: 5,
      firstAttemptAt: T0,
      failure: { code: "ACTION_HANDLER_ERROR", errorClass: "transient" },
      actionIndex: 0
    });
    assert.equal(recorded, "dead_lettered");
    const stored = await store.repository.findById(scope, runId);
    if (!stored) throw new Error("Seeded run must exist.");
    return stored;
  };

  return {
    service,
    store,
    audit,
    counters,
    scope,
    seed,
    setNow: (value: string): void => { state.now = value; }
  };
};

void test("TC-0326 exhausted work reaches the dead-letter state with its reason and attempts", async () => {
  const t = await setup();
  const run = await t.seed("r1");

  assert.equal(run.status, "dead_letter");
  assert.equal(run.revision, 2);
  assert.equal(run.leaseOwner, undefined);
  assert.equal(run.leaseExpiresAt, undefined);
  assert.deepEqual(run.deadLetter, {
    reason: "MAX_ATTEMPTS_EXHAUSTED",
    attempts: 5,
    firstAttemptAt: T0,
    deadLetteredAt: T0,
    failureCode: "ACTION_HANDLER_ERROR",
    errorClass: "transient",
    actionIndex: 0
  });

  // dead_letter is reachable only through deadLetterRun and is terminal for the generic table
  assert.equal(isLegalRunTransition("running", "dead_letter"), false);
  assert.equal(isLegalRunTransition("dead_letter", "queued"), false);
  assert.equal(await t.store.repository.transition(t.scope, "r1", run.revision, "dead_letter", "queued", T0), "illegal");

  // observable backlog
  assert.deepEqual(await t.service.backlog(t.scope), { count: 1, oldestAgeMs: 0 });
  t.setNow(at(5_000));
  assert.deepEqual(await t.service.backlog(t.scope), { count: 1, oldestAgeMs: 5_000 });
});

void test("only a dead_letter retry decision with a valid, current fencing token is recorded", async () => {
  const t = await setup();
  const permanent = decideRetry(
    { errorClass: "permanent", attempt: 1, firstAttemptAt: T0, now: T0 },
    defaultRetryPolicy,
    () => 0.5
  );
  const retryable = decideRetry(
    { errorClass: "transient", attempt: 1, firstAttemptAt: T0, now: T0 },
    defaultRetryPolicy,
    () => 0.5
  );
  for (const decision of [permanent, retryable, { decision: "none" as const }]) {
    assert.equal(
      await t.service.recordDeadLetter(t.scope, { runId: "nope", fencingToken: 1, decision, attempt: 5, firstAttemptAt: T0 }),
      "invalid"
    );
  }

  const exhausted = decideRetry(
    { errorClass: "transient", attempt: 5, firstAttemptAt: T0, now: T0 },
    defaultRetryPolicy,
    () => 0.5
  );
  await t.store.repository.insert(t.scope, queuedRun("r-stale"));
  const claim = await t.store.repository.claimNext(t.scope, "worker-1", T0, 60_000);
  if (claim.kind !== "claimed") throw new Error("Expected a claim.");
  assert.equal(
    await t.service.recordDeadLetter(t.scope, {
      runId: "r-stale", fencingToken: claim.run.fencingToken + 1, decision: exhausted, attempt: 5, firstAttemptAt: T0
    }),
    "stale"
  );
  assert.equal((await t.store.repository.findById(t.scope, "r-stale"))?.status, "running");
});

void test("TC-0327 an unauthorized user cannot inspect or retry, and denied attempts are audited", async () => {
  const t = await setup({ grants: ["admin-1:automation.run.read", "admin-1:automation.run.replay", "reader-1:automation.run.read"] });
  const run = await t.seed("r1");
  const stranger: Principal = { type: "user", id: "stranger-1" };
  const retryRequest = { runId: "r1", expectedRevision: run.revision, reason: "Provider outage resolved" };

  assert.deepEqual(await t.service.list(t.scope, stranger, { after: undefined, limit: 10 }), { kind: "not-found" });
  assert.deepEqual(await t.service.get(t.scope, stranger, "r1"), { kind: "not-found" });
  assert.deepEqual(await t.service.retry(t.scope, stranger, retryRequest), { kind: "not-found" });

  // a reader may inspect but not retry
  const reader: Principal = { type: "user", id: "reader-1" };
  assert.equal((await t.service.list(t.scope, reader, { after: undefined, limit: 10 })).kind, "page");
  assert.deepEqual(await t.service.retry(t.scope, reader, retryRequest), { kind: "not-found" });

  const events = await t.audit.read(t.scope, "r1");
  assert.deepEqual(events.map((event) => `${event.actor.id}:${event.outcome}`), ["stranger-1:denied", "reader-1:denied"]);
  const after = await t.store.repository.findById(t.scope, "r1");
  if (!after) throw new Error("Expected the seeded run to exist.");
  assert.equal(after.status, "dead_letter");
  assert.equal(after.revision, run.revision);

  // another workspace never sees these runs, even for a user who holds every permission
  const other = await scopeFor("workspace-2");
  assert.deepEqual(await t.service.list(other, admin, { after: undefined, limit: 10 }), {
    kind: "page", items: [], next: undefined
  });
  assert.deepEqual(await t.service.get(other, admin, "r1"), { kind: "not-found" });
  assert.deepEqual(await t.service.retry(other, admin, retryRequest), { kind: "not-found" });
});

void test("automation principals and missing or oversized reasons are rejected without side effects", async () => {
  const t = await setup();
  const run = await t.seed("r1");
  const base = { runId: "r1", expectedRevision: run.revision };

  const automationPrincipal: Principal = { type: "automation", id: "automation:automation-1" };
  assert.deepEqual(await t.service.retry(t.scope, automationPrincipal, { ...base, reason: "x" }), {
    kind: "invalid", code: "RECOVERY_INVALID_PRINCIPAL"
  });
  for (const reason of ["", "   ", "x".repeat(501)]) {
    assert.deepEqual(await t.service.retry(t.scope, admin, { ...base, reason }), {
      kind: "invalid", code: "RECOVERY_REASON_REQUIRED"
    });
  }
  for (const bad of [
    { ...base, expectedRevision: -1 },
    { ...base, runId: "" },
    { ...base, confirmedActionIndexes: [-1] },
    { ...base, confirmedActionIndexes: Array.from({ length: 11 }, (_, index) => index) }
  ]) {
    assert.deepEqual(await t.service.retry(t.scope, admin, { ...bad, reason: "valid reason" }), {
      kind: "invalid", code: "RECOVERY_INVALID_REQUEST"
    });
  }
  assert.deepEqual(await t.audit.read(t.scope, "r1"), []);
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");
});

void test("TC-0328 an authorized retry requeues the same run and generates an audit record", async () => {
  const t = await setup();
  const run = await t.seed("r1");
  t.setNow(at(1_000));

  const result = await t.service.retry(t.scope, admin, {
    runId: "r1", expectedRevision: run.revision, reason: "  Provider outage resolved\n"
  });
  assert.deepEqual(result, { kind: "requeued", runId: "r1", revision: run.revision + 1 });

  const requeued = await t.store.repository.findById(t.scope, "r1");
  assert.ok(requeued);
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.revision, run.revision + 1);
  assert.equal(requeued.interruptedReason, "DEAD_LETTER_RETRY");
  assert.equal(requeued.runAfter, at(1_000));
  assert.equal("deadLetter" in requeued, false);

  const events = await t.audit.read(t.scope, "r1");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    workspaceId: "workspace-1",
    actor: { type: "user", id: "admin-1" },
    action: "retry",
    target: { type: "run", id: "r1" },
    automationId: "automation-1",
    occurredAt: at(1_000),
    outcome: "succeeded",
    correlationId: "correlation-1",
    reason: "Provider outage resolved",
    confirmedActionIndexes: [],
    change: { status: { from: "dead_letter", to: "queued" } }
  });
  assert.deepEqual(t.counters, ["automation_dead_letter_recovery_total:succeeded"]);

  // the run is claimable again with a newer fencing generation
  const claim = await t.store.repository.claimNext(t.scope, "worker-2", at(1_000), 60_000);
  assert.ok(claim.kind === "claimed");
  assert.equal(claim.run.fencingToken, 2);

  // retrying again is refused and audited as blocked
  const again = await t.service.retry(t.scope, admin, {
    runId: "r1", expectedRevision: requeued.revision, reason: "second try"
  });
  assert.deepEqual(again, { kind: "not-retryable" });
  const last = (await t.audit.read(t.scope, "r1"))[1];
  if (!last) throw new Error("Expected the blocked retry to be audited.");
  assert.equal(last.outcome, "blocked");
  assert.equal(last.blockedCode, "NOT_DEAD_LETTER");
});

void test("a stale expected revision is a conflict and changes nothing", async () => {
  const t = await setup();
  const run = await t.seed("r1");
  const result = await t.service.retry(t.scope, admin, {
    runId: "r1", expectedRevision: run.revision - 1, reason: "stale view"
  });
  assert.deepEqual(result, { kind: "conflict" });
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");
  assert.deepEqual(await t.audit.read(t.scope, "r1"), []);
});

void test("TC-0329 unknown-outcome actions are routed to reconciliation and cannot be confirmed away", async () => {
  const t = await setup();
  const run = await t.seed("r1", [{ actionIndex: 0, attempt: 5, status: "unknown_outcome", actionType: "notification.send" }]);

  for (const confirmedActionIndexes of [undefined, [0]]) {
    const result = await t.service.retry(t.scope, admin, {
      runId: "r1",
      expectedRevision: run.revision,
      reason: "try anyway",
      ...(confirmedActionIndexes === undefined ? {} : { confirmedActionIndexes })
    });
    assert.deepEqual(result, { kind: "blocked", code: "RECONCILIATION_REQUIRED", actionIndexes: [0] });
  }
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");
  const events = await t.audit.read(t.scope, "r1");
  assert.deepEqual(events.map((event) => `${event.outcome}:${event.blockedCode ?? ""}`), [
    "blocked:RECONCILIATION_REQUIRED",
    "blocked:RECONCILIATION_REQUIRED"
  ]);
  assert.deepEqual(t.counters, [
    "automation_dead_letter_recovery_total:blocked",
    "automation_dead_letter_recovery_total:blocked"
  ]);
});

void test("TC-0329 a non-idempotent action needs an explicit per-action confirmation", async () => {
  const t = await setup({ actions: externalActions });
  const run = await t.seed("r1", [{ actionIndex: 0, attempt: 5, status: "failed", actionType: "test.external" }]);
  const request = { runId: "r1", expectedRevision: run.revision, reason: "Provider confirmed nothing was sent" };

  const blocked = await t.service.retry(t.scope, admin, request);
  assert.deepEqual(blocked, { kind: "blocked", code: "UNCONFIRMED_NON_IDEMPOTENT", actionIndexes: [0] });
  assert.equal((await t.store.repository.findById(t.scope, "r1"))?.status, "dead_letter");

  const confirmed = await t.service.retry(t.scope, admin, { ...request, confirmedActionIndexes: [0] });
  assert.equal(confirmed.kind, "requeued");
  const events = await t.audit.read(t.scope, "r1");
  assert.deepEqual(events.map((event) => event.outcome), ["blocked", "succeeded"]);
  assert.deepEqual(events[1]?.confirmedActionIndexes, [0]);
});

void test("TC-0329 an action whose type cannot be resolved fails closed", async () => {
  for (const actionType of ["evil.unregistered", undefined]) {
    const t = await setup();
    const run = await t.seed("r1", [{
      actionIndex: 0,
      attempt: 5,
      status: "failed",
      ...(actionType === undefined ? {} : { actionType })
    }]);
    const result = await t.service.retry(t.scope, admin, {
      runId: "r1", expectedRevision: run.revision, reason: "unknown type", confirmedActionIndexes: [0]
    });
    assert.deepEqual(result, { kind: "blocked", code: "UNKNOWN_ACTION_TYPE", actionIndexes: [0] });
  }
});

void test("an authorized reader lists newest first with a cursor and sees no internal fields", async () => {
  const t = await setup();
  await t.seed("r-a");
  t.setNow(at(1_000));
  await t.seed("r-b");

  const first = await t.service.list(t.scope, admin, { after: undefined, limit: 1 });
  assert.ok(first.kind === "page");
  assert.deepEqual(first.items.map((item) => item.runId), ["r-b"]);
  assert.ok(first.next);
  assert.deepEqual(Object.keys(first.items[0] ?? {}).sort(), ["automationId", "deadLetter", "revision", "runId", "version"]);

  const second = await t.service.list(t.scope, admin, { after: first.next, limit: 1 });
  assert.ok(second.kind === "page");
  assert.deepEqual(second.items.map((item) => item.runId), ["r-a"]);
  assert.equal(second.next, undefined);

  const detail = await t.service.get(t.scope, admin, "r-a");
  assert.ok(detail.kind === "found");
  assert.deepEqual(detail.item.actions, [{ actionIndex: 0, attempt: 5, status: "failed", actionType: "notification.send" }]);
  assert.equal(JSON.stringify(detail).includes("fencingToken"), false);
  assert.equal(JSON.stringify(detail).includes("worker-1"), false);
});

void test("the recovery audit store keeps only allowlisted fields and enforces the trusted scope", async () => {
  const t = await setup();
  const other = await scopeFor("workspace-2");
  const event = {
    workspaceId: "workspace-1",
    actor: { type: "user" as const, id: "admin-1", token: "actor-secret" },
    action: "retry" as const,
    target: { type: "run" as const, id: "r1" },
    automationId: "automation-1",
    occurredAt: T0,
    outcome: "succeeded" as const,
    correlationId: "correlation-x",
    reason: "because",
    confirmedActionIndexes: [],
    change: { status: { from: "dead_letter" as const, to: "queued" as const } },
    apiKey: "top-level-secret"
  };
  await t.audit.auditPort.append(t.scope, event);
  const stored = JSON.stringify(await t.audit.read(t.scope, "r1"));
  assert.equal(stored.includes("actor-secret"), false);
  assert.equal(stored.includes("top-level-secret"), false);

  await assert.rejects(t.audit.auditPort.append(other, event), /Invalid recovery audit event/);
  const forged = { workspaceId: "workspace-1" } as unknown as WorkspaceScope;
  await assert.rejects(t.audit.auditPort.append(forged, event), /resolver-minted workspace scope/);
  await assert.rejects(t.audit.read(forged, "r1"), /resolver-minted workspace scope/);
});

void test("run repository dead-letter methods reject a forged scope and never cross workspaces", async () => {
  const t = await setup();
  await t.seed("r1");
  const forged = { workspaceId: "workspace-1" } as unknown as WorkspaceScope;
  const repository = t.store.repository;
  const detail = { reason: "MAX_ATTEMPTS_EXHAUSTED" as const, attempts: 5, firstAttemptAt: T0 };

  await assert.rejects(repository.deadLetterRun(forged, "r1", 1, T0, detail), /resolver-minted workspace scope/);
  await assert.rejects(repository.listDeadLetters(forged, { after: undefined, limit: 1 }), /resolver-minted workspace scope/);
  await assert.rejects(repository.listActionAttempts(forged, "r1"), /resolver-minted workspace scope/);
  await assert.rejects(repository.requeueDeadLetter(forged, "r1", 0, T0), /resolver-minted workspace scope/);
  await assert.rejects(repository.deadLetterBacklog(forged, T0), /resolver-minted workspace scope/);

  const other = await scopeFor("workspace-2");
  assert.equal(await repository.requeueDeadLetter(other, "r1", 2, T0), "not-found");
  assert.deepEqual(await repository.deadLetterBacklog(other, T0), { count: 0, oldestAgeMs: undefined });
  assert.deepEqual(await repository.listActionAttempts(other, "r1"), []);
});
