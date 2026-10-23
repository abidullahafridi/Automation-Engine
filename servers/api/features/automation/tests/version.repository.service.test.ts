import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryAutomationRepository
} from "../automation.repository.js";
import { createPrincipalResolver } from "../automation.ports.js";
import { publishAutomationVersion } from "../version.repository.service.js";
import type { RuleDocument } from "../rule.validation.js";
import type { AutomationRepository } from "../automation.repository.js";

const rule: RuleDocument = {
  schemaVersion: 1,
  name: "Publish safely",
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

const setup = async (repositoryOverride?: (repository: AutomationRepository) => AutomationRepository) => {
  const resolver = createPrincipalResolver({
    authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
    hasWorkspaceMembership: () => Promise.resolve(true)
  });
  const resolved = await resolver.resolve({
    credential: "user-1",
    requestedWorkspaceId: "workspace-1"
  });
  if (resolved.kind !== "resolved") throw new Error("Expected test scope resolution.");
  const base = createInMemoryAutomationRepository(resolver.ownsScope).repository;
  const repository = repositoryOverride ? repositoryOverride(base) : base;
  await repository.createDraft(resolved.scope, {
    automationId: "automation-1",
    name: "Automation",
    createdBy: "user-1",
    draft: rule,
    idempotencyKey: "create-key",
    requestHash: "request-hash",
    now: "2026-10-14T12:00:00Z"
  });
  return { repository, scope: resolved.scope };
};

void test("publishing inserts an immutable version, advances the revision, and is retry-idempotent", async () => {
  const { repository, scope } = await setup();
  const first = await publishAutomationVersion(
    repository,
    scope,
    "automation-1",
    0,
    "publish-key",
    "2026-10-14T12:01:00Z"
  );
  assert.ok(first.ok);
  assert.equal(first.version.version, 1);
  assert.equal(first.revision, 1);
  assert.equal(Object.isFrozen(first.version), true);
  assert.equal(Object.isFrozen(first.version.rule), true);

  const replay = await publishAutomationVersion(
    repository,
    scope,
    "automation-1",
    0,
    "publish-key",
    "2026-10-14T12:02:00Z"
  );
  assert.ok(replay.ok);
  assert.equal(replay.idempotent, true);
  assert.equal((await repository.listVersions(scope, "automation-1")).length, 1);
});

void test("orphan version after a racing header update is harmless and retry-safe", async () => {
  let causeRace = true;
  const { repository, scope } = await setup((base) => Object.freeze({
    ...base,
    insertVersion: async (insertScope, version) => {
      if (causeRace) {
        causeRace = false;
        await base.updateDraft(insertScope, "automation-1", 0, rule, "2026-10-14T12:00:30Z");
      }
      return base.insertVersion(insertScope, version);
    }
  }));

  const conflicted = await publishAutomationVersion(
    repository,
    scope,
    "automation-1",
    0,
    "publish-race",
    "2026-10-14T12:01:00Z"
  );
  assert.deepEqual(conflicted, {
    ok: false,
    kind: "conflict",
    code: "AUTOMATION_REVISION_CONFLICT"
  });
  assert.equal((await repository.listVersions(scope, "automation-1")).length, 1);

  const retried = await publishAutomationVersion(
    repository,
    scope,
    "automation-1",
    1,
    "publish-race",
    "2026-10-14T12:02:00Z"
  );
  assert.ok(retried.ok);
  assert.equal(retried.version.version, 1);
  assert.equal(retried.revision, 2);
  assert.equal(retried.idempotent, true);
});

void test("new publish after an orphan uses the next unused version number", async () => {
  const { repository, scope } = await setup();
  const first = await publishAutomationVersion(
    repository, scope, "automation-1", 0, "first-publish", "2026-10-14T12:01:00Z"
  );
  assert.equal(first.ok, true);
  const changed = await repository.updateDraft(scope, "automation-1", 1, rule, "2026-10-14T12:02:00Z");
  assert.equal(changed, "updated");
  const second = await publishAutomationVersion(
    repository, scope, "automation-1", 2, "second-publish", "2026-10-14T12:03:00Z"
  );
  assert.ok(second.ok);
  assert.equal(second.version.version, 2);
});

void test("version unique key rejects a different publication for the same version number", async () => {
  const { repository, scope } = await setup();
  const first = await publishAutomationVersion(
    repository, scope, "automation-1", 0, "first-publish", "2026-10-14T12:01:00Z"
  );
  assert.ok(first.ok);
  const collision = await repository.insertVersion(scope, {
    ...first.version,
    publishKey: "different-publish-key"
  });
  assert.equal(collision.kind, "conflict");
});
