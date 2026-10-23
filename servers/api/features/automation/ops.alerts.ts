import {
  createDeadLetterAlertThresholds,
  evaluateDeadLetterBacklog,
  type DeadLetterAlertThresholds
} from "./dead-letter.policy.js";
import { opsSignalNames, type OpsSignalName, type OpsSignals } from "./ops.signals.js";

export const operatingOwner = "Abid Ullah";

export type AlertLevel = "warning" | "critical";

export const alertRuleIds = Object.freeze([
  "QUEUE_AGE",
  "LEASE_STALLED",
  "OUTBOX_STALLED",
  "DEAD_LETTER_BACKLOG",
  "TENANT_SCOPE_VIOLATION",
  "SIGNAL_UNAVAILABLE"
] as const);
export type AlertRuleId = (typeof alertRuleIds)[number];

export type AlertRule = Readonly<{
  id: AlertRuleId;
  owner: string;
  /** Path and anchor inside operations-runbooks.md. */
  runbook: string;
  panelId: string;
  /** Static, safe text. Never contains submitted values. */
  summary: string;
}>;

const rule = (id: AlertRuleId, panelId: string, anchor: string, summary: string): AlertRule =>
  Object.freeze({ id, owner: operatingOwner, runbook: `operations-runbooks.md#${anchor}`, panelId, summary });

export const alertRules: Readonly<Record<AlertRuleId, AlertRule>> = Object.freeze({
  QUEUE_AGE: rule("QUEUE_AGE", "queue-age", "queue-backlog", "Oldest eligible run has waited too long."),
  LEASE_STALLED: rule(
    "LEASE_STALLED", "lease-stalled", "lease-expiry-and-stalled-reaper",
    "Runs with an expired lease are not being recovered."
  ),
  OUTBOX_STALLED: rule("OUTBOX_STALLED", "outbox-age", "outbox-stall", "Outbox events are not being published."),
  DEAD_LETTER_BACKLOG: rule(
    "DEAD_LETTER_BACKLOG", "dlq-backlog", "dlq-recovery", "Dead-lettered runs are waiting for recovery."
  ),
  TENANT_SCOPE_VIOLATION: rule(
    "TENANT_SCOPE_VIOLATION", "tenant-scope", "tenant-isolation-concern",
    "A tenant-scope violation was observed. This must stay at zero."
  ),
  SIGNAL_UNAVAILABLE: rule(
    "SIGNAL_UNAVAILABLE", "monitoring-health", "signal-unavailable",
    "A monitoring signal could not be read; the system is partly blind."
  )
});

export type LevelThresholds = Readonly<{ warning: number; critical: number }>;

/** No defaults on purpose: numeric thresholds come from the load baseline (spec 18.4). */
export type AlertThresholds = Readonly<{
  queueAgeMs: LevelThresholds;
  leaseStalledCount: LevelThresholds;
  outboxAgeMs: LevelThresholds;
  deadLetter: DeadLetterAlertThresholds;
}>;

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

const validLevels = (levels: LevelThresholds): boolean =>
  isPositiveInteger(levels.warning) && isPositiveInteger(levels.critical) && levels.warning <= levels.critical;

export const createAlertThresholds = (thresholds: AlertThresholds): AlertThresholds => {
  if (
    !validLevels(thresholds.queueAgeMs) ||
    !validLevels(thresholds.leaseStalledCount) ||
    !validLevels(thresholds.outboxAgeMs)
  ) {
    throw new Error("Alert thresholds must be positive integers with warning <= critical.");
  }
  return Object.freeze({
    queueAgeMs: Object.freeze({ ...thresholds.queueAgeMs }),
    leaseStalledCount: Object.freeze({ ...thresholds.leaseStalledCount }),
    outboxAgeMs: Object.freeze({ ...thresholds.outboxAgeMs }),
    deadLetter: createDeadLetterAlertThresholds(thresholds.deadLetter)
  });
};

export type Alert = Readonly<{
  ruleId: AlertRuleId;
  level: AlertLevel;
  summary: string;
  value: number;
  /** The threshold that was crossed. Undefined for rules without a single number. */
  threshold: number | undefined;
  reasons: readonly string[];
  owner: string;
  runbook: string;
  panelId: string;
  /** Same fault gives the same key, so notifications are deduplicated. */
  dedupeKey: string;
}>;

export type AlertEvaluation = Readonly<{
  alerts: readonly Alert[];
  /** Signals nobody configured. Reported so a gap is visible, not silently green. */
  unmonitored: readonly OpsSignalName[];
}>;

const classify = (
  value: number,
  levels: LevelThresholds
): Readonly<{ level: AlertLevel; threshold: number }> | undefined => {
  if (value >= levels.critical) return Object.freeze({ level: "critical" as const, threshold: levels.critical });
  if (value >= levels.warning) return Object.freeze({ level: "warning" as const, threshold: levels.warning });
  return undefined;
};

const makeAlert = (
  ruleId: AlertRuleId,
  level: AlertLevel,
  value: number,
  threshold: number | undefined,
  reasons: readonly string[] = [],
  dedupeKey: string = ruleId
): Alert => {
  const definition = alertRules[ruleId];
  return Object.freeze({
    ruleId,
    level,
    summary: definition.summary,
    value,
    threshold,
    reasons: Object.freeze([...reasons]),
    owner: definition.owner,
    runbook: definition.runbook,
    panelId: definition.panelId,
    dedupeKey
  });
};

export const evaluateAlerts = (signals: OpsSignals, thresholds: AlertThresholds): AlertEvaluation => {
  const alerts: Alert[] = [];

  const queue = signals.queue;
  if (queue !== undefined) {
    if (queue.oldestEligibleAgeMs !== undefined) {
      const hit = classify(queue.oldestEligibleAgeMs, thresholds.queueAgeMs);
      if (hit) alerts.push(makeAlert("QUEUE_AGE", hit.level, queue.oldestEligibleAgeMs, hit.threshold));
    }
    const lease = classify(queue.expiredRunningCount, thresholds.leaseStalledCount);
    if (lease) alerts.push(makeAlert("LEASE_STALLED", lease.level, queue.expiredRunningCount, lease.threshold));
  }

  const outbox = signals.outbox;
  if (outbox?.oldestPendingAgeMs !== undefined) {
    const hit = classify(outbox.oldestPendingAgeMs, thresholds.outboxAgeMs);
    if (hit) alerts.push(makeAlert("OUTBOX_STALLED", hit.level, outbox.oldestPendingAgeMs, hit.threshold));
  }

  if (signals.deadLetter !== undefined) {
    const dlq = evaluateDeadLetterBacklog(signals.deadLetter, thresholds.deadLetter);
    if (dlq.level !== "ok") {
      alerts.push(makeAlert("DEAD_LETTER_BACKLOG", dlq.level, signals.deadLetter.count, undefined, dlq.reasons));
    }
  }

  // A hard alert: every scope violation pages. It has no threshold to tune.
  if (signals.tenantScopeViolations !== undefined && signals.tenantScopeViolations > 0) {
    alerts.push(makeAlert("TENANT_SCOPE_VIOLATION", "critical", signals.tenantScopeViolations, 1));
  }

  for (const name of signals.failed) {
    alerts.push(makeAlert("SIGNAL_UNAVAILABLE", "warning", 0, undefined, [name], `SIGNAL_UNAVAILABLE:${name}`));
  }

  alerts.sort((left, right) => {
    const order = alertRuleIds.indexOf(left.ruleId) - alertRuleIds.indexOf(right.ruleId);
    if (order !== 0) return order;
    if (left.dedupeKey < right.dedupeKey) return -1;
    return left.dedupeKey > right.dedupeKey ? 1 : 0;
  });

  const present: Readonly<Record<OpsSignalName, boolean>> = {
    queue: signals.queue !== undefined,
    outbox: signals.outbox !== undefined,
    deadLetter: signals.deadLetter !== undefined,
    tenantScope: signals.tenantScopeViolations !== undefined
  };
  const unmonitored = opsSignalNames.filter((name) => !present[name] && !signals.failed.includes(name));

  return Object.freeze({
    alerts: Object.freeze(alerts),
    unmonitored: Object.freeze(unmonitored)
  });
};
