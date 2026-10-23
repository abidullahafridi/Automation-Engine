import assert from "node:assert/strict";
import test from "node:test";
import {
  automationRepositoryMethodNames,
  createInMemoryAutomationRepository
} from "../automation.repository.js";
import { createPrincipalResolver } from "../automation.ports.js";
import type { WorkspaceScope } from "../automation.ports.js";
import type { RuleDocument } from "../rule.validation.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({
    credential: `user-${workspaceId}`,
    requestedWorkspaceId: workspaceId
  });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const draft = Object.freeze({ schemaVersion: 1, name: "Draft" });
const publishedRule: RuleDocument = {
  schemaVersion: 1,
  name: "Rule",
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

void test("tenant matrix covers every repository method and rejects missing/forged scope before driver calls", async () => {
  const { repository, driverCallCount } = createInMemoryAutomationRepository(resolver.ownsScope);
  assert.deepEqual(
    Object.keys(repository).sort(),
    [...automationRepositoryMethodNames].sort()
  );
  const ownScope = await scopeFor("workspace-a");
  const otherScope = await scopeFor("workspace-b");
  const createdA = await repository.createDraft(ownScope, {
    automationId: "automation-a",
    name: "A",
    createdBy: "user-a",
    draft,
    idempotencyKey: "create-a",
    requestHash: "hash-a",
    now: "2026-10-14T12:00:00Z"
  });
  const createdB = await repository.createDraft(otherScope, {
    automationId: "automation-b",
    name: "B",
    createdBy: "user-b",
    draft,
    idempotencyKey: "create-b",
    requestHash: "hash-b",
    now: "2026-10-14T12:00:00Z"
  });
  assert.equal(createdA.kind, "created");
  assert.equal(createdB.kind, "created");
const missingScopeArgs: Readonly<Record<(typeof automationRepositoryMethodNames)[number], readonly unknown[]>> = {
    createDraft: [{
      automationId: "missing-scope",
      name: "missing",
      createdBy: "user",
      draft,
      idempotencyKey: "missing",
      requestHash: "hash",
      now: "2026-10-14T12:00:00Z"
    }],
    findById: ["automation-a"],
    list: [{ after: undefined, limit: 10 }],
    updateDraft: ["automation-a", 0, draft, "2026-10-14T12:00:00Z"],
    insertVersion: [{
      automationId: "automation-a",
      workspaceId: "workspace-a",
      version: 1,
      schemaVersion: 1,
      contentHash: "hash",
      publishKey: "publish-a",
      rule: publishedRule,
      createdAt: "2026-10-14T12:00:00Z"
    }],
    findVersionByPublishKey: ["automation-a", "publish-a"],
    listVersions: ["automation-a"],
    compareAndSetCurrentVersion: ["automation-a", 0, 1], // <--- Yahan comma (,) add kar diya hai
    transitionStatus: ["dummy-automation-id", "DRAFT", {}],
  };
  for (const methodName of automationRepositoryMethodNames) {
    const before = driverCallCount();
    const invocation: unknown = Reflect.apply(
      repository[methodName],
      repository,
      [undefined, ...missingScopeArgs[methodName]]
    );
    if (!(invocation instanceof Promise)) throw new Error(`${methodName} must return a promise.`);
    await assert.rejects(
      invocation
    );
    assert.equal(driverCallCount(), before, `${methodName} must validate scope before storage access`);
  }

  assert.equal(await repository.findById(otherScope, "automation-a"), undefined);
  assert.equal(await repository.findById(ownScope, "automation-b"), undefined);
  assert.equal(await repository.updateDraft(otherScope, "automation-a", 0, draft, "2026-10-14T12:01:00Z"), "not-found");
  assert.equal(await repository.updateDraft(ownScope, "automation-b", 0, draft, "2026-10-14T12:01:00Z"), "not-found");
  assert.deepEqual((await repository.list(ownScope, { after: undefined, limit: 10 })).items.map(({ automationId }) => automationId), ["automation-a"]);
});

void test("create idempotency returns the original draft and rejects key reuse with a different payload", async () => {
  const { repository } = createInMemoryAutomationRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-idempotent");
  const input = {
    automationId: "automation-original",
    name: "Original",
    createdBy: "user-1",
    draft,
    idempotencyKey: "same-key",
    requestHash: "same-request",
    now: "2026-10-14T12:00:00Z"
  };
  assert.equal((await repository.createDraft(scope, input)).kind, "created");
  const replay = await repository.createDraft(scope, {
    ...input,
    automationId: "ignored-new-id",
    now: "2026-10-14T12:01:00Z"
  });
  assert.ok(replay.kind === "idempotent");
  assert.equal(replay.automation.automationId, "automation-original");
  assert.equal((await repository.createDraft(scope, { ...input, requestHash: "different-request" })).kind, "idempotency-conflict");
});
