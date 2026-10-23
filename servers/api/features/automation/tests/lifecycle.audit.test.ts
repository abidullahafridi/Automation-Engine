import assert from "node:assert/strict";
import test from "node:test";
import {
  createAutomationLifecycle,
  publishAutomationDraft,
  saveAutomationDraft,
  transitionAutomationLifecycle
} from "../version.lifecycle.service.js";
import type {
  AutomationLifecycleState,
  LifecycleMutationResult,
  LifecycleTransitionInput
} from "../version.lifecycle.service.js";

const ruleDraft = () => ({
  schemaVersion: 1,
  name: "Audit lifecycle transitions",
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
});

const successfulState = (result: LifecycleMutationResult): AutomationLifecycleState => {
  if (!result.ok) throw new Error("Expected lifecycle operation to succeed.");
  return result.state;
};

const transition = (
  state: AutomationLifecycleState,
  action: LifecycleTransitionInput["action"],
  authorized: boolean,
  correlationId = `correlation-${String(state.auditEvents.length + 1)}`
): LifecycleMutationResult => transitionAutomationLifecycle(state, {
  action,
  expectedRevision: state.revision,
  authorized,
  audit: {
    workspaceId: "workspace-1",
    actor: { type: "user", id: "user-1" },
    occurredAt: "2026-10-14T12:00:00Z",
    correlationId
  }
});

const publishedState = (): AutomationLifecycleState => {
  const initial = createAutomationLifecycle("automation-1");
  const saved = successfulState(saveAutomationDraft(initial, 0, ruleDraft()));
  return successfulState(publishAutomationDraft(saved, 1));
};

void test("TC-0126 successful lifecycle transitions append one actor/version audit record", () => {
  const initial = publishedState();
  const enabled = transition(initial, "enable", true);
  assert.ok(enabled.ok);
  assert.equal(enabled.state.status, "enabled");
  assert.equal(enabled.state.auditEvents.length, 1);
  assert.deepEqual(enabled.state.auditEvents[0], {
    workspaceId: "workspace-1",
    actor: { type: "user", id: "user-1" },
    action: "enable",
    target: { type: "automation", id: "automation-1" },
    occurredAt: "2026-10-14T12:00:00Z",
    outcome: "succeeded",
    correlationId: "correlation-1",
    change: { status: { from: "draft", to: "enabled" }, version: 1 }
  });

  const paused = transition(enabled.state, "pause", true);
  assert.ok(paused.ok);
  const disabled = transition(paused.state, "disable", true);
  assert.ok(disabled.ok);
  const archived = transition(disabled.state, "archive", true);
  assert.ok(archived.ok);
  assert.equal(archived.state.status, "archived");
  assert.deepEqual(archived.state.auditEvents.map((event) => event.action), [
    "enable", "pause", "disable", "archive"
  ]);
});

void test("TC-0127 denied transition is recorded as denied and does not change lifecycle status", () => {
  const initial = publishedState();
  const denied = transition(initial, "enable", false);
  assert.equal(denied.ok, false);
  assert.equal(denied.kind, "denied");
  assert.equal(denied.state.status, "draft");
  assert.equal(denied.state.auditEvents.length, 1);
  assert.equal(denied.auditEvent.outcome, "denied");
  assert.deepEqual(denied.auditEvent.change.status, { from: "draft", to: "draft" });
});

void test("TC-0128 audit event excludes rule configuration, secrets, and arbitrary caller fields", () => {
  const initial = publishedState();
  const auditWithSensitiveExtras = {
    workspaceId: "workspace-1",
    actor: { type: "user" as const, id: "user-1", token: "actor-secret-value" },
    occurredAt: "2026-10-14T12:00:00Z",
    correlationId: "correlation-sensitive",
    apiKey: "context-secret-value"
  };
  const eventInput: LifecycleTransitionInput = {
    action: "enable",
    expectedRevision: initial.revision,
    authorized: true,
    audit: auditWithSensitiveExtras
  };
  const result = transitionAutomationLifecycle(initial, eventInput);
  assert.ok(result.ok);
  const serialized = JSON.stringify(result.state.auditEvents);
  assert.equal(serialized.includes("actor-secret-value"), false);
  assert.equal(serialized.includes("context-secret-value"), false);
  assert.equal(serialized.includes("task_completed"), false);
  assert.deepEqual(Object.keys(result.state.auditEvents[0] ?? {}).sort(), [
    "action", "actor", "change", "correlationId", "occurredAt", "outcome", "target", "workspaceId"
  ]);
});

void test("invalid transition or audit context does not append a success event", () => {
  const initial = createAutomationLifecycle("automation-1");
  const invalidTransition = transition(initial, "pause", true);
  assert.equal(invalidTransition.ok, false);
  assert.equal(initial.auditEvents.length, 0);

  const missingCorrelation = transitionAutomationLifecycle(initial, {
    action: "enable",
    expectedRevision: 0,
    authorized: true,
    audit: {
      workspaceId: "workspace-1",
      actor: { type: "user", id: "user-1" },
      occurredAt: "not-a-timestamp",
      correlationId: ""
    }
  });
  assert.equal(missingCorrelation.ok, false);
  assert.equal(initial.auditEvents.length, 0);
});
