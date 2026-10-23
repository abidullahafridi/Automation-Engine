/**
 * Pure safety rules for recovering a dead-lettered run, and DLQ alert evaluation (AE-T-032.2).
 * No I/O and no clock.
 */
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import type { ActionAttempt, DeadLetterBacklog } from "./run.repository.js";

export type RecoveryBlockCode =
  | "RECONCILIATION_REQUIRED"
  | "RUN_NOT_SETTLED"
  | "UNKNOWN_ACTION_TYPE"
  | "UNCONFIRMED_NON_IDEMPOTENT";

export type RecoveryDecision =
  | Readonly<{ decision: "allow" }>
  | Readonly<{ decision: "blocked"; code: RecoveryBlockCode; actionIndexes: readonly number[] }>;

/** Side effects that are safe to repeat with the same idempotency key. */
const repeatSafe: readonly string[] = ["none", "internal-idempotent", "external-idempotent"];

/** Most serious first; the first code with offending actions is the one reported. */
const blockPriority: readonly RecoveryBlockCode[] = [
  "RECONCILIATION_REQUIRED",
  "RUN_NOT_SETTLED",
  "UNKNOWN_ACTION_TYPE",
  "UNCONFIRMED_NON_IDEMPOTENT"
];

const latestPerAction = (attempts: readonly ActionAttempt[]): readonly ActionAttempt[] => {
  const latest = new Map<number, ActionAttempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.actionIndex);
    if (!current || attempt.attempt > current.attempt) latest.set(attempt.actionIndex, attempt);
  }
  return [...latest.values()].sort((a, b) => a.actionIndex - b.actionIndex);
};

/**
 * Decides whether repeating the failed actions of a dead-lettered run is safe (BR-008, D-15).
 * - unknown_outcome: never repeated; it must be reconciled first and cannot be confirmed away.
 * - failed + idempotent side effect: safe.
 * - failed + non-idempotent side effect: only with an explicit per-action confirmation.
 * - an action whose type cannot be resolved fails closed.
 */
export const decideDeadLetterRecovery = (
  input: Readonly<{ attempts: readonly ActionAttempt[]; confirmedActionIndexes: readonly number[] }>,
  actions: ActionRegistry = actionRegistry
): RecoveryDecision => {
  const blocked = new Map<RecoveryBlockCode, number[]>();
  const block = (code: RecoveryBlockCode, actionIndex: number): void => {
    const list = blocked.get(code);
    if (list) list.push(actionIndex);
    else blocked.set(code, [actionIndex]);
  };

  for (const attempt of latestPerAction(input.attempts)) {
    switch (attempt.status) {
      case "succeeded":
      case "skipped":
      case "pending":
        break;
      case "running":
        block("RUN_NOT_SETTLED", attempt.actionIndex);
        break;
      case "unknown_outcome":
        block("RECONCILIATION_REQUIRED", attempt.actionIndex);
        break;
      case "failed": {
        const registration = attempt.actionType === undefined ? undefined : actions.get(attempt.actionType);
        if (!registration) {
          block("UNKNOWN_ACTION_TYPE", attempt.actionIndex);
        } else if (
          !repeatSafe.includes(registration.sideEffect) &&
          !input.confirmedActionIndexes.includes(attempt.actionIndex)
        ) {
          block("UNCONFIRMED_NON_IDEMPOTENT", attempt.actionIndex);
        }
        break;
      }
    }
  }

  for (const code of blockPriority) {
    const indexes = blocked.get(code);
    if (indexes) {
      return Object.freeze({ decision: "blocked" as const, code, actionIndexes: Object.freeze([...indexes]) });
    }
  }
  return Object.freeze({ decision: "allow" as const });
};

// ---- DLQ alerting ----

/** No defaults on purpose: numeric thresholds are an operational decision (spec 18.4). */
export type DeadLetterAlertThresholds = Readonly<{
  warningCount: number;
  criticalCount: number;
  warningAgeMs: number;
  criticalAgeMs: number;
}>;

export type DeadLetterAlertReason = "COUNT" | "AGE";

export type DeadLetterAlert = Readonly<{
  level: "ok" | "warning" | "critical";
  reasons: readonly DeadLetterAlertReason[];
}>;

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

export const createDeadLetterAlertThresholds = (
  thresholds: DeadLetterAlertThresholds
): DeadLetterAlertThresholds => {
  const values = [thresholds.warningCount, thresholds.criticalCount, thresholds.warningAgeMs, thresholds.criticalAgeMs];
  if (!values.every(isPositiveInteger)) {
    throw new Error("Dead-letter alert thresholds must be positive integers.");
  }
  if (thresholds.warningCount > thresholds.criticalCount || thresholds.warningAgeMs > thresholds.criticalAgeMs) {
    throw new Error("Dead-letter warning thresholds must not exceed the critical thresholds.");
  }
  return Object.freeze({ ...thresholds });
};

/** The reasons returned are those that triggered the reported level. */
export const evaluateDeadLetterBacklog = (
  backlog: DeadLetterBacklog,
  thresholds: DeadLetterAlertThresholds
): DeadLetterAlert => {
  const age = backlog.oldestAgeMs;

  const critical: DeadLetterAlertReason[] = [];
  if (backlog.count >= thresholds.criticalCount) critical.push("COUNT");
  if (age !== undefined && age >= thresholds.criticalAgeMs) critical.push("AGE");
  if (critical.length > 0) return Object.freeze({ level: "critical" as const, reasons: Object.freeze(critical) });

  const warning: DeadLetterAlertReason[] = [];
  if (backlog.count >= thresholds.warningCount) warning.push("COUNT");
  if (age !== undefined && age >= thresholds.warningAgeMs) warning.push("AGE");
  if (warning.length > 0) return Object.freeze({ level: "warning" as const, reasons: Object.freeze(warning) });

  return Object.freeze({ level: "ok" as const, reasons: Object.freeze([]) });
};