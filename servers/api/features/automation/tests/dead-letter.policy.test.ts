import assert from "node:assert/strict";
import test from "node:test";
import {
  createActionRegistry,
  notificationSendAction,
  type ActionRegistry
} from "../automation.registry.js";
import {
  createDeadLetterAlertThresholds,
  decideDeadLetterRecovery,
  evaluateDeadLetterBacklog
} from "../dead-letter.policy.js";
import type { ActionAttempt } from "../run.repository.js";

const T0 = "2026-10-17T10:00:00.000Z";

const attempt = (overrides: Partial<ActionAttempt> & Pick<ActionAttempt, "actionIndex" | "attempt" | "status">): ActionAttempt => ({
  runId: "r1",
  workspaceId: "workspace-1",
  createdAt: T0,
  updatedAt: T0,
  ...overrides
});

const registry: ActionRegistry = createActionRegistry([
  notificationSendAction,
  { ...notificationSendAction, type: "test.external", sideEffect: "external" as const, timeoutMs: Object.freeze({ external: 30 }) },
  { ...notificationSendAction, type: "test.external_idempotent", sideEffect: "external-idempotent" as const, timeoutMs: Object.freeze({ external: 30 }) }
]);

void test("settled and idempotent failed actions allow recovery", () => {
  const decision = decideDeadLetterRecovery({
    attempts: [
      attempt({ actionIndex: 0, attempt: 1, status: "succeeded", actionType: "notification.send" }),
      attempt({ actionIndex: 1, attempt: 5, status: "failed", actionType: "notification.send" }),
      attempt({ actionIndex: 2, attempt: 5, status: "failed", actionType: "test.external_idempotent" }),
      attempt({ actionIndex: 3, attempt: 1, status: "skipped" }),
      attempt({ actionIndex: 4, attempt: 1, status: "pending" })
    ],
    confirmedActionIndexes: []
  }, registry);
  assert.deepEqual(decision, { decision: "allow" });
  assert.deepEqual(decideDeadLetterRecovery({ attempts: [], confirmedActionIndexes: [] }, registry), { decision: "allow" });
});

void test("only the latest attempt of each action counts", () => {
  const decision = decideDeadLetterRecovery({
    attempts: [
      attempt({ actionIndex: 0, attempt: 1, status: "unknown_outcome", actionType: "notification.send" }),
      attempt({ actionIndex: 0, attempt: 2, status: "succeeded", actionType: "notification.send" })
    ],
    confirmedActionIndexes: []
  }, registry);
  assert.deepEqual(decision, { decision: "allow" });
});

void test("the most serious block is reported and lists every offending action", () => {
  const decision = decideDeadLetterRecovery({
    attempts: [
      attempt({ actionIndex: 0, attempt: 5, status: "failed", actionType: "test.external" }),
      attempt({ actionIndex: 1, attempt: 5, status: "unknown_outcome", actionType: "notification.send" }),
      attempt({ actionIndex: 2, attempt: 5, status: "unknown_outcome", actionType: "test.external" }),
      attempt({ actionIndex: 3, attempt: 5, status: "failed", actionType: "evil.type" })
    ],
    confirmedActionIndexes: [0, 3]
  }, registry);
  assert.deepEqual(decision, { decision: "blocked", code: "RECONCILIATION_REQUIRED", actionIndexes: [1, 2] });

  const running = decideDeadLetterRecovery({
    attempts: [attempt({ actionIndex: 0, attempt: 1, status: "running", actionType: "notification.send" })],
    confirmedActionIndexes: []
  }, registry);
  assert.deepEqual(running, { decision: "blocked", code: "RUN_NOT_SETTLED", actionIndexes: [0] });
});

void test("a confirmation is per action and never applies to other actions", () => {
  const attempts = [
    attempt({ actionIndex: 0, attempt: 5, status: "failed", actionType: "test.external" }),
    attempt({ actionIndex: 1, attempt: 5, status: "failed", actionType: "test.external" })
  ];
  assert.deepEqual(decideDeadLetterRecovery({ attempts, confirmedActionIndexes: [0] }, registry), {
    decision: "blocked", code: "UNCONFIRMED_NON_IDEMPOTENT", actionIndexes: [1]
  });
  assert.deepEqual(decideDeadLetterRecovery({ attempts, confirmedActionIndexes: [0, 1] }, registry), { decision: "allow" });
});

void test("alert thresholds are validated and have no defaults", () => {
  const valid = { warningCount: 5, criticalCount: 20, warningAgeMs: 60_000, criticalAgeMs: 600_000 };
  assert.deepEqual(createDeadLetterAlertThresholds(valid), valid);
  assert.throws(() => createDeadLetterAlertThresholds({ ...valid, warningCount: 0 }), /positive integers/);
  assert.throws(() => createDeadLetterAlertThresholds({ ...valid, criticalAgeMs: 1.5 }), /positive integers/);
  assert.throws(() => createDeadLetterAlertThresholds({ ...valid, warningCount: 30 }), /must not exceed/);
  assert.throws(() => createDeadLetterAlertThresholds({ ...valid, warningAgeMs: 700_000 }), /must not exceed/);
});

void test("backlog size and age raise warning and critical alerts", () => {
  const thresholds = createDeadLetterAlertThresholds({
    warningCount: 5, criticalCount: 20, warningAgeMs: 60_000, criticalAgeMs: 600_000
  });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 0, oldestAgeMs: undefined }, thresholds), { level: "ok", reasons: [] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 4, oldestAgeMs: 59_999 }, thresholds), { level: "ok", reasons: [] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 5, oldestAgeMs: 1_000 }, thresholds), { level: "warning", reasons: ["COUNT"] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 1, oldestAgeMs: 60_000 }, thresholds), { level: "warning", reasons: ["AGE"] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 6, oldestAgeMs: 61_000 }, thresholds), { level: "warning", reasons: ["COUNT", "AGE"] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 20, oldestAgeMs: 1_000 }, thresholds), { level: "critical", reasons: ["COUNT"] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 1, oldestAgeMs: 600_000 }, thresholds), { level: "critical", reasons: ["AGE"] });
  assert.deepEqual(evaluateDeadLetterBacklog({ count: 25, oldestAgeMs: 900_000 }, thresholds), { level: "critical", reasons: ["COUNT", "AGE"] });
});