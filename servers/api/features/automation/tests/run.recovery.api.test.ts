import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import express from "express";
import { createPrincipalResolver, type PolicyPort, type WorkspaceScope } from "../automation.ports.js";
import { createInMemoryAutomationRepository } from "../automation.repository.js";
import { createAutomationRoutes } from "../automation.routes.js";
import { createAutomationApplicationService } from "../automation.service.js";
import { createDeadLetterService, createInMemoryRecoveryAuditStore } from "../dead-letter.service.js";
import { createInMemoryRecoveryIdempotencyStore } from "../run.recovery.idempotency.js";
import { createRunRecoveryService } from "../run.recovery.service.js";
import type { ActionAttempt, RunRepository, StoredRun } from "../run.repository.js";
import type { ActionMetricsPort } from "../action.outcome.js";

const T0 = "2026-10-18T10:00:00.000Z";

const makeRun = (runId: string, status: StoredRun["status"] = "dead_letter"): StoredRun => Object.freeze({
  runId,
  eventId: `event-${runId}`,
  workspaceId: "workspace-1",
  automationId: "automation-1",
  version: 1,
  contentHash: "hash-1",
  status,
  revision: 4,
  fencingToken: 2,
  runAfter: T0,
  createdAt: T0,
  updatedAt: T0
});

const makeAttempt = (runId: string, status: ActionAttempt["status"]): ActionAttempt => Object.freeze({
  runId,
  workspaceId: "workspace-1",
  actionIndex: 0,
  attempt: 1,
  status,
  createdAt: T0,
  updatedAt: T0,
  actionType: "notification.send"
});

/** Minimal fake: only the RunRepository methods the recovery paths call are implemented. */
const createFakeRuns = () => {
  const runs = new Map<string, StoredRun>();
  const attempts: ActionAttempt[] = [];
  let requeueCalls = 0;
  const repository = {
    findById: (scope: WorkspaceScope, runId: string) => {
      const found = runs.get(runId);
      return Promise.resolve(found && found.workspaceId === scope.workspaceId ? found : undefined);
    },
    listActionAttempts: (scope: WorkspaceScope, runId: string) => Promise.resolve(
      attempts.filter((item) => item.workspaceId === scope.workspaceId && item.runId === runId)
    ),
    requeueDeadLetter: (scope: WorkspaceScope, runId: string, expectedRevision: number, now: string) => {
      const found = runs.get(runId);
      if (!found || found.workspaceId !== scope.workspaceId) return Promise.resolve("not-found" as const);
      if (found.status !== "dead_letter" || found.revision !== expectedRevision) return Promise.resolve("stale" as const);
      requeueCalls += 1;
      runs.set(runId, Object.freeze({
        ...found, status: "queued" as const, revision: found.revision + 1, updatedAt: now
      }));
      return Promise.resolve("requeued" as const);
    },
    insert: (scope: WorkspaceScope, run: StoredRun) => {
      if (runs.has(run.runId)) return Promise.resolve("idempotent" as const);
      runs.set(run.runId, run);
      return Promise.resolve("created" as const);
    }
  };
  return {
    // The unimplemented members are never reached by the recovery service.
    repository: repository as unknown as RunRepository,
    seed: (run: StoredRun) => { runs.set(run.runId, run); },
    seedAttempt: (attempt: ActionAttempt) => { attempts.push(attempt); },
    get: (runId: string) => runs.get(runId),
    all: () => [...runs.values()],
    requeueCalls: () => requeueCalls
  };
};

type RecoveryBody = Readonly<{
  recovery?: { operation: string; runId: string; revision?: number; replayRunId?: string; idempotentReplay: boolean };
  error?: { code: string };
}>;

const createFixture = () => {
  let nextId = 0;
  const resolver = createPrincipalResolver({
    authenticate: (credential) => Promise.resolve(
      credential === "valid-user" || credential === "restricted-user" || credential === "other-user"
        ? { type: "user", id: credential }
        : undefined
    ),
    hasWorkspaceMembership: (_principal, workspaceId) => Promise.resolve(workspaceId === "workspace-1")
  });
  const policy: PolicyPort = {
    authorize: (principal) => Promise.resolve(principal.id !== "restricted-user")
  };
  const { repository } = createInMemoryAutomationRepository(resolver.ownsScope);
  const service = createAutomationApplicationService({
    repository,
    clock: { now: () => "2026-10-18T09:00:00Z" },
    rng: { nextId: () => `id-${String(++nextId)}` }
  });
  const fakeRuns = createFakeRuns();
  const auditStore = createInMemoryRecoveryAuditStore(resolver.ownsScope);
  const metrics: ActionMetricsPort = {
    increment: () => undefined
  };
  const clock = { now: () => "2026-10-18T11:00:00.000Z" };
  const rng = { nextId: () => `corr-${String(++nextId)}` };
  const deadLetters = createDeadLetterService({
    runs: fakeRuns.repository,
    policy,
    audit: auditStore.auditPort,
    metrics,
    clock,
    rng,
    ownsScope: resolver.ownsScope
  });
  const recovery = createRunRecoveryService({
    runs: fakeRuns.repository,
    deadLetters,
    policy,
    audit: auditStore.auditPort,
    metrics,
    idempotency: createInMemoryRecoveryIdempotencyStore(resolver.ownsScope),
    clock,
    rng,
    ownsScope: resolver.ownsScope
  });
  return { resolver, policy, service, fakeRuns, auditStore, recovery };
};

type Fixture = ReturnType<typeof createFixture>;

const resolveScope = async (fixture: Fixture) => {
  const resolution = await fixture.resolver.resolve({ credential: "valid-user", requestedWorkspaceId: "workspace-1" });
  if (resolution.kind !== "resolved") throw new Error("Fixture principal must resolve.");
  return resolution.scope;
};

const startApp = async (fixture: Fixture) => {
  const app = express();
  app.use(express.json());
  app.use(createAutomationRoutes({
    resolver: fixture.resolver,
    policy: fixture.policy,
    service: fixture.service,
    recovery: fixture.recovery
  }));
  const server: Server = createServer(app);
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", () => { done(); }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((done, fail) => {
      server.close((error) => { if (error) fail(error); else done(); });
    })
  };
};

const post = (
  baseUrl: string,
  runId: string,
  operation: "retry" | "replay",
  options: Readonly<{
    credential?: string | null;
    key?: string | null;
    revision?: number | null;
    body?: unknown;
  }> = {}
): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const credential = options.credential === undefined ? "valid-user" : options.credential;
  const key = options.key === undefined ? "key-1" : options.key;
  const revision = options.revision === undefined ? 4 : options.revision;
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  if (key !== null) headers["idempotency-key"] = key;
  if (revision !== null && operation === "retry") headers["if-match"] = `"${String(revision)}"`;
  return fetch(`${baseUrl}/api/v1/workspaces/workspace-1/automation-runs/${runId}/${operation}`, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? { reason: "Provider outage is resolved" })
  });
};

const readBody = async (response: Response): Promise<RecoveryBody> => await response.json() as RecoveryBody;

void test("TC-0525 safe retry continues one logical operation; replay creates one linked run", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const scope = await resolveScope(fixture);

  fixture.fakeRuns.seed(makeRun("run-retry"));
  fixture.fakeRuns.seedAttempt(makeAttempt("run-retry", "failed"));
  const retry = await post(app.baseUrl, "run-retry", "retry");
  assert.equal(retry.status, 200);
  const retryBody = await readBody(retry);
  assert.ok(retryBody.recovery);
  assert.equal(retryBody.recovery.operation, "retry");
  assert.equal(retryBody.recovery.revision, 5);
  assert.equal(retryBody.recovery.idempotentReplay, false);
  assert.equal(fixture.fakeRuns.get("run-retry")?.status, "queued");
  assert.equal(fixture.fakeRuns.requeueCalls(), 1);
  assert.deepEqual(
    (await fixture.auditStore.read(scope, "run-retry")).map((event) => [event.action, event.outcome]),
    [["retry", "succeeded"]]
  );

  fixture.fakeRuns.seed(makeRun("run-replay"));
  fixture.fakeRuns.seedAttempt(makeAttempt("run-replay", "failed"));
  const replay = await post(app.baseUrl, "run-replay", "replay", { key: "replay-key" });
  assert.equal(replay.status, 201);
  const replayBody = await readBody(replay);
  assert.ok(replayBody.recovery);
  assert.equal(replayBody.recovery.operation, "replay");
  const replayRunId = replayBody.recovery.replayRunId;
  assert.ok(replayRunId);
  const created = fixture.fakeRuns.get(replayRunId);
  assert.ok(created);
  assert.equal(created.status, "queued");
  assert.equal(created.replayOf, "run-replay");
  assert.equal(created.automationId, "automation-1");
  assert.equal(created.contentHash, "hash-1");
  assert.equal(fixture.fakeRuns.get("run-replay")?.status, "dead_letter");
  assert.deepEqual(
    (await fixture.auditStore.read(scope, "run-replay")).map((event) => [event.action, event.outcome]),
    [["replay", "succeeded"]]
  );
});

void test("TC-0526 unauthorized, unauthenticated, and malformed recovery is denied", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const scope = await resolveScope(fixture);
  fixture.fakeRuns.seed(makeRun("run-denied"));
  fixture.fakeRuns.seedAttempt(makeAttempt("run-denied", "failed"));

  for (const operation of ["retry", "replay"] as const) {
    const denied = await post(app.baseUrl, "run-denied", operation, { credential: "restricted-user" });
    assert.equal(denied.status, 404);
    assert.equal((await readBody(denied)).error?.code, "AUTOMATION_NOT_FOUND");
    assert.equal((await post(app.baseUrl, "run-denied", operation, { credential: null })).status, 401);
    assert.equal((await post(app.baseUrl, "missing-run", operation)).status, 404);
    assert.equal((await post(app.baseUrl, "run-denied", operation, { key: null })).status, 400);
    assert.equal((await post(app.baseUrl, "run-denied", operation, { body: { reason: "   " } })).status, 400);
    assert.equal((await post(app.baseUrl, "run-denied", operation, { body: { reason: "ok", extra: true } })).status, 400);
  }
  assert.equal((await post(app.baseUrl, "run-denied", "retry", { revision: null })).status, 400);

  assert.equal(fixture.fakeRuns.get("run-denied")?.status, "dead_letter");
  assert.equal(fixture.fakeRuns.all().length, 1);
  assert.equal(fixture.fakeRuns.requeueCalls(), 0);
  const events = await fixture.auditStore.read(scope, "run-denied");
  assert.ok(events.length >= 2);
  assert.ok(events.every((event) => event.outcome === "denied"));
});

void test("TC-0527 recovery with an ambiguous action outcome is refused", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const scope = await resolveScope(fixture);
  fixture.fakeRuns.seed(makeRun("run-ambiguous"));
  fixture.fakeRuns.seedAttempt(makeAttempt("run-ambiguous", "unknown_outcome"));

  for (const operation of ["retry", "replay"] as const) {
    const response = await post(app.baseUrl, "run-ambiguous", operation, {
      key: `ambiguous-${operation}`,
      body: { reason: "Try anyway", confirmedActionIndexes: [0] }
    });
    assert.equal(response.status, 409);
    assert.equal((await readBody(response)).error?.code, "AUTOMATION_RUN_RECOVERY_BLOCKED");
  }
  assert.equal(fixture.fakeRuns.get("run-ambiguous")?.status, "dead_letter");
  assert.equal(fixture.fakeRuns.all().length, 1);
  assert.equal(fixture.fakeRuns.requeueCalls(), 0);
  const events = await fixture.auditStore.read(scope, "run-ambiguous");
  assert.deepEqual(events.map((event) => event.outcome), ["blocked", "blocked"]);

  fixture.fakeRuns.seed(makeRun("run-completed", "completed"));
  const notReplayable = await post(app.baseUrl, "run-completed", "replay");
  assert.equal(notReplayable.status, 409);
  assert.equal((await readBody(notReplayable)).error?.code, "AUTOMATION_RUN_NOT_RETRYABLE");
});

void test("TC-0528 duplicate client requests never start a second recovery", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const scope = await resolveScope(fixture);

  fixture.fakeRuns.seed(makeRun("run-dup"));
  fixture.fakeRuns.seedAttempt(makeAttempt("run-dup", "failed"));
  const first = await post(app.baseUrl, "run-dup", "retry");
  assert.equal(first.status, 200);
  const second = await post(app.baseUrl, "run-dup", "retry");
  assert.equal(second.status, 200);
  const secondBody = await readBody(second);
  assert.ok(secondBody.recovery);
  assert.equal(secondBody.recovery.idempotentReplay, true);
  assert.equal(secondBody.recovery.revision, 5);
  assert.equal(fixture.fakeRuns.requeueCalls(), 1);
  assert.equal((await fixture.auditStore.read(scope, "run-dup")).length, 1);

  const reused = await post(app.baseUrl, "run-dup", "retry", { body: { reason: "A different reason" } });
  assert.equal(reused.status, 422);
  assert.equal((await readBody(reused)).error?.code, "AUTOMATION_IDEMPOTENCY_KEY_REUSED");
  // Another principal using the same key must not receive the first user's receipt.
  const otherUser = await post(app.baseUrl, "run-dup", "retry", { credential: "other-user" });
  assert.equal(otherUser.status, 409);
  assert.equal(fixture.fakeRuns.requeueCalls(), 1);

  fixture.fakeRuns.seed(makeRun("run-replay-dup"));
  fixture.fakeRuns.seedAttempt(makeAttempt("run-replay-dup", "failed"));
  const replays = await Promise.all([
    post(app.baseUrl, "run-replay-dup", "replay", { key: "same-replay" }),
    post(app.baseUrl, "run-replay-dup", "replay", { key: "same-replay" })
  ]);
  assert.ok(replays.every((response) => response.status === 200 || response.status === 201 || response.status === 409));
  assert.ok(replays.some((response) => response.status === 201));
  const replayRuns = fixture.fakeRuns.all().filter((run) => run.replayOf === "run-replay-dup");
  assert.equal(replayRuns.length, 1);

  const again = await post(app.baseUrl, "run-replay-dup", "replay", { key: "same-replay" });
  assert.equal(again.status, 200);
  const againBody = await readBody(again);
  assert.ok(againBody.recovery);
  assert.equal(againBody.recovery.idempotentReplay, true);
  assert.equal(fixture.fakeRuns.all().filter((run) => run.replayOf === "run-replay-dup").length, 1);
});