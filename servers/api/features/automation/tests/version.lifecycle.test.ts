import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationLifecycle,
  hashRuleDocument,
  pinActiveVersion,
  publishAutomationDraft,
  resolvePinnedVersion,
  saveAutomationDraft,
  verifyPublishedVersionHash
} from "../version.lifecycle.service.js";
import type {
  AutomationLifecycleState,
  LifecycleMutationResult
} from "../version.lifecycle.service.js";

const ruleDraft = (name = "Notify project lead when a task is completed") => ({
  schemaVersion: 1,
  name,
  trigger: {
    type: "task.status_changed",
    config: { toStatus: "done", allowAutomationOrigin: false }
  },
  conditions: {
    all: [
      { field: "task.isArchived", op: "eq", value: false },
      { field: "task.priority", op: "in", value: ["high", "urgent"] }
    ]
  },
  actions: [{
    type: "notification.send",
    config: { recipient: { type: "project_lead" }, template: "task_completed" },
    onStale: "skip"
  }],
  executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
});

const successfulState = (result: LifecycleMutationResult): AutomationLifecycleState => {
  if (!result.ok) throw new Error("Expected lifecycle operation to succeed.");
  return result.state;
};

void test("TC-0122 valid draft publishes an immutable version with a content hash", () => {
  const created = createAutomationLifecycle("automation-1");
  const saved = successfulState(saveAutomationDraft(created, 0, ruleDraft()));
  const published = successfulState(publishAutomationDraft(saved, 1));
  const version = published.versions[0];
  assert.ok(version);
  assert.equal(version.automationId, "automation-1");
  assert.equal(version.version, 1);
  assert.match(version.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(verifyPublishedVersionHash(version), true);
  assert.equal(published.activeVersion, 1);
  assert.equal(published.revision, 2);
  assert.equal(Object.isFrozen(version), true);
  assert.equal(Object.isFrozen(version.rule), true);
  assert.equal(Object.isFrozen(version.rule.actions), true);
});

void test("invalid draft does not create or activate an executable version", () => {
  const created = createAutomationLifecycle("automation-1");
  const saved = successfulState(saveAutomationDraft(created, 0, { ...ruleDraft(), schemaVersion: 2 }));
  const result = publishAutomationDraft(saved, 1);
  assert.equal(result.ok, false);
  assert.equal(saved.activeVersion, null);
  assert.equal(saved.versions.length, 0);

  assert.equal(saveAutomationDraft(created, 0, {
    ...ruleDraft(),
    executionPolicy: { onActionFailure: "stop", maxAttempts: Number.POSITIVE_INFINITY }
  }).ok, false);
});

void test("TC-0123 stale expectedRevision returns a conflict instead of success", () => {
  const initial = createAutomationLifecycle("automation-1");
  const firstEdit = successfulState(saveAutomationDraft(initial, 0, ruleDraft()));
  const competingEdit = saveAutomationDraft(firstEdit, 0, ruleDraft("Concurrent edit"));
  assert.deepEqual(competingEdit, {
    ok: false,
    kind: "conflict",
    code: "AUTOMATION_REVISION_CONFLICT",
    expectedRevision: 0,
    actualRevision: 1
  });
  assert.deepEqual(publishAutomationDraft(firstEdit, 0), {
    ok: false,
    kind: "conflict",
    code: "AUTOMATION_REVISION_CONFLICT",
    expectedRevision: 0,
    actualRevision: 1
  });
});

void test("TC-0124 publishing a new draft never mutates an existing published version", () => {
  const initial = createAutomationLifecycle("automation-1");
  const savedFirst = successfulState(saveAutomationDraft(initial, 0, ruleDraft()));
  const publishedFirst = successfulState(publishAutomationDraft(savedFirst, 1));
  const firstVersion = publishedFirst.versions[0];
  assert.ok(firstVersion);
  assert.equal(Reflect.set(firstVersion.rule, "name", "Tampered"), false);
  const savedSecond = successfulState(saveAutomationDraft(
    publishedFirst,
    2,
    ruleDraft("Notify project lead when a task is reopened")
  ));
  const publishedSecond = successfulState(publishAutomationDraft(savedSecond, 3));
  assert.equal(publishedSecond.versions.length, 2);
  assert.equal(publishedSecond.versions[0], firstVersion);
  assert.equal(firstVersion.version, 1);
  assert.equal(firstVersion.rule.name, "Notify project lead when a task is completed");
  assert.equal(publishedSecond.versions[1]?.version, 2);
  assert.equal(publishedSecond.activeVersion, 2);
});

void test("TC-0125 run version pin resolves to the original immutable version after a later publish", () => {
  const initial = createAutomationLifecycle("automation-1");
  const savedFirst = successfulState(saveAutomationDraft(initial, 0, ruleDraft()));
  const publishedFirst = successfulState(publishAutomationDraft(savedFirst, 1));
  const runPin = pinActiveVersion(publishedFirst);
  assert.ok(runPin);

  const savedSecond = successfulState(saveAutomationDraft(
    publishedFirst,
    2,
    ruleDraft("A later automation version")
  ));
  const publishedSecond = successfulState(publishAutomationDraft(savedSecond, 3));
  const resolved = resolvePinnedVersion(publishedSecond, runPin);
  assert.ok(resolved.ok);
  assert.equal(resolved.version.version, 1);
  assert.equal(resolved.version.rule.name, "Notify project lead when a task is completed");
});

void test("canonical SHA-256 is stable across object key order and rejects undefined and non-finite values", () => {
  const first = hashRuleDocument({ b: 2, a: { d: 4, c: 3 } });
  const reordered = hashRuleDocument({ a: { c: 3, d: 4 }, b: 2 });
  assert.equal(first.success, true);
  assert.deepEqual(first, reordered);
  assert.deepEqual(hashRuleDocument({}), {
    success: true,
    contentHash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
  });
  assert.equal(hashRuleDocument({ value: Number.NaN }).success, false);
  assert.equal(hashRuleDocument({ value: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(hashRuleDocument({ value: undefined }).success, false);
  const hiddenUndefined = Object.defineProperty({}, "value", {
    value: undefined,
    enumerable: false
  });
  assert.equal(hashRuleDocument(hiddenUndefined).success, false);
});

void test("pinned-version loading verifies the stored content hash", () => {
  const initial = createAutomationLifecycle("automation-1");
  const saved = successfulState(saveAutomationDraft(initial, 0, ruleDraft()));
  const published = successfulState(publishAutomationDraft(saved, 1));
  const version = published.versions[0];
  assert.ok(version);
  const alteredVersion = { ...version, rule: { ...version.rule, name: "Tampered" } };
  const alteredState = {
    ...published,
    versions: [alteredVersion]
  };
  const pin = { automationId: version.automationId, version: version.version, contentHash: version.contentHash };
  assert.deepEqual(resolvePinnedVersion(alteredState, pin), {
    ok: false,
    issue: {
      code: "AUTOMATION_VERSION_HASH_MISMATCH",
      path: "",
      message: "Published version content hash does not match."
    }
  });
});
