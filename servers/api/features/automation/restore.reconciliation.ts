/**
 * Post-restore integrity checks and reconciliation (AE-T-071.3).
 *
 * Read-only and pure apart from the collector, which only calls existing scoped read ports.
 * Nothing here writes, repeats an effect, or resumes execution. It tells an operator:
 *   1. is the restored data internally consistent (TC-0718),
 *   2. which runs need lease recovery and which outbox work will be republished,
 *   3. which action outcomes are unknown and need human review (TC-0720),
 *   4. whether execution may safely resume.
 * Findings carry codes and ids only, never payloads, config or recipients.
 */
import type { WorkspaceScope } from "./automation.ports.js";
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import type {
  AutomationCursor,
  AutomationRepository,
  PublishedAutomationVersion
} from "./automation.repository.js";
import { isIsoInstant } from "./condition.validation.js";
import type { OutboxRepository } from "./outbox.repository.js";
import type { RunHistoryCursor, RunHistoryRepository } from "./run.history.repository.js";
import type { ActionAttempt, StoredRun } from "./run.repository.js";
import { hashRuleDocument } from "./version.lifecycle.service.js";

export type OutboxSummary = Readonly<{
  pending: number;
  published: number;
  oldestPendingAgeMs: number | undefined;
}>;

export type RestoredSnapshot = Readonly<{
  workspaceId: string;
  /** Instant at which the snapshot was taken (the reconciliation "now"). */
  takenAt: string;
  runs: readonly StoredRun[];
  attempts: readonly ActionAttempt[];
  versions: readonly PublishedAutomationVersion[];
  outbox: OutboxSummary;
  /** True when a safety cap stopped collection. A truncated snapshot never passes. */
  truncated: boolean;
}>;

export type FindingSeverity = "error" | "review" | "info";

export type FindingCode =
  | "SNAPSHOT_TRUNCATED"
  | "RUN_DUPLICATE_ID"
  | "RUN_DUPLICATE_KEY"
  | "RUN_WORKSPACE_MISMATCH"
  | "RUN_COUNTER_INVALID"
  | "RUN_DEAD_LETTER_INFO_MISSING"
  | "RUN_VERSION_MISSING"
  | "RUN_VERSION_HASH_MISMATCH"
  | "RUN_LEASE_EXPIRED"
  | "RUN_LEASE_ACTIVE_AFTER_RESTORE"
  | "VERSION_WORKSPACE_MISMATCH"
  | "VERSION_TAMPERED"
  | "ATTEMPT_ORPHAN"
  | "ATTEMPT_WORKSPACE_MISMATCH"
  | "ATTEMPT_DUPLICATE"
  | "ATTEMPT_UNKNOWN_OUTCOME"
  | "ATTEMPT_RUNNING_AT_RESTORE"
  | "OUTBOX_REPUBLISH_EXPECTED";

export type RestoreFinding = Readonly<{
  severity: FindingSeverity;
  code: FindingCode;
  subjectType: "run" | "attempt" | "version" | "outbox" | "snapshot";
  subjectId: string;
  /** Review findings only: true when a retry with the same idempotency key is safe. */
  repeatSafe?: boolean;
}>;

export type RestoreReport = Readonly<{
  workspaceId: string;
  takenAt: string;
  /** No error-level finding. Says nothing about review items. */
  integrityOk: boolean;
  findings: readonly RestoreFinding[];
  /** Runs still `running` with an expired lease: run the reaper (recoverExpiredLeases) for the workspace. */
  recoverableRunIds: readonly string[];
  /** Outcomes that may or may not have happened. Never auto-repeat a non-repeat-safe one. */
  reviewRequired: readonly RestoreFinding[];
  /** False while any error exists or any review item is not repeat-safe. Mirrors "rollback never auto-resumes unsafe work". */
  executionMayResume: boolean;
  counts: Readonly<{ runs: number; attempts: number; versions: number; errors: number; reviews: number }>;
}>;

const repeatSafeEffects: readonly string[] = ["none", "internal-idempotent", "external-idempotent"];
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const severityOrder: Readonly<Record<FindingSeverity, number>> = { error: 0, review: 1, info: 2 };
const sep = "\u0000";

const isCounter = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const repeatSafeFor = (actionType: string | undefined, actions: ActionRegistry): boolean => {
  if (actionType === undefined) return false;
  const registration = actions.get(actionType);
  return registration !== undefined && repeatSafeEffects.includes(registration.sideEffect);
};

export const analyzeRestoredState = (
  snapshot: RestoredSnapshot,
  actions: ActionRegistry = actionRegistry
): RestoreReport => {
  const findings: RestoreFinding[] = [];
  const add = (
    severity: FindingSeverity,
    code: FindingCode,
    subjectType: RestoreFinding["subjectType"],
    subjectId: string,
    repeatSafe?: boolean
  ): void => {
    findings.push(Object.freeze({
      severity,
      code,
      subjectType,
      subjectId,
      ...(repeatSafe === undefined ? {} : { repeatSafe })
    }));
  };

  if (snapshot.truncated) add("error", "SNAPSHOT_TRUNCATED", "snapshot", snapshot.workspaceId);

  // ---- Versions (INV-02: immutable, hash verified) ----
  const versionByKey = new Map<string, PublishedAutomationVersion>();
  for (const version of snapshot.versions) {
    const id = `${version.automationId}@${String(version.version)}`;
    versionByKey.set(`${version.automationId}${sep}${String(version.version)}`, version);
    if (version.workspaceId !== snapshot.workspaceId) add("error", "VERSION_WORKSPACE_MISMATCH", "version", id);
    const hash = hashRuleDocument(version.rule);
    if (!hash.success || hash.contentHash !== version.contentHash) add("error", "VERSION_TAMPERED", "version", id);
  }

  // ---- Runs ----
  const runById = new Map<string, StoredRun>();
  const naturalKeys = new Set<string>();
  const recoverable: string[] = [];
  for (const run of snapshot.runs) {
    if (runById.has(run.runId)) add("error", "RUN_DUPLICATE_ID", "run", run.runId);
    else runById.set(run.runId, run);

    const naturalKey = [run.eventId, run.automationId, String(run.version)].join(sep);
    if (naturalKeys.has(naturalKey)) add("error", "RUN_DUPLICATE_KEY", "run", run.runId);
    naturalKeys.add(naturalKey);

    if (run.workspaceId !== snapshot.workspaceId) add("error", "RUN_WORKSPACE_MISMATCH", "run", run.runId);
    if (!isCounter(run.revision) || !isCounter(run.fencingToken)) add("error", "RUN_COUNTER_INVALID", "run", run.runId);
    if (run.status === "dead_letter" && run.deadLetter === undefined) {
      add("error", "RUN_DEAD_LETTER_INFO_MISSING", "run", run.runId);
    }

    const version = versionByKey.get(`${run.automationId}${sep}${String(run.version)}`);
    if (version === undefined) {
      const active = run.status === "queued" || run.status === "retry_wait" || run.status === "running";
      add(active ? "error" : "review", "RUN_VERSION_MISSING", "run", run.runId);
    } else if (version.contentHash !== run.contentHash) {
      add("error", "RUN_VERSION_HASH_MISMATCH", "run", run.runId);
    }

    if (run.status === "running") {
      const expired = run.leaseExpiresAt === undefined || run.leaseExpiresAt <= snapshot.takenAt;
      if (expired) {
        recoverable.push(run.runId);
        add("info", "RUN_LEASE_EXPIRED", "run", run.runId);
      } else {
        // A live lease right after a restore means a stale or skewed clock: do not trust it.
        add("review", "RUN_LEASE_ACTIVE_AFTER_RESTORE", "run", run.runId);
      }
    }
  }

  // ---- Action attempts ----
  const attemptKeys = new Set<string>();
  for (const attempt of snapshot.attempts) {
    const id = `${attempt.runId}#${String(attempt.actionIndex)}.${String(attempt.attempt)}`;
    if (!runById.has(attempt.runId)) add("error", "ATTEMPT_ORPHAN", "attempt", id);
    if (attempt.workspaceId !== snapshot.workspaceId) add("error", "ATTEMPT_WORKSPACE_MISMATCH", "attempt", id);
    const key = [attempt.runId, String(attempt.actionIndex), String(attempt.attempt)].join(sep);
    if (attemptKeys.has(key)) add("error", "ATTEMPT_DUPLICATE", "attempt", id);
    attemptKeys.add(key);

    if (attempt.status === "unknown_outcome") {
      add("review", "ATTEMPT_UNKNOWN_OUTCOME", "attempt", id, repeatSafeFor(attempt.actionType, actions));
    } else if (attempt.status === "running") {
      // The reaper will turn this into unknown_outcome; flag it before that happens.
      add("review", "ATTEMPT_RUNNING_AT_RESTORE", "attempt", id, repeatSafeFor(attempt.actionType, actions));
    }
  }

  // ---- Outbox ----
  if (snapshot.outbox.pending > 0) {
    add("info", "OUTBOX_REPUBLISH_EXPECTED", "outbox", snapshot.workspaceId);
  }

  findings.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    compareText(left.code, right.code) ||
    compareText(left.subjectId, right.subjectId));

  const errors = findings.filter((finding) => finding.severity === "error");
  const reviews = findings.filter((finding) => finding.severity === "review");
  const blocking = errors.length > 0 || reviews.some((finding) => finding.repeatSafe !== true);

  return Object.freeze({
    workspaceId: snapshot.workspaceId,
    takenAt: snapshot.takenAt,
    integrityOk: errors.length === 0,
    findings: Object.freeze(findings),
    recoverableRunIds: Object.freeze([...recoverable].sort(compareText)),
    reviewRequired: Object.freeze(reviews),
    executionMayResume: !blocking,
    counts: Object.freeze({
      runs: snapshot.runs.length,
      attempts: snapshot.attempts.length,
      versions: snapshot.versions.length,
      errors: errors.length,
      reviews: reviews.length
    })
  });
};

// ---- Snapshot collection (existing scoped, read-only ports only) ----

export const restoreSnapshotLimits = Object.freeze({ maxAutomations: 1_000, maxRuns: 10_000, pageSize: 100 });

export const collectRestoreSnapshot = async ({
  scope,
  automations,
  history,
  outbox,
  now,
  maxAutomations = restoreSnapshotLimits.maxAutomations,
  maxRuns = restoreSnapshotLimits.maxRuns
}: Readonly<{
  scope: WorkspaceScope;
  automations: Pick<AutomationRepository, "list" | "listVersions">;
  history: RunHistoryRepository;
  outbox: Pick<OutboxRepository, "countByStatus" | "getOldestPendingAgeMs">;
  now: string;
  maxAutomations?: number;
  maxRuns?: number;
}>): Promise<RestoredSnapshot> => {
  if (!isIsoInstant(now)) throw new Error("Snapshot time must be an ISO-8601 instant.");
  let truncated = false;

  const automationIds: string[] = [];
  let automationCursor: AutomationCursor | undefined;
  let moreAutomations = true;
  while (moreAutomations) {
    const page = await automations.list(scope, { after: automationCursor, limit: restoreSnapshotLimits.pageSize });
    for (const item of page.items) automationIds.push(item.automationId);
    if (page.next === undefined) {
      moreAutomations = false;
    } else if (automationIds.length >= maxAutomations) {
      truncated = true;
      moreAutomations = false;
    } else {
      automationCursor = page.next;
    }
  }

  const versions: PublishedAutomationVersion[] = [];
  const runs: StoredRun[] = [];
  const attempts: ActionAttempt[] = [];

  for (const automationId of automationIds) {
    versions.push(...await automations.listVersions(scope, automationId));
    let cursor: RunHistoryCursor | undefined;
    let more = !truncated || runs.length < maxRuns;
    while (more) {
      const page = await history.listRuns(scope, automationId, { after: cursor, limit: restoreSnapshotLimits.pageSize });
      for (const run of page.items) {
        if (runs.length >= maxRuns) {
          truncated = true;
          break;
        }
        runs.push(run);
      }
      if (page.next === undefined || runs.length >= maxRuns) {
        if (page.next !== undefined) truncated = true;
        more = false;
      } else {
        cursor = page.next;
      }
    }
  }

  for (const run of runs) attempts.push(...await history.listActionAttempts(scope, run.runId));

  const [pending, published, oldestPendingAgeMs] = await Promise.all([
    outbox.countByStatus(scope, "pending"),
    outbox.countByStatus(scope, "published"),
    outbox.getOldestPendingAgeMs(scope, now)
  ]);

  return Object.freeze({
    workspaceId: scope.workspaceId,
    takenAt: now,
    runs: Object.freeze(runs),
    attempts: Object.freeze(attempts),
    versions: Object.freeze(versions),
    outbox: Object.freeze({ pending, published, oldestPendingAgeMs }),
    truncated
  });
};

// ---- RPO / RTO measurement for the drill report ----

export type RecoveryTimes = Readonly<{
  /** Point in time the restored data represents (backup / PITR target). */
  backupPointInTime: string;
  /** When the failure happened or was declared. */
  incidentAt: string;
  restoreStartedAt: string;
  restoreFinishedAt: string;
  /** When integrity checks passed and the service was verified usable. */
  serviceVerifiedAt: string;
}>;

export type RecoveryMeasurement =
  | Readonly<{
      ok: true;
      /** incidentAt - backupPointInTime. Upper bound of the data-loss window (RPO achieved). */
      dataLossWindowMs: number;
      restoreDurationMs: number;
      /** serviceVerifiedAt - incidentAt (RTO achieved). */
      recoveryTimeMs: number;
    }>
  | Readonly<{ ok: false; code: "INVALID_TIME" | "OUT_OF_ORDER" }>;

export const measureRecovery = (times: RecoveryTimes): RecoveryMeasurement => {
  const ordered = [
    times.backupPointInTime,
    times.incidentAt,
    times.restoreStartedAt,
    times.restoreFinishedAt,
    times.serviceVerifiedAt
  ];
  if (!ordered.every(isIsoInstant)) return Object.freeze({ ok: false, code: "INVALID_TIME" });
  const [backup, incident, started, finished, verified] = ordered.map((value) => Date.parse(value));
  if (
    backup === undefined || incident === undefined || started === undefined ||
    finished === undefined || verified === undefined ||
    !(backup <= incident && incident <= started && started <= finished && finished <= verified)
  ) {
    return Object.freeze({ ok: false, code: "OUT_OF_ORDER" });
  }
  return Object.freeze({
    ok: true,
    dataLossWindowMs: incident - backup,
    restoreDurationMs: finished - started,
    recoveryTimeMs: verified - incident
  });
};
