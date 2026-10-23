import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import express from "express";
import { createInMemoryAuditStore } from "../audit.port.js";
import { createPrincipalResolver, type PolicyPort } from "../automation.ports.js";
import { createInMemoryAutomationRepository } from "../automation.repository.js";
import { createAutomationRoutes } from "../automation.routes.js";
import { createAutomationApplicationService } from "../automation.service.js";
import { createAutomationLifecycleTransitionService } from "../lifecycle.transition.service.js";
import { validateRuleDraft } from "../rule.validation.js";
import { hashRuleDocument, type LifecycleAuditAction } from "../version.lifecycle.service.js";

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

type ResponseBody = Readonly<{
  automation?: { status: string; revision: number };
  error?: { code: string };
}>;

const createFixture = () => {
  let nextId = 0;
  const now = "2026-10-14T12:00:00Z";
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
  const auditStore = createInMemoryAuditStore(resolver.ownsScope);
  const clock = { now: () => now };
  const rng = { nextId: () => `id-${String(++nextId)}` };
  const service = createAutomationApplicationService({ repository, clock, rng });
  const lifecycle = createAutomationLifecycleTransitionService({
    repository,
    policy,
    auditPort: auditStore.auditPort,
    clock,
    rng
  });
  return { resolver, policy, repository, auditStore, service, lifecycle, now };
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

const seedAutomation = async (
  fixture: Fixture,
  key: string,
  published: boolean
): Promise<string> => {
  const { scope, principal } = await resolveScope(fixture);
  const created = await fixture.service.createDraft(scope, principal, {
    name: `Automation ${key}`,
    draft: validDraft,
    idempotencyKey: key
  });
  if (created.kind === "idempotency-conflict") throw new Error("Unexpected idempotency conflict.");
  const automationId = created.automation.automationId;
  if (!published) return automationId;

  const validation = validateRuleDraft(validDraft);
  if (!validation.valid) throw new Error("Fixture draft must be valid.");
  const hash = hashRuleDocument(validation.rule);
  if (!hash.success) throw new Error("Fixture rule must be hashable.");
  const inserted = await fixture.repository.insertVersion(scope, {
    automationId,
    workspaceId: scope.workspaceId,
    version: 1,
    schemaVersion: 1,
    contentHash: hash.contentHash,
    publishKey: `publish-${key}`,
    rule: validation.rule,
    createdAt: fixture.now
  });
  if (inserted.kind === "conflict") throw new Error("Fixture version insert conflicted.");
  const updated = await fixture.repository.compareAndSetCurrentVersion(
    scope,
    automationId,
    created.automation.rev,
    1
  );
  if (updated !== "updated") throw new Error("Fixture version pointer was not set.");
  return automationId;
};

const startApp = async (fixture: Fixture) => {
  const app = express();
  app.use(express.json());
  app.use(createAutomationRoutes({
    resolver: fixture.resolver,
    policy: fixture.policy,
    service: fixture.service,
    lifecycle: fixture.lifecycle
  }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => { resolve(); }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    })
  };
};

const lifecyclePost = (
  baseUrl: string,
  automationId: string,
  action: LifecycleAuditAction,
  revision: number | undefined,
  credential: string | null = "valid-user",
  workspaceId = "workspace-1"
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (credential !== null) headers.authorization = `Bearer ${credential}`;
  if (revision !== undefined) headers["if-match"] = `"${String(revision)}"`;
  return fetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/automations/${automationId}/${action}`, {
    method: "POST",
    headers
  });
};

const readBody = async (response: Response): Promise<ResponseBody> =>
  await response.json() as ResponseBody;

void test("TC-0501 allowed lifecycle transitions work end to end and are audited", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const automationId = await seedAutomation(fixture, "tc-0501", true);

  const steps: readonly Readonly<{ action: LifecycleAuditAction; revision: number; status: string }>[] = [
    { action: "enable", revision: 1, status: "enabled" },
    { action: "pause", revision: 2, status: "paused" },
    { action: "resume", revision: 3, status: "enabled" },
    { action: "disable", revision: 4, status: "disabled" },
    { action: "archive", revision: 5, status: "archived" }
  ];
  for (const step of steps) {
    const response = await lifecyclePost(app.baseUrl, automationId, step.action, step.revision);
    assert.equal(response.status, 200, step.action);
    assert.equal(response.headers.get("etag"), `"${String(step.revision + 1)}"`);
    const body = await readBody(response);
    assert.ok(body.automation);
    assert.equal(body.automation.status, step.status);
    assert.equal(body.automation.revision, step.revision + 1);
  }

  const { scope } = await resolveScope(fixture);
  const events = await fixture.auditStore.read(scope, automationId);
  assert.deepEqual(events.map((event) => [event.action, event.outcome]), [
    ["enable", "succeeded"],
    ["pause", "succeeded"],
    ["resume", "succeeded"],
    ["disable", "succeeded"],
    ["archive", "succeeded"]
  ]);
});

void test("TC-0502 illegal transitions return stable errors and change nothing", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const { scope } = await resolveScope(fixture);

  const published = await seedAutomation(fixture, "tc-0502-a", true);
  const pauseDraft = await lifecyclePost(app.baseUrl, published, "pause", 1);
  assert.equal(pauseDraft.status, 409);
  assert.equal((await readBody(pauseDraft)).error?.code, "AUTOMATION_INVALID_TRANSITION");
  const archiveDraft = await lifecyclePost(app.baseUrl, published, "archive", 1);
  assert.equal(archiveDraft.status, 409);
  assert.equal((await readBody(archiveDraft)).error?.code, "AUTOMATION_INVALID_TRANSITION");

  const unpublished = await seedAutomation(fixture, "tc-0502-b", false);
  const enableUnpublished = await lifecyclePost(app.baseUrl, unpublished, "enable", 0);
  assert.equal(enableUnpublished.status, 409);
  assert.equal((await readBody(enableUnpublished)).error?.code, "AUTOMATION_NOT_PUBLISHED");

  const unchanged = await fixture.repository.findById(scope, published);
  assert.ok(unchanged);
  assert.equal(unchanged.status, "draft");
  assert.equal(unchanged.rev, 1);
  assert.deepEqual(await fixture.auditStore.read(scope, published), []);
});

void test("TC-0503 insufficient permission is rejected without leaking state", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const { scope } = await resolveScope(fixture);
  const automationId = await seedAutomation(fixture, "tc-0503", true);

  const denied = await lifecyclePost(app.baseUrl, automationId, "enable", 1, "restricted-user");
  assert.equal(denied.status, 404);
  assert.equal((await readBody(denied)).error?.code, "AUTOMATION_NOT_FOUND");
  // Stale revision plus illegal action must still look identical to "not found".
  const deniedStale = await lifecyclePost(app.baseUrl, automationId, "archive", 999, "restricted-user");
  assert.equal(deniedStale.status, 404);

  assert.equal((await lifecyclePost(app.baseUrl, automationId, "enable", 1, null)).status, 401);  assert.equal((await lifecyclePost(app.baseUrl, automationId, "enable", 1, "valid-user", "workspace-2")).status, 404);
  assert.equal((await lifecyclePost(app.baseUrl, "missing-automation", "enable", 1)).status, 404);
  const missingIfMatch = await lifecyclePost(app.baseUrl, automationId, "enable", undefined);
  assert.equal(missingIfMatch.status, 400);
  assert.equal((await readBody(missingIfMatch)).error?.code, "AUTOMATION_INVALID_REQUEST");

  const unchanged = await fixture.repository.findById(scope, automationId);
  assert.equal(unchanged?.status, "draft");
  const events = await fixture.auditStore.read(scope, automationId);
  assert.ok(events.length >= 2);
  assert.ok(events.every((event) => event.outcome === "denied"));
});

void test("TC-0504 stale and concurrent edits are rejected with a revision conflict", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const { scope } = await resolveScope(fixture);

  const stale = await seedAutomation(fixture, "tc-0504-a", true);
  const staleResponse = await lifecyclePost(app.baseUrl, stale, "enable", 0);
  assert.equal(staleResponse.status, 409);
  assert.equal((await readBody(staleResponse)).error?.code, "AUTOMATION_REVISION_CONFLICT");

  const contested = await seedAutomation(fixture, "tc-0504-b", true);
  const responses = await Promise.all([
    lifecyclePost(app.baseUrl, contested, "enable", 1),
    lifecyclePost(app.baseUrl, contested, "enable", 1)
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const loser = responses.find((response) => response.status === 409);
  assert.ok(loser);
  assert.equal((await readBody(loser)).error?.code, "AUTOMATION_REVISION_CONFLICT");

  const final = await fixture.repository.findById(scope, contested);
  assert.ok(final);
  assert.equal(final.status, "enabled");
  assert.equal(final.rev, 2);
  const events = await fixture.auditStore.read(scope, contested);
  assert.equal(events.length, 1);
});

void test("TC-0505 repeated enable returns a documented conflict, never a silent duplicate", async (context) => {
  const fixture = createFixture();
  const app = await startApp(fixture);
  context.after(async () => { await app.close(); });
  const { scope } = await resolveScope(fixture);
  const automationId = await seedAutomation(fixture, "tc-0505", true);

  assert.equal((await lifecyclePost(app.baseUrl, automationId, "enable", 1)).status, 200);

  const sameRevision = await lifecyclePost(app.baseUrl, automationId, "enable", 1);
  assert.equal(sameRevision.status, 409);
  assert.equal((await readBody(sameRevision)).error?.code, "AUTOMATION_REVISION_CONFLICT");

  const freshRevision = await lifecyclePost(app.baseUrl, automationId, "enable", 2);
  assert.equal(freshRevision.status, 409);
  assert.equal((await readBody(freshRevision)).error?.code, "AUTOMATION_INVALID_TRANSITION");

  const final = await fixture.repository.findById(scope, automationId);
  assert.equal(final?.rev, 2);
  assert.equal((await fixture.auditStore.read(scope, automationId)).length, 1);
});