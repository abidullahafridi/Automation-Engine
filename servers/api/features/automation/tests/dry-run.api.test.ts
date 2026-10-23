import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import express from "express";
import { createPrincipalResolver, type PolicyPort } from "../automation.ports.js";
import { createInMemoryAutomationRepository } from "../automation.repository.js";
import { createAutomationRoutes } from "../automation.routes.js";
import { createAutomationApplicationService } from "../automation.service.js";
import { createConditionEvaluator } from "../condition.evaluator.js";

const validDraft = {
  schemaVersion: 1,
  name: "Notify project lead",
  trigger: { type: "task.status_changed", config: { toStatus: "done", allowAutomationOrigin: false } },
  conditions: { field: "task.isArchived", op: "eq", value: false },
  actions: [{
    type: "notification.send",
    config: { recipient: { type: "project_lead" }, template: "task_completed" },
    onStale: "skip"
  }],
  executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
};

const groupConditions = {
  all: [
    { field: "task.isArchived", op: "eq", value: false },
    { field: "task.priority", op: "in", value: ["high", "urgent"] }
  ]
};

const fullSample = {
  task: { status: "done", previousStatus: "in_progress", priority: "high", isArchived: false }
};

type ExplanationBody = Readonly<{
  kind: string;
  result: string;
  children?: readonly ExplanationBody[];
}>;

type PreviewBody = Readonly<{
  valid: boolean;
  errors: readonly { code: string; path: string }[];
  preview: null | {
    trigger: { matched: boolean | null };
    conditions: { result: string; explanation: ExplanationBody };
    actions: readonly { type: string; wouldExecute: boolean }[];
    limitations: readonly string[];
    sideEffects: string;
  };
  error?: { code: string };
}>;

const createFixture = () => {
  let nextId = 0;
  const resolver = createPrincipalResolver({
    authenticate: (credential) => Promise.resolve(
      credential === "valid-user" || credential === "restricted-user"
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
    clock: { now: () => "2026-10-14T12:00:00Z" },
    rng: { nextId: () => `id-${String(++nextId)}` }
  });
  return { resolver, policy, repository, service };
};

type Fixture = ReturnType<typeof createFixture>;

const resolveScope = async (fixture: Fixture) => {
  const resolution = await fixture.resolver.resolve({
    credential: "valid-user",
    requestedWorkspaceId: "workspace-1"
  });
  if (resolution.kind !== "resolved") throw new Error("Fixture principal must resolve.");
  return resolution;
};

const seed = async (fixture: Fixture, key: string, draft: unknown): Promise<string> => {
  const { scope, principal } = await resolveScope(fixture);
  const created = await fixture.service.createDraft(scope, principal, {
    name: `Automation ${key}`,
    draft,
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
    service: fixture.service
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

const dryRunPost = (
  baseUrl: string,
  automationId: string,
  body: unknown,
  credential: string | null = "valid-user",
  workspaceId = "workspace-1"
): Promise<Response> => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  return fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/automations/${automationId}/dry-run`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
};

const readBody = async (response: Response): Promise<PreviewBody> =>
  await response.json() as PreviewBody;

void test("TC-0511 positive and negative conditions explain their result", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });

  const single = await seed(fixture, "tc-0511-a", validDraft);
  const positive = await dryRunPost(app.baseUrl, single, { sample: fullSample });
  assert.equal(positive.status, 200);
  const positiveBody = await readBody(positive);
  assert.equal(positiveBody.valid, true);
  assert.ok(positiveBody.preview);
  assert.equal(positiveBody.preview.sideEffects, "none");
  assert.equal(positiveBody.preview.trigger.matched, true);
  assert.equal(positiveBody.preview.conditions.result, "matched");
  assert.equal(positiveBody.preview.conditions.explanation.kind, "predicate");
  const plannedAction = positiveBody.preview.actions[0];
  assert.ok(plannedAction);
  assert.equal(plannedAction.type, "notification.send");
  assert.equal(plannedAction.wouldExecute, true);

  const archived = await dryRunPost(app.baseUrl, single, {
    sample: { task: { ...fullSample.task, isArchived: true } }
  });
  const archivedBody = await readBody(archived);
  assert.ok(archivedBody.preview);
  assert.equal(archivedBody.preview.conditions.result, "not_matched");
  assert.equal(archivedBody.preview.actions[0]?.wouldExecute, false);

  const otherStatus = await dryRunPost(app.baseUrl, single, {
    sample: { task: { ...fullSample.task, status: "open" } }
  });
  const otherStatusBody = await readBody(otherStatus);
  assert.ok(otherStatusBody.preview);
  assert.equal(otherStatusBody.preview.trigger.matched, false);
  assert.equal(otherStatusBody.preview.conditions.result, "matched");
  assert.equal(otherStatusBody.preview.actions[0]?.wouldExecute, false);

  const grouped = await seed(fixture, "tc-0511-b", { ...validDraft, conditions: groupConditions });
  const lowPriority = await dryRunPost(app.baseUrl, grouped, {
    sample: { task: { ...fullSample.task, priority: "low" } }
  });
  const lowBody = await readBody(lowPriority);
  assert.ok(lowBody.preview);
  const group = lowBody.preview.conditions.explanation;
  assert.equal(group.kind, "group");
  assert.equal(group.result, "not_matched");
  assert.ok(group.children);
  assert.deepEqual(group.children.map((child) => child.result), ["matched", "not_matched"]);
});

void test("TC-0512 dry-run changes nothing and has no execution dependencies", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const { scope } = await resolveScope(fixture);
  const automationId = await seed(fixture, "tc-0512", validDraft);

  const before = await fixture.repository.findById(scope, automationId);
  const listBefore = await fixture.service.list(scope, { after: undefined, limit: 100 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await dryRunPost(app.baseUrl, automationId, { sample: fullSample })).status, 200);
  }
  const after = await fixture.repository.findById(scope, automationId);
  const listAfter = await fixture.service.list(scope, { after: undefined, limit: 100 });
  assert.deepEqual(after, before);
  assert.deepEqual(listAfter, listBefore);
  assert.equal(after?.status, "draft");

  const source = readFileSync(resolve("features/automation/dry-run.preview.ts"), "utf8");
  assert.doesNotMatch(
    source,
    /action\.handler|action\.executor|notification\.action|run\.repository|outbox|audit\./
  );
});

void test("TC-0513 inaccessible and missing references are handled safely", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await seed(fixture, "tc-0513", validDraft);

  assert.equal((await dryRunPost(app.baseUrl, automationId, { sample: fullSample }, "valid-user", "workspace-2")).status, 404);
  assert.equal((await dryRunPost(app.baseUrl, "missing-automation", { sample: fullSample })).status, 404);
  const denied = await dryRunPost(app.baseUrl, automationId, { sample: fullSample }, "restricted-user");
  assert.equal(denied.status, 404);
  assert.equal((await readBody(denied)).error?.code, "AUTOMATION_NOT_FOUND");
  assert.equal((await dryRunPost(app.baseUrl, automationId, { sample: fullSample }, null)).status, 401);

  const partial = await dryRunPost(app.baseUrl, automationId, { sample: { task: { status: "done" } } });
  assert.equal(partial.status, 200);
  const partialBody = await readBody(partial);
  assert.ok(partialBody.preview);
  assert.equal(partialBody.preview.conditions.result, "evaluation_error");
  assert.ok(partialBody.preview.limitations.some((item) => item.includes("task.isArchived")));
  assert.ok(partialBody.preview.limitations.some((item) => item.includes("not previewed")));

  const noStatus = await dryRunPost(app.baseUrl, automationId, { sample: { task: {} } });
  const noStatusBody = await readBody(noStatus);
  assert.ok(noStatusBody.preview);
  assert.equal(noStatusBody.preview.trigger.matched, null);

  const incomplete = await seed(fixture, "tc-0513-invalid", { incomplete: true });
  const invalid = await dryRunPost(app.baseUrl, incomplete, { sample: fullSample });
  assert.equal(invalid.status, 200);
  const invalidBody = await readBody(invalid);
  assert.equal(invalidBody.valid, false);
  assert.equal(invalidBody.preview, null);
  assert.ok(invalidBody.errors.length > 0);
});

void test("TC-0514 preview enforces the same parser and resource bounds as execution", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await seed(fixture, "tc-0514", { ...validDraft, conditions: groupConditions });

  const oversized = await dryRunPost(app.baseUrl, automationId, {
    sample: { task: { ...fullSample.task, status: "x".repeat(5_000) } }
  });
  assert.equal(oversized.status, 400);
  assert.equal((await readBody(oversized)).error?.code, "AUTOMATION_LIMIT_EXCEEDED");

  const unknownKey = await dryRunPost(app.baseUrl, automationId, { sample: fullSample, extra: true });
  assert.equal(unknownKey.status, 400);
  assert.equal((await readBody(unknownKey)).error?.code, "AUTOMATION_INVALID_REQUEST");
  const unknownTaskKey = await dryRunPost(app.baseUrl, automationId, {
    sample: { task: { ...fullSample.task, secret: "x" } }
  });
  assert.equal(unknownTaskKey.status, 400);
  assert.equal((await dryRunPost(app.baseUrl, automationId, {})).status, 400);

  const tooManyNodes = await seed(fixture, "tc-0514-nodes", {
    ...validDraft,
    conditions: {
      all: Array.from({ length: 50 }, () => ({ field: "task.isArchived", op: "eq", value: false }))
    }
  });
  const overLimit = await dryRunPost(app.baseUrl, tooManyNodes, { sample: fullSample });
  assert.equal(overLimit.status, 200);
  const overLimitBody = await readBody(overLimit);
  assert.equal(overLimitBody.valid, false);
  assert.equal(overLimitBody.errors[0]?.code, "AUTOMATION_LIMIT_EXCEEDED");

  const response = await dryRunPost(app.baseUrl, automationId, { sample: fullSample });
  const body = await readBody(response);
  assert.ok(body.preview);
  const direct = createConditionEvaluator()(groupConditions, fullSample);
  assert.equal(body.preview.conditions.result, direct.status);
});