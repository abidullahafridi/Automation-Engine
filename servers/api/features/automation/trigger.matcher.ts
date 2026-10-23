import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import { createConditionEvaluator } from "./condition.evaluator.js";
import { validateTaskStatusChangedEvent, type TaskStatusChangedEventV1 } from "./domain-event.js";
import type { PublishedAutomationVersion } from "./automation.repository.js";
import type { LoopGuard } from "./loop.guard.js";
import type { QuotaService } from "./quota.service.js";

export type TriggerCandidate = Readonly<{
  automationId: string;
  createdBy: string;
  version: PublishedAutomationVersion;
}>;

export type TriggerCandidateRepository = Readonly<{
  findEligible: (scope: WorkspaceScope, eventType: string, limit: number) => Promise<readonly TriggerCandidate[]>;
}>;

export type AutomationRun = Readonly<{
  runId: string;
  eventId: string;
  workspaceId: string;
  automationId: string;
  version: number;
  contentHash: string;
  status: "queued" | "skipped";
  createdAt: string;
  /** Causation lineage. Present only when run protection is enabled. */
  chainKey?: string;
  hop?: number;
  /** W3C trace context copied from the event. */
  traceparent?: string;
  /** Present only on skipped runs, for example SELF_TRIGGER. */
  skipReason?: string;
}>;

export type MatcherRunRepository = Readonly<{
  createIdempotently: (scope: WorkspaceScope, run: AutomationRun) => Promise<"created" | "idempotent">;
  /** Required when run protection is enabled: redelivered events must not spend quota or chain budget twice. */
  exists?: (scope: WorkspaceScope, runId: string) => Promise<boolean>;
}>;

/** Loop protection (AE-T-041.1) and quotas (AE-T-041.2) applied before a run is created. */
export type RunProtection = Readonly<{
  loopGuard: LoopGuard;
  quota: QuotaService;
}>;

/** Structurally satisfied by AutomationTelemetry. Failures are swallowed. */
export type MatcherTelemetry = Readonly<{
  recordRun: (status: string, triggerType: string) => void;
}>;

/** Release gate for intake. Returns false when intake is paused or not rolled out. */
export type IntakeGate = (scope: WorkspaceScope) => Promise<boolean>;

export type MatchResult = Readonly<{
  kind: "matched" | "rejected";
  candidateCount: number;
  createdRuns: number;
  idempotentRuns: number;
  reason?: "invalid-event" | "workspace-conflict" | "candidate-limit" | "quota-exceeded" | "intake-paused";
  /** Runs stopped by loop protection. Present only when greater than zero. */
  blockedRuns?: number;
  /** Runs deferred by quota backpressure. Present only when greater than zero. */
  quotaRejectedRuns?: number;
  /** Backpressure hint in milliseconds. Present only with a quota denial. */
  retryAfterMs?: number;
}>;

export const triggerMatcherLimit = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTriggered = (event: TaskStatusChangedEventV1, candidate: TriggerCandidate): boolean => {
  const config = candidate.version.rule.trigger.config;
  if (!isRecord(config) || config.toStatus !== event.payload.task.status) return false;
  return event.origin === undefined || config.allowAutomationOrigin === true;
};

const runFor = (event: TaskStatusChangedEventV1, candidate: TriggerCandidate): AutomationRun => Object.freeze({
  runId: `${event.eventId}:${candidate.automationId}:${String(candidate.version.version)}`,
  eventId: event.eventId,
  workspaceId: event.workspaceId,
  automationId: candidate.automationId,
  version: candidate.version.version,
  contentHash: candidate.version.contentHash,
  status: "queued" as const,
  createdAt: event.occurredAt,
  ...(event.traceparent === undefined ? {} : { traceparent: event.traceparent })
});

const skippedRunFor = (
  base: AutomationRun,
  reason: string,
  chainKey: string,
  hop: number
): AutomationRun => Object.freeze({
  ...base,
  status: "skipped" as const,
  skipReason: reason,
  chainKey,
  hop
});

const observeRun = (
  telemetry: MatcherTelemetry | undefined,
  status: "queued" | "skipped",
  eventType: string
): void => {
  if (telemetry === undefined) return;
  try {
    telemetry.recordRun(status, eventType);
  } catch {
    // Telemetry must never change matching behavior.
  }
};

type GuardedProtection = Readonly<{
  loopGuard: LoopGuard;
  quota: QuotaService;
  exists: (scope: WorkspaceScope, runId: string) => Promise<boolean>;
}>;

const resolveProtection = (
  protection: RunProtection | undefined,
  runs: MatcherRunRepository
): GuardedProtection | undefined => {
  if (protection === undefined) return undefined;
  const exists = runs.exists;
  if (exists === undefined) throw new Error("Run protection requires MatcherRunRepository.exists.");
  return Object.freeze({ loopGuard: protection.loopGuard, quota: protection.quota, exists });
};

export const createTriggerMatcher = ({
  candidates,
  runs,
  limit = triggerMatcherLimit,
  protection,
  telemetry,
  intakeGate
}: Readonly<{
  candidates: TriggerCandidateRepository;
  runs: MatcherRunRepository;
  limit?: number;
  protection?: RunProtection;
  telemetry?: MatcherTelemetry;
  intakeGate?: IntakeGate;
}>) => {
  const guarded = resolveProtection(protection, runs);

  return Object.freeze({
    match: async (scope: WorkspaceScope, input: unknown): Promise<MatchResult> => {
      const parsed = validateTaskStatusChangedEvent(input);
      if (!parsed.success) return Object.freeze({ kind: "rejected", candidateCount: 0, createdRuns: 0, idempotentRuns: 0, reason: "invalid-event" });
      const event = parsed.data;
      if (event.workspaceId !== scope.workspaceId) return Object.freeze({ kind: "rejected", candidateCount: 0, createdRuns: 0, idempotentRuns: 0, reason: "workspace-conflict" });

      const intakeOpen = intakeGate === undefined ? true : await intakeGate(scope);
      if (!intakeOpen) return Object.freeze({ kind: "rejected", candidateCount: 0, createdRuns: 0, idempotentRuns: 0, reason: "intake-paused" });

      if (guarded !== undefined) {
        const admitted = await guarded.quota.admit(scope, "events");
        if (admitted.kind === "deny") {
          return Object.freeze({
            kind: "rejected",
            candidateCount: 0,
            createdRuns: 0,
            idempotentRuns: 0,
            reason: "quota-exceeded",
            retryAfterMs: admitted.retryAfterMs
          });
        }
      }

      const selected = await candidates.findEligible(scope, event.eventType, limit + 1);
      if (selected.length > limit) return Object.freeze({ kind: "rejected", candidateCount: selected.length, createdRuns: 0, idempotentRuns: 0, reason: "candidate-limit" });

      const evaluate = createConditionEvaluator(undefined, event.eventType);
      const chainKey = event.correlationId ?? event.eventId;
      const hop = event.origin === undefined ? 0 : event.origin.hop;
      let createdRuns = 0;
      let idempotentRuns = 0;
      let blockedRuns = 0;
      let quotaRejectedRuns = 0;
      let retryAfterMs = 0;

      for (const candidate of selected) {
        if (candidate.version.workspaceId !== scope.workspaceId || !isTriggered(event, candidate) || evaluate(candidate.version.rule.conditions, event.payload).status !== "matched") continue;
        const baseRun = runFor(event, candidate);
        let run: AutomationRun = baseRun;

        if (guarded !== undefined) {
          // Redelivery: the run already exists, so nothing is spent again.
          if (await guarded.exists(scope, baseRun.runId)) {
            idempotentRuns += 1;
            continue;
          }
          // Quota first: a deferred run must not consume chain budget. It is not recorded, so it can be retried.
          const admitted = await guarded.quota.admit(scope, "runs");
          if (admitted.kind === "deny") {
            quotaRejectedRuns += 1;
            retryAfterMs = Math.max(retryAfterMs, admitted.retryAfterMs);
            continue;
          }
          const decision = await guarded.loopGuard.evaluate(scope, {
            workspaceId: event.workspaceId,
            automationId: candidate.automationId,
            eventId: event.eventId,
            chainKey,
            origin: event.origin
          });
          if (decision.kind === "block") {
            blockedRuns += 1;
            // A permanent block is recorded as a visible skipped run. An infrastructure fault is not.
            if (!decision.retryable) {
              await runs.createIdempotently(scope, skippedRunFor(baseRun, decision.code, chainKey, hop));
              observeRun(telemetry, "skipped", event.eventType);
            }
            continue;
          }
          run = Object.freeze({ ...baseRun, chainKey, hop });
        }

        const result = await runs.createIdempotently(scope, run);
        if (result === "created") {
          createdRuns += 1;
          observeRun(telemetry, "queued", event.eventType);
        } else {
          idempotentRuns += 1;
        }
      }

      const outcome: MatchResult = {
        kind: "matched",
        candidateCount: selected.length,
        createdRuns,
        idempotentRuns,
        ...(blockedRuns > 0 ? { blockedRuns } : {}),
        ...(quotaRejectedRuns > 0 ? { quotaRejectedRuns, retryAfterMs } : {})
      };
      return Object.freeze(outcome);
    }
  });
};

export type TriggerMatcher = ReturnType<typeof createTriggerMatcher>;

export type TriggerMatcherCollectionNames = Readonly<{ headers: string; versions: string; runs: string }>;
export const triggerMatcherCollectionNames: TriggerMatcherCollectionNames = Object.freeze({
  headers: "automation_definitions",
  versions: "automation_versions",
  runs: "automation_runs"
});

type StoredHeader = Readonly<{ automationId: string; workspaceId: string; createdBy: string; status: string; currentVersion: number | null }>;
type CandidateDocument = Readonly<{ automationId: string; createdBy: string; version: PublishedAutomationVersion }>;

/** Stored shape the run repository can claim: it filters on runAfter and increments revision/fencingToken. */
type PersistedRun = AutomationRun & Readonly<{
  revision: number;
  fencingToken: number;
  runAfter: string;
  updatedAt: string;
}>;

const toPersistedRun = (run: AutomationRun): PersistedRun => Object.freeze({
  ...run,
  revision: 0,
  fencingToken: 0,
  runAfter: run.createdAt,
  updatedAt: run.createdAt
});

export const ensureTriggerMatcherIndexes = async (database: MongoDatabase, names = triggerMatcherCollectionNames): Promise<void> => {
  await Promise.all([
    database.collection(names.headers).createIndex(
      { workspaceId: 1, status: 1, currentVersion: 1 }, { name: "matcher_enabled_workspace_version" }),
    database.collection(names.versions).createIndex(
      { workspaceId: 1, "rule.trigger.type": 1, automationId: 1, version: 1 }, { name: "matcher_workspace_trigger_version" }),
    database.collection(names.runs).createIndex(
      { workspaceId: 1, eventId: 1, automationId: 1, version: 1 }, { unique: true, name: "run_event_automation_version_unique" })
  ]);
};

export const createMongoTriggerMatcher = async ({ database, ownsScope, collectionNames = triggerMatcherCollectionNames, protection, telemetry, intakeGate }: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: TriggerMatcherCollectionNames;
  protection?: RunProtection;
  telemetry?: MatcherTelemetry;
  intakeGate?: IntakeGate;
}>) => {
  await ensureTriggerMatcherIndexes(database, collectionNames);
  const requireScope = (scope: WorkspaceScope): void => { if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required."); };
  const candidates: TriggerCandidateRepository = Object.freeze({
    findEligible: async (scope, eventType, limit) => {
      requireScope(scope);
      const rows = await database.collection<StoredHeader>(collectionNames.headers).aggregate<CandidateDocument>([
        { $match: { workspaceId: scope.workspaceId, status: "enabled", currentVersion: { $ne: null } } },
        { $lookup: { from: collectionNames.versions, let: { id: "$automationId", version: "$currentVersion" }, pipeline: [
          { $match: { $expr: { $and: [{ $eq: ["$workspaceId", scope.workspaceId] }, { $eq: ["$automationId", "$$id"] }, { $eq: ["$version", "$$version"] }, { $eq: ["$rule.trigger.type", eventType] }] } } }
        ], as: "versions" } },
        { $unwind: "$versions" }, { $project: { automationId: 1, createdBy: 1, version: "$versions" } }, { $limit: limit }
      ]).toArray();
      return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
    }
  });
  const runs: MatcherRunRepository = Object.freeze({
    createIdempotently: async (scope, run) => {
      requireScope(scope);
      try { await database.collection<PersistedRun>(collectionNames.runs).insertOne(structuredClone(toPersistedRun(run))); return "created" as const; }
      catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === 11000) return "idempotent" as const; throw error; }
    },
    exists: async (scope: WorkspaceScope, runId: string): Promise<boolean> => {
      requireScope(scope);
      const found = await database.collection<AutomationRun>(collectionNames.runs).findOne({ workspaceId: scope.workspaceId, runId });
      return found !== null;
    }
  });
  return createTriggerMatcher({
    candidates,
    runs,
    ...(protection ? { protection } : {}),
    ...(telemetry ? { telemetry } : {}),
    ...(intakeGate ? { intakeGate } : {})
  });
};
