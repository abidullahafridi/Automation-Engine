import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createServer } from "../../../bootstrap/index.js";
import type { ApiConfig } from "../../../types/index.js";
import {
  createAutomationApplicationService,
  createInMemoryAutomationRepository,
  createPrincipalResolver,
  createDenyAllPrincipalResolver,
  createDenyAllPolicyPort,
  createInMemoryScheduleRepository,
  createScheduleService,
  publishAutomationVersion
} from "../index.js";
import type { PolicyPort } from "../automation.ports.js";

const logger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const enabledConfig: ApiConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  requestTimeoutMs: 30_000,
  webOrigin: "http://localhost:3000",
  logLevel: "silent",
  automationApiEnabled: true
};

const createApiFixture = () => {
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
    rng: { nextId: () => `automation-${String(++nextId)}` }
  });
  const schedules = createScheduleService({
    repository: createInMemoryScheduleRepository(resolver.ownsScope),
    ownsScope: resolver.ownsScope,
    clock: { now: () => "2026-10-14T12:00:00Z" }
  });
  return {
    resolver,
    policy,
    repository,
    service,
    schedules
  };
};

void test("published drafts accept local event intake through the injected matcher", async (context) => {
  const fixture = createApiFixture();
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const server = createServer({
    app: createApp({
      config: enabledConfig,
      logger,
      automationApi: {
        resolver: fixture.resolver,
        policy: fixture.policy,
        service: fixture.service,
        publisher: ({ scope, automationId, expectedRevision, publishKey }) =>
          publishAutomationVersion(fixture.repository, scope, automationId, expectedRevision, publishKey, "2026-10-20T12:00:00.000Z"),
        eventMatcher: {
          match: (_scope, _event) => Promise.resolve({ kind: "matched", candidateCount: 1, createdRuns: 1, idempotentRuns: 0 })
        }
      }
    }),
    config: enabledConfig,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1`;
  const headers = {
    authorization: "Bearer valid-user",
    "content-type": "application/json",
    "idempotency-key": "local-draft-01"
  };
  const draft = {
    schemaVersion: 1,
    name: "Local demo automation",
    trigger: { type: "task.status_changed", config: { toStatus: "done", allowAutomationOrigin: false } },
    conditions: { field: "task.status", op: "eq", value: "done" },
    actions: [{ type: "notification.send", config: { recipient: { type: "project_lead" }, template: "task_completed" }, onStale: "skip" }],
    executionPolicy: { onActionFailure: "stop", maxAttempts: 1 }
  };
  const created = await fetch(`${base}/automations`, { method: "POST", headers, body: JSON.stringify({ name: draft.name, draft }) });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { automation: { automationId: string; revision: number } };
  const published = await fetch(`${base}/automations/${createdBody.automation.automationId}/publish`, {
    method: "POST",
    headers: { ...headers, "If-Match": `"${String(createdBody.automation.revision)}"`, "Idempotency-Key": "local-publish-01" }
  });
  assert.equal(published.status, 201);
  const publishedBody = await published.json() as { automation: { version: number } };
  assert.equal(publishedBody.automation.version, 1);

  const event = await fetch(`${base}/automation-events/task-status-changed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sample: { task: { status: "done", previousStatus: "in_progress", priority: "medium", isArchived: false } } })
  });
  assert.equal(event.status, 202);
  const eventBody = await event.json() as { createdRuns: number };
  assert.equal(eventBody.createdRuns, 1);
});

void test("automation management API remains absent when the feature flag is off", async (context) => {
  const config: ApiConfig = { ...enabledConfig, automationApiEnabled: false };
  const server = createServer({
    app: (await import("../../../bootstrap/create-app.js")).createApp({ config, logger }),
    config,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automations`);
  assert.equal(response.status, 404);
});

void test("create/list/read enforce resolver and policy ports and support idempotent pagination", async (context) => {
  const fixture = createApiFixture();
  const config = enabledConfig;
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const server = createServer({
    app: createApp({
      config,
      logger,
      automationApi: {
        resolver: fixture.resolver,
        policy: fixture.policy,
        service: fixture.service
      }
    }),
    config,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automations`;
  const headers = {
    authorization: "Bearer valid-user",
    "content-type": "application/json",
    "idempotency-key": "request-001"
  };
  const body = JSON.stringify({ name: "First draft", draft: { incomplete: true } });
  const created = await fetch(baseUrl, { method: "POST", headers, body });
  assert.equal(created.status, 201);
  const firstResult = await created.json() as { automation: { automationId: string } };
  const replay = await fetch(baseUrl, { method: "POST", headers, body });
  assert.equal(replay.status, 200);
  const replayResult = await replay.json() as { automation: { automationId: string } };
  assert.equal(replayResult.automation.automationId, firstResult.automation.automationId);

  const second = await fetch(baseUrl, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "request-002" },
    body: JSON.stringify({ name: "Second draft", draft: { incomplete: true } })
  });
  assert.equal(second.status, 201);
  const idempotencyConflict = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Changed payload", draft: { incomplete: true } })
  });
  assert.equal(idempotencyConflict.status, 409);
  const invalidBody = await fetch(baseUrl, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "invalid-body" },
    body: JSON.stringify({ name: "Invalid", draft: {}, unsupported: true })
  });
  assert.equal(invalidBody.status, 400);
  const invalidBodyResult = await invalidBody.json() as { error: { code: string; path: string } };
  assert.equal(invalidBodyResult.error.code, "AUTOMATION_INVALID_REQUEST");
  assert.equal(invalidBodyResult.error.path, "/unsupported");
    const missingKey = await fetch(baseUrl, {
      method: "POST",
      headers: { authorization: "Bearer valid-user", "content-type": "application/json" },
    body
  });
  assert.equal(missingKey.status, 400);
  const firstPage = await fetch(`${baseUrl}?limit=1`, { headers: { authorization: "Bearer valid-user" } });
  assert.equal(firstPage.status, 200);
  const firstPageBody = await firstPage.json() as { automations: readonly { automationId: string }[]; nextCursor: string | null };
  assert.equal(firstPageBody.automations.length, 1);
  assert.notEqual(firstPageBody.nextCursor, null);
  const insertedBetweenPages = await fetch(baseUrl, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "request-003" },
    body: JSON.stringify({ name: "Inserted between pages", draft: { incomplete: true } })
  });
  assert.equal(insertedBetweenPages.status, 201);
  const insertedBody = await insertedBetweenPages.json() as { automation: { automationId: string } };
  const secondPage = await fetch(`${baseUrl}?limit=1&cursor=${encodeURIComponent(firstPageBody.nextCursor ?? "")}`, {
    headers: { authorization: "Bearer valid-user" }
  });
  const secondPageBody = await secondPage.json() as { automations: readonly { automationId: string }[]; nextCursor: string | null };
  assert.equal(secondPageBody.automations.length, 1);
  const firstPageAutomation = firstPageBody.automations[0];
  const secondPageAutomation = secondPageBody.automations[0];
  assert.ok(firstPageAutomation);
  assert.ok(secondPageAutomation);
  assert.notEqual(firstPageAutomation.automationId, secondPageAutomation.automationId);
  assert.equal(secondPageAutomation.automationId, firstResult.automation.automationId);
  assert.notEqual(secondPageAutomation.automationId, insertedBody.automation.automationId);

  const read = await fetch(`${baseUrl}/${firstResult.automation.automationId}`, {
    headers: { authorization: "Bearer valid-user" }
  });
  assert.equal(read.status, 200);
  const noAuthentication = await fetch(baseUrl);
  assert.equal(noAuthentication.status, 401);
  const invalidAuthorization = await fetch(baseUrl, { headers: { authorization: "valid-user" } });
  assert.equal(invalidAuthorization.status, 401);
  const denied = await fetch(baseUrl, { headers: { authorization: "Bearer restricted-user" } });
  assert.equal(denied.status, 404);
  const otherWorkspace = await fetch(baseUrl.replace("workspace-1", "workspace-2"), {
    headers: { authorization: "Bearer valid-user" }
  });
  assert.equal(otherWorkspace.status, 404);
  const crossWorkspaceDetail = await fetch(
    `${baseUrl.replace("workspace-1", "workspace-2")}/${firstResult.automation.automationId}`,
    { headers: { authorization: "Bearer valid-user" } }
  );
  assert.equal(crossWorkspaceDetail.status, 404);
  const forgedAutomationId = await fetch(`${baseUrl}/automation-not-in-this-workspace`, {
    headers: { authorization: "Bearer valid-user" }
  });
  assert.equal(forgedAutomationId.status, 404);
});

void test("draft validation API returns deterministic safe errors and enforces access", async (context) => {
  const fixture = createApiFixture();
  const config = enabledConfig;
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const server = createServer({
    app: createApp({
      config,
      logger,
      automationApi: {
        resolver: fixture.resolver,
        policy: fixture.policy,
        service: fixture.service
      }
    }),
    config,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const validationUrl = `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automations/validate`;
  const headers = {
    authorization: "Bearer valid-user",
    "content-type": "application/json"
  };
  const draft = {
    schemaVersion: 1,
    name: "Notify project lead",
    trigger: {
      type: "task.status_changed",
      config: { toStatus: "done", allowAutomationOrigin: false }
    },
    conditions: { field: "task.isArchived", op: "eq", value: false },
    actions: [{
      type: "notification.send",
      config: { recipient: { type: "project_lead" }, template: "task_completed" },
      onStale: "skip"
    }],
    executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
  };
  const valid = await fetch(validationUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ draft })
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { valid: true, errors: [] });

  const invalidDraft = {
    ...draft,
    conditions: { field: "task.privateField", op: "exists" },
    actions: [{
      ...draft.actions[0],
      config: {
        recipient: { type: "project_lead" },
        template: "task_completed",
        password: "validation-sensitive-marker"
      }
    }]
  };
  const invalidRequest = JSON.stringify({ draft: invalidDraft });
  const invalidFirst = await fetch(validationUrl, { method: "POST", headers, body: invalidRequest });
  const invalidSecond = await fetch(validationUrl, { method: "POST", headers, body: invalidRequest });
  assert.equal(invalidFirst.status, 200);
  const invalidText = await invalidFirst.text();
  assert.equal(invalidText, await invalidSecond.text());
  assert.doesNotMatch(invalidText, /validation-sensitive-marker/);
  const invalidResult = JSON.parse(invalidText) as {
    valid: boolean;
    errors: readonly { code: string; path: string; message: string }[];
  };
  assert.equal(invalidResult.valid, false);
  assert.deepEqual(invalidResult.errors.map(({ path }) => path), [
    "/actions/0/config/password",
    "/conditions/field"
  ]);

  const malformedBody = await fetch(validationUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ unsupported: true })
  });
  assert.equal(malformedBody.status, 400);
  const unauthenticated = await fetch(validationUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draft })
  });
  assert.equal(unauthenticated.status, 401);
  const denied = await fetch(validationUrl, {
    method: "POST",
    headers: { ...headers, authorization: "Bearer restricted-user" },
    body: JSON.stringify({ draft })
  });
  assert.equal(denied.status, 404);
});

void test("automation API hides unexpected internal errors", async (context) => {
  const fixture = createApiFixture();
  const config = enabledConfig;
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const service = {
    ...fixture.service,
    list: () => Promise.reject(new Error("sensitive internal sentinel"))
  };
  const server = createServer({
    app: createApp({
      config,
      logger,
      automationApi: { ...fixture, service }
    }),
    config,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automations`,
    { headers: { authorization: "Bearer valid-user" } }
  );
  assert.equal(response.status, 500);
  const responseText = await response.text();
  assert.doesNotMatch(responseText, /sensitive internal sentinel|Error:|automation\.routes\.ts/);
  const body = JSON.parse(responseText) as { error: { code: string; message: string } };
  assert.equal(typeof body.error.code, "string");
  assert.equal(typeof body.error.message, "string");
});

void test("schedule API validates, scopes, authorizes and revision-guards schedule management", async (context) => {
  const fixture = createApiFixture();
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const server = createServer({
    app: createApp({
      config: enabledConfig,
      logger,
      automationApi: {
        resolver: fixture.resolver,
        policy: fixture.policy,
        service: fixture.service,
        schedules: fixture.schedules
      }
    }),
    config: enabledConfig,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const root = `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automations`;
  const headers = { authorization: "Bearer valid-user", "content-type": "application/json", "idempotency-key": "schedule-draft" };
  const created = await fetch(root, { method: "POST", headers, body: JSON.stringify({ name: "Scheduled", draft: {} }) });
  assert.equal(created.status, 201);
  const { automation } = await created.json() as { automation: { automationId: string } };
  const base = `${root}/${automation.automationId}/schedule`;

  const unauthenticated = await fetch(base);
  assert.equal(unauthenticated.status, 401);
  const crossWorkspace = await fetch(base.replace("workspace-1", "workspace-2"), { headers: { authorization: "Bearer valid-user" } });
  assert.equal(crossWorkspace.status, 404);
  const insufficient = await fetch(base, { headers: { authorization: "Bearer restricted-user" } });
  assert.equal(insufficient.status, 404);

  const invalid = await fetch(`${base}/validate`, {
    method: "POST", headers,
    body: JSON.stringify({ timezone: "Not/AZone", definition: { kind: "daily", time: "25:61" } })
  });
  assert.equal(invalid.status, 200);
  assert.equal((await invalid.json() as { valid: boolean }).valid, false);

  const createSchedule = await fetch(base, {
    method: "POST", headers,
    body: JSON.stringify({ timezone: "UTC", definition: { kind: "daily", time: "09:30" } })
  });
  assert.equal(createSchedule.status, 201);
  const createdBody = await createSchedule.json() as { schedule: { rev: number; enabled: boolean } };
  assert.equal(createdBody.schedule.enabled, false);
  const read = await fetch(base, { headers: { authorization: "Bearer valid-user" } });
  assert.equal(read.status, 200);
  assert.equal((await read.json() as { occurrences: readonly unknown[] }).occurrences.length, 0);

  const edit = await fetch(base, {
    method: "PUT",
    headers: { ...headers, "if-match": String(createdBody.schedule.rev) },
    body: JSON.stringify({ timezone: "America/New_York", definition: { kind: "daily", time: "10:15" } })
  });
  assert.equal(edit.status, 200);
  const staleEdit = await fetch(base, {
    method: "PUT",
    headers: { ...headers, "if-match": String(createdBody.schedule.rev) },
    body: JSON.stringify({ timezone: "UTC", definition: { kind: "daily", time: "11:00" } })
  });
  assert.equal(staleEdit.status, 409);
});

void test("operations API returns scoped live signals only to authorized workspace users", async (context) => {
  const fixture = createApiFixture();
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const server = createServer({
    app: createApp({
      config: enabledConfig,
      logger,
      automationApi: {
        resolver: fixture.resolver,
        policy: fixture.policy,
        service: fixture.service,
        operations: {
          resolver: fixture.resolver,
          policy: fixture.policy,
          sources: {
            queue: () => Promise.resolve({ queuedCount: 2, oldestEligibleAgeMs: 30_000, expiredRunningCount: 0 }),
            deadLetter: () => Promise.resolve({ count: 0, oldestAgeMs: undefined })
          },
          thresholds: {
            queueAgeMs: { warning: 10_000, critical: 20_000 },
            leaseStalledCount: { warning: 1, critical: 3 },
            outboxAgeMs: { warning: 10_000, critical: 20_000 },
            deadLetter: { warningCount: 2, criticalCount: 5, warningAgeMs: 60_000, criticalAgeMs: 120_000 }
          },
          clock: { now: () => "2026-10-14T12:00:00Z" }
        }
      }
    }),
    config: enabledConfig,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automation-ops`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url.replace("workspace-1", "workspace-2"), { headers: { authorization: "Bearer valid-user" } })).status, 404);
  assert.equal((await fetch(url, { headers: { authorization: "Bearer restricted-user" } })).status, 404);
  const response = await fetch(url, { headers: { authorization: "Bearer valid-user" } });
  assert.equal(response.status, 200);
  const body = await response.json() as { signals: { queue: { queuedCount: number }; failed: readonly string[] }; alerts: { alerts: readonly { ruleId: string }[] } };
  assert.equal(body.signals.queue.queuedCount, 2);
  assert.equal(body.signals.failed.length, 0);
  assert.equal(body.alerts.alerts[0]?.ruleId, "QUEUE_AGE");
});

void test("default deny-everything adapters return 503 service unavailable", async (context) => {
  const denyResolver = createDenyAllPrincipalResolver();
  const denyPolicy = createDenyAllPolicyPort();
  const { repository } = createInMemoryAutomationRepository(denyResolver.ownsScope);
  const service = createAutomationApplicationService({
    repository,
    clock: { now: () => "2026-10-14T12:00:00Z" },
    rng: { nextId: () => "automation-1" }
  });
  const config = enabledConfig;
  const { createApp } = await import("../../../bootstrap/create-app.js");
  const server = createServer({
    app: createApp({
      config,
      logger,
      automationApi: {
        resolver: denyResolver,
        policy: denyPolicy,
        service
      }
    }),
    config,
    logger
  });
  await server.start();
  context.after(async () => { await server.stop(); });
  const address = server.raw.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${String(address.port)}/api/v1/workspaces/workspace-1/automations`;

  const getResponse = await fetch(baseUrl, {
    headers: { authorization: "Bearer some-token" }
  });
  assert.equal(getResponse.status, 503);
  const getBody = await getResponse.json() as { error: { code: string; message: string } };
  assert.equal(getBody.error.code, "AUTOMATION_SERVICE_UNAVAILABLE");

  const postResponse = await fetch(baseUrl, {
    method: "POST",
    headers: {
      authorization: "Bearer some-token",
      "content-type": "application/json",
      "idempotency-key": "deny-key-1"
    },
    body: JSON.stringify({ name: "Draft", draft: { incomplete: true } })
  });
  assert.equal(postResponse.status, 503);
  const postBody = await postResponse.json() as { error: { code: string; message: string } };
  assert.equal(postBody.error.code, "AUTOMATION_SERVICE_UNAVAILABLE");
});
