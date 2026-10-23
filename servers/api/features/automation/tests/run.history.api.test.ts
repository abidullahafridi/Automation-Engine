import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import express from "express";
import { createPrincipalResolver, type PolicyPort } from "../automation.ports.js";
import { createInMemoryAutomationRepository } from "../automation.repository.js";
import { createAutomationRoutes } from "../automation.routes.js";
import { createAutomationApplicationService } from "../automation.service.js";
import { createInMemoryRunHistoryRepository } from "../run.history.repository.js";
import { createRunHistoryService } from "../run.history.service.js";
import type { ActionAttempt, StoredRun } from "../run.repository.js";

const T0 = "2026-10-18T10:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1_000).toISOString();

const makeRun = (
  runId: string,
  automationId: string,
  createdAt: string,
  workspaceId = "workspace-1"
): StoredRun => Object.freeze({
  runId,
  eventId: `event-${runId}`,
  workspaceId,
  automationId,
  version: 1,
  contentHash: "hash-1",
  status: "completed" as const,
  revision: 3,
  fencingToken: 2,
  runAfter: createdAt,
  createdAt,
  updatedAt: createdAt,
  leaseOwner: "worker-secret",
  chainKey: "chain-1",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
});

const makeAttempt = (
  runId: string,
  actionIndex: number,
  attempt: number,
  status: ActionAttempt["status"],
  workspaceId = "workspace-1"
): ActionAttempt => Object.freeze({
  runId,
  workspaceId,
  actionIndex,
  attempt,
  status,
  createdAt: T0,
  updatedAt: T0,
  actionType: "notification.send"
});

type RunBody = Readonly<{
  runId: string;
  revision: number;
  version: number;
  contentHash: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  attemptCount?: number;
  actions?: readonly { actionIndex: number; attempt: number; status: string }[];
  failure?: { failureCode?: string };
}>;
type ListBody = Readonly<{ runs: readonly RunBody[]; nextCursor: string | null }>;
type DetailBody = Readonly<{ run: RunBody; error?: { code: string } }>;
type ErrorBody = Readonly<{ error?: { code: string } }>;

const createFixture = () => {
  let nextId = 0;
  const resolver = createPrincipalResolver({
    authenticate: (credential) => Promise.resolve(
      credential === "valid-user" || credential === "restricted-user"
        ? { type: "user", id: credential }
        : undefined
    ),
    hasWorkspaceMembership: (_principal, workspaceId) =>
      Promise.resolve(workspaceId === "workspace-1" || workspaceId === "workspace-2")
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
  const history = createInMemoryRunHistoryRepository(resolver.ownsScope);
  const runHistory = createRunHistoryService({
    history: history.repository,
    automations: service,
    policy,
    ownsScope: resolver.ownsScope
  });
  return { resolver, policy, service, history, runHistory };
};

type Fixture = ReturnType<typeof createFixture>;

const createAutomation = async (
  fixture: Fixture,
  key: string,
  workspaceId = "workspace-1"
): Promise<string> => {
  const resolution = await fixture.resolver.resolve({
    credential: "valid-user",
    requestedWorkspaceId: workspaceId
  });
  if (resolution.kind !== "resolved") throw new Error("Fixture principal must resolve.");
  const created = await fixture.service.createDraft(resolution.scope, resolution.principal, {
    name: `Automation ${key}`,
    draft: { incomplete: true },
    idempotencyKey: key
  });
  if (created.kind === "idempotency-conflict") throw new Error("Unexpected idempotency conflict.");
  return created.automation.automationId;
};

const startApp = async (fixture: Fixture) => {
  const app = express();
  app.use(express.json());
  app.use(createAutomationRoutes({
    resolver: fixture.resolver,
    policy: fixture.policy,
    service: fixture.service,
    runHistory: fixture.runHistory
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

const get = (
  baseUrl: string,
  path: string,
  credential: string | null = "valid-user"
): Promise<Response> => fetch(`${baseUrl}${path}`, {
  headers: credential === null ? {} : { authorization: `Bearer ${credential}` }
});

const runsPath = (automationId: string, workspaceId = "workspace-1"): string =>
  `/api/v1/workspaces/${workspaceId}/automations/${automationId}/runs`;
const runPath = (runId: string, workspaceId = "workspace-1"): string =>
  `/api/v1/workspaces/${workspaceId}/automation-runs/${runId}`;

void test("TC-0521 same-workspace run history and run detail are visible", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await createAutomation(fixture, "tc-0521");
  fixture.history.seedRun(makeRun("run-1", automationId, at(1)));
  fixture.history.seedRun(makeRun("run-2", automationId, at(2)));
  fixture.history.seedRun(makeRun("run-3", automationId, at(3)));
  fixture.history.seedAttempt(makeAttempt("run-3", 1, 1, "succeeded"));
  fixture.history.seedAttempt(makeAttempt("run-3", 0, 2, "succeeded"));
  fixture.history.seedAttempt(makeAttempt("run-3", 0, 1, "failed"));

  const list = await get(app.baseUrl, runsPath(automationId));
  assert.equal(list.status, 200);
  const listBody = await list.json() as ListBody;
  assert.deepEqual(listBody.runs.map((item) => item.runId), ["run-3", "run-2", "run-1"]);
  assert.equal(listBody.nextCursor, null);
  const first = listBody.runs[0];
  assert.ok(first);
  assert.equal(first.version, 1);
  assert.equal(first.contentHash, "hash-1");
  assert.equal(first.status, "completed");
  assert.equal(first.createdAt, at(3));
  assert.equal("actions" in first, false);

  const detail = await get(app.baseUrl, runPath("run-3"));
  assert.equal(detail.status, 200);
  const detailBody = await detail.json() as DetailBody;
  assert.equal(detailBody.run.runId, "run-3");
  assert.equal(detailBody.run.version, 1);
  assert.equal(detailBody.run.contentHash, "hash-1");
  assert.equal(detailBody.run.revision, 3);
  assert.equal(detailBody.run.updatedAt, at(3));
  assert.equal(detailBody.run.attemptCount, 3);
  assert.deepEqual(
    detailBody.run.actions?.map((action) => [action.actionIndex, action.attempt, action.status]),
    [[0, 1, "failed"], [0, 2, "succeeded"], [1, 1, "succeeded"]]
  );
});

void test("TC-0522 cross-workspace and unauthorized history is hidden", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await createAutomation(fixture, "tc-0522");
  const otherAutomationId = await createAutomation(fixture, "tc-0522-other", "workspace-2");
  fixture.history.seedRun(makeRun("run-own", automationId, at(1)));
  // Same automationId string, different workspace: must never be listed for workspace-1.
  fixture.history.seedRun(makeRun("run-foreign", automationId, at(2), "workspace-2"));
  fixture.history.seedRun(makeRun("run-other", otherAutomationId, at(3), "workspace-2"));

  const own = await get(app.baseUrl, runsPath(automationId));
  const ownBody = await own.json() as ListBody;
  assert.deepEqual(ownBody.runs.map((item) => item.runId), ["run-own"]);

  assert.equal((await get(app.baseUrl, runsPath(automationId, "workspace-2"))).status, 404);
  assert.equal((await get(app.baseUrl, runPath("run-own", "workspace-2"))).status, 404);
  assert.equal((await get(app.baseUrl, runPath("run-foreign"))).status, 404);
  assert.equal((await get(app.baseUrl, runPath("run-other"))).status, 404);
  assert.equal((await get(app.baseUrl, runPath("missing-run"))).status, 404);
  assert.equal((await get(app.baseUrl, runsPath("missing-automation"))).status, 404);

  const deniedList = await get(app.baseUrl, runsPath(automationId), "restricted-user");
  assert.equal(deniedList.status, 404);
  assert.equal(((await deniedList.json()) as ErrorBody).error?.code, "AUTOMATION_NOT_FOUND");
  assert.equal((await get(app.baseUrl, runPath("run-own"), "restricted-user")).status, 404);
  assert.equal((await get(app.baseUrl, runsPath(automationId), null)).status, 401);
  assert.equal((await get(app.baseUrl, runPath("run-own"), null)).status, 401);
});

void test("TC-0523 pagination is stable while new runs arrive", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await createAutomation(fixture, "tc-0523");
  fixture.history.seedRun(makeRun("run-1", automationId, at(1)));
  fixture.history.seedRun(makeRun("run-2", automationId, at(2)));
  // Three runs share a timestamp: runId descending is the deterministic tiebreak.
  fixture.history.seedRun(makeRun("run-3", automationId, at(3)));
  fixture.history.seedRun(makeRun("run-3a", automationId, at(3)));
  fixture.history.seedRun(makeRun("run-3b", automationId, at(3)));
  fixture.history.seedRun(makeRun("run-4", automationId, at(4)));
  fixture.history.seedRun(makeRun("run-5", automationId, at(5)));

  const first = await get(app.baseUrl, `${runsPath(automationId)}?limit=2`);
  const firstBody = await first.json() as ListBody;
  assert.deepEqual(firstBody.runs.map((item) => item.runId), ["run-5", "run-4"]);
  assert.notEqual(firstBody.nextCursor, null);

  // A newer run lands between page requests; it must not shift or duplicate later pages.
  fixture.history.seedRun(makeRun("run-6", automationId, at(6)));

  const seen: string[] = firstBody.runs.map((item) => item.runId);
  let cursor = firstBody.nextCursor;
  let pages = 1;
  while (cursor !== null) {
    pages += 1;
    assert.ok(pages <= 10, "pagination must terminate");
    const page = await get(
      app.baseUrl,
      `${runsPath(automationId)}?limit=2&cursor=${encodeURIComponent(cursor)}`
    );
    assert.equal(page.status, 200);
    const body = await page.json() as ListBody;
    seen.push(...body.runs.map((item) => item.runId));
    cursor = body.nextCursor;
  }
  assert.deepEqual(seen, ["run-5", "run-4", "run-3b", "run-3a", "run-3", "run-2", "run-1"]);
  assert.equal(new Set(seen).size, seen.length);

  const fresh = await get(app.baseUrl, `${runsPath(automationId)}?limit=1`);
  assert.deepEqual(((await fresh.json()) as ListBody).runs.map((item) => item.runId), ["run-6"]);

  assert.equal((await get(app.baseUrl, `${runsPath(automationId)}?limit=0`)).status, 400);
  assert.equal((await get(app.baseUrl, `${runsPath(automationId)}?limit=101`)).status, 400);
  assert.equal((await get(app.baseUrl, `${runsPath(automationId)}?cursor=not*valid`)).status, 400);
});

void test("TC-0524 secrets, inputs, and internal fields are redacted from history", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await createAutomation(fixture, "tc-0524");
  const leaky = {
    ...makeRun("run-leaky", automationId, at(1)),
    status: "dead_letter" as const,
    interruptedReason: "LEASE_EXPIRED",
    input: { password: "hunter2-sentinel" },
    secret: "run-secret-sentinel",
    deadLetter: {
      reason: "MAX_ATTEMPTS_EXHAUSTED" as const,
      attempts: 5,
      firstAttemptAt: at(0),
      deadLetteredAt: at(2),
      failureCode: "provider token=sk-live-123 failed",
      errorClass: "transient" as const,
      actionIndex: 0
    }
  } as unknown as StoredRun;
  fixture.history.seedRun(leaky);
  fixture.history.seedAttempt({
    ...makeAttempt("run-leaky", 0, 1, "failed"),
    input: { password: "attempt-sentinel" }
  } as unknown as ActionAttempt);

  const forbidden = /hunter2-sentinel|attempt-sentinel|run-secret-sentinel|worker-secret|sk-live-123|fencingToken|leaseOwner|leaseExpiresAt|traceparent|chainKey|chain-1/;

  const listText = await (await get(app.baseUrl, runsPath(automationId))).text();
  assert.doesNotMatch(listText, forbidden);

  const detailResponse = await get(app.baseUrl, runPath("run-leaky"));
  assert.equal(detailResponse.status, 200);
  const detailText = await detailResponse.text();
  assert.doesNotMatch(detailText, forbidden);
  const detail = JSON.parse(detailText) as DetailBody;
  assert.deepEqual(Object.keys(detail.run).sort(), [
    "actions",
    "attemptCount",
    "automationId",
    "contentHash",
    "createdAt",
    "eventId",
    "failure",
    "interruptedReason",
    "revision",
    "runAfter",
    "runId",
    "status",
    "updatedAt",
    "version"
  ]);
  assert.match(detail.run.failure?.failureCode ?? "", /\[REDACTED\]/);
  const action = detail.run.actions?.[0];
  assert.ok(action);
  assert.deepEqual(Object.keys(action).sort(), [
    "actionIndex",
    "actionType",
    "attempt",
    "createdAt",
    "status",
    "updatedAt"
  ]);
});
