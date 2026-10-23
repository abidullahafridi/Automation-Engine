import assert from "node:assert/strict";
import test from "node:test";
import {
  actionRegistry,
  createActionRegistry,
  createTriggerRegistry,
  notificationSendAction,
  taskStatusChangedTrigger,
  triggerRegistry
} from "../automation.registry.js";
import { validateRuleDraft } from "../rule.validation.js";

type RuleFixture = {
  schemaVersion: number;
  name: string;
  trigger: { type: string; config: Record<string, unknown> };
  conditions: unknown;
  actions: { type: string; config: Record<string, unknown>; onStale: string }[];
  executionPolicy: { onActionFailure: string; maxAttempts: number };
};

const validRule = (): RuleFixture => ({
  schemaVersion: 1,
  name: "Notify project lead when a task is completed",
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

const firstAction = (rule: RuleFixture): RuleFixture["actions"][number] => {
  const action = rule.actions[0];
  if (!action) throw new Error("Test rule must contain an action.");
  return action;
};

const invalidErrors = (result: ReturnType<typeof validateRuleDraft>) => {
  if (result.valid) throw new Error("Expected draft validation to fail.");
  return result.errors;
};

void test("TC-0111 registered trigger and action configs validate", () => {
  assert.equal(triggerRegistry.get("task.status_changed")?.configSchema.safeParse({
    toStatus: "done",
    allowAutomationOrigin: false
  }).success, true);
  assert.equal(actionRegistry.get("notification.send")?.configSchema.safeParse({
    recipient: { type: "project_lead" },
    template: "task_completed"
  }).success, true);
  assert.equal(validateRuleDraft(validRule()).valid, true);
});

void test("TC-0112 unregistered trigger and action types are rejected", () => {
  const rule = validRule();
  rule.trigger.type = "task.created";
  firstAction(rule).type = "notification.send_email";
  const errors = invalidErrors(validateRuleDraft(rule));
  assert.deepEqual(errors.map(({ code, path }) => ({ code, path })), [
    { code: "AUTOMATION_INVALID_ACTION", path: "/actions/0/type" },
    { code: "AUTOMATION_INVALID_TRIGGER", path: "/trigger/type" }
  ]);
});

void test("TC-0113 registered config schema mismatches are rejected", () => {
  const rule = validRule();
  rule.trigger.config = { toStatus: "done", allowAutomationOrigin: "false" };
  firstAction(rule).config = { recipient: { type: "project_lead" }, template: "free text" };
  const errors = invalidErrors(validateRuleDraft(rule));
  assert.deepEqual(errors.map(({ code }) => code), [
    "AUTOMATION_INVALID_ACTION",
    "AUTOMATION_INVALID_TRIGGER"
  ]);
});

void test("TC-0114 duplicate registry types fail loudly", () => {
  assert.throws(() => createTriggerRegistry([taskStatusChangedTrigger, taskStatusChangedTrigger]), /Duplicate registry type/);
  assert.throws(() => createActionRegistry([notificationSendAction, notificationSendAction]), /Duplicate registry type/);
  assert.throws(
    () => createActionRegistry([{ ...notificationSendAction, timeoutMs: Object.freeze({}) }]),
    /Action registration is incomplete/
  );
  assert.throws(
    () => createActionRegistry([{ ...notificationSendAction, configSchema: undefined }]),
    /Action registration is incomplete/
  );
});

void test("TC-0119 returns multiple validation errors in deterministic JSON-pointer order", () => {
  const rule = validRule();
  rule.conditions = {
    all: [
      { field: "task.secret", op: "exists" },
      { field: "task.priority", op: "matches", value: ".*" }
    ]
  };
  const first = validateRuleDraft(rule);
  const second = validateRuleDraft(rule);
  assert.deepEqual(first, second);
  const errors = invalidErrors(first);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map(({ path }) => path), ["/conditions/all/0/field", "/conditions/all/1/op"]);
});

void test("TC-0120 invalid rules return valid:false without implementing enablement", () => {
  const rule = validRule();
  rule.schemaVersion = 2;
  assert.equal(validateRuleDraft(rule).valid, false);
});

void test("workspace scope and unregistered secret fields are rejected", () => {
  const rule = { ...validRule(), workspaceId: "workspace-private" };
  const errors = invalidErrors(validateRuleDraft(rule));
  assert.equal(errors.some(({ path }) => path === "/workspaceId"), true);
});

void test("TC-0121 validation errors do not expose secrets or stack traces", () => {
  const rule = validRule();
  firstAction(rule).config = {
    recipient: { type: "project_lead" },
    template: "task_completed",
    password: "private-marker"
  };
  const result = validateRuleDraft(rule);
  const output = JSON.stringify(result);
  assert.equal(result.valid, false);
  assert.equal(output.includes("private-marker"), false);
  assert.equal(output.includes("stack"), false);
});

void test("rule limits are enforced before schema validation", () => {
  const rule = validRule();
  rule.actions = Array.from({ length: 11 }, () => ({
    type: "notification.send",
    config: { recipient: { type: "project_lead" }, template: "task_completed" },
    onStale: "skip"
  }));
  assert.deepEqual(validateRuleDraft(rule), {
    valid: false,
    errors: [{
      code: "AUTOMATION_LIMIT_EXCEEDED",
      path: "/actions",
      message: "Rule exceeds the maximum number of actions."
    }]
  });

  let nested: unknown = { field: "task.status", op: "eq", value: "done" };
  for (let depth = 0; depth < 5; depth += 1) nested = { not: nested };
  const overDepthRule = { ...validRule(), schemaVersion: 2, conditions: nested };
  const result = validateRuleDraft(overDepthRule);
  assert.deepEqual(result, {
    valid: false,
    errors: [{
      code: "AUTOMATION_LIMIT_EXCEEDED",
      path: "/conditions/not/not/not/not/not",
      message: "Condition tree exceeds the maximum depth."
    }]
  });
});

void test("notification action metadata is declarative and redaction-safe", () => {
  const action = actionRegistry.get("notification.send");
  assert.ok(action);
  assert.equal(action.schemaVersion, 1);
  assert.equal(action.sideEffect, "internal-idempotent");
  assert.equal(action.timeoutMs.internal, 5_000);
  assert.equal(action.requiredPermission.permission, "notification.send");
  assert.equal(action.requiredPermission.enforced, false);
  assert.equal(action.resultSchema.safeParse({ notificationId: "n-1", status: "sent" }).success, true);
  assert.equal(action.resultSchema.safeParse({ notificationId: "n-1", status: "sent", recipient: "private" }).success, false);
  assert.deepEqual(action.redaction.resultFields, ["notificationId", "status"]);
  assert.deepEqual(action.retryClassification.ambiguous, []);
});
