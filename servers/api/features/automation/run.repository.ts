import type { MongoDatabase } from "../../integrations/index.js";
import type { ActionErrorClass } from "./action.handler.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type { RetryStopReason } from "./retry.policy.js";

export type RunStatus = "queued" | "running" | "retry_wait" | "completed" | "failed" | "cancelled" | "skipped" | "dead_letter";
export type ActionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "unknown_outcome";

/** Why a run was dead-lettered. Persisted when the retry budget ends (AE-T-032.2). */
export type DeadLetterDetail = Readonly<{
  reason: RetryStopReason;
  /** Total attempts made, including the first. */
  attempts: number;
  firstAttemptAt: string;
  failureCode?: string;
  errorClass?: ActionErrorClass;
  actionIndex?: number;
}>;

export type DeadLetterInfo = DeadLetterDetail & Readonly<{ deadLetteredAt: string }>;

export type StoredRun = Readonly<{
  runId: string;
  eventId: string;
  workspaceId: string;
  automationId: string;
  version: number;
  contentHash: string;
  status: RunStatus;
  revision: number;
  fencingToken: number;
  runAfter: string;
  /** First execution instant, retained across retry_wait transitions for the age budget. */
  firstAttemptAt?: string;
  attemptCount?: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /** Why the run last returned to the queue (e.g. LEASE_EXPIRED, WORKER_SHUTDOWN, DEAD_LETTER_RETRY). */
  interruptedReason?: string;
  chainKey?: string;  
  hop?: number;  
  traceparent?: string;  
  /** Why a run was recorded as skipped (for example SELF_TRIGGER). */  
  skipReason?: string;
  /** Set only on a run created by an audited replay; points at the source run. */
  replayOf?: string;
  /** Present only while status is dead_letter. */
  deadLetter?: DeadLetterInfo;
}>;

export type ActionAttempt = Readonly<{
  runId: string;
  workspaceId: string;
  actionIndex: number;
  attempt: number;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
  /** Registered action type; recovery uses it to decide whether a repeat is safe. */
  actionType?: string;
}>;

export type RunTransitionResult = "updated" | "stale" | "illegal" | "not-found";
export type RunClaimResult = Readonly<{ kind: "claimed"; run: StoredRun }> | Readonly<{ kind: "none" }>;
export type RunLeaseResult = Readonly<{ kind: "renewed"; run: StoredRun }> | Readonly<{ kind: "stale" }>;
export type RunInterruptResult = "requeued" | "stale";
export type RecoveredRun = Readonly<{ runId: string; previousFencingToken: number }>;
export type DeadLetterResult = "dead_lettered" | "stale";
export type RequeueDeadLetterResult = "requeued" | "stale" | "not-found";
export type DeadLetterCursor = Readonly<{ updatedAt: string; runId: string }>;
export type DeadLetterPage = Readonly<{ items: readonly StoredRun[]; next: DeadLetterCursor | undefined }>;
export type DeadLetterBacklog = Readonly<{ count: number; oldestAgeMs: number | undefined }>;

export type RunRepository = Readonly<{
  insert: (scope: WorkspaceScope, run: StoredRun) => Promise<"created" | "idempotent">;
  transition: (scope: WorkspaceScope, runId: string, expectedRevision: number, from: RunStatus, to: RunStatus, now: string, fencingToken?: number) => Promise<RunTransitionResult>;
  claimNext: (scope: WorkspaceScope, workerId: string, now: string, leaseDurationMs: number) => Promise<RunClaimResult>;
  insertActionAttempt: (scope: WorkspaceScope, attempt: ActionAttempt) => Promise<"created" | "idempotent">;
  updateActionAttempt: (scope: WorkspaceScope, attempt: ActionAttempt) => Promise<"updated" | "stale" | "not-found">;
  scheduleRetry: (scope: WorkspaceScope, runId: string, expectedRevision: number, fencingToken: number, now: string, runAfter: string, firstAttemptAt: string, failureCode: string) => Promise<RunTransitionResult>;
  findById: (scope: WorkspaceScope, runId: string) => Promise<StoredRun | undefined>;
  /** Heartbeat. Fenced by owner + token and refused once the lease expired. Does not bump revision. */
  renewLease: (scope: WorkspaceScope, runId: string, workerId: string, fencingToken: number, now: string, leaseDurationMs: number) => Promise<RunLeaseResult>;
  /** Owner-only controlled return to the queue (graceful shutdown). Running actions become unknown_outcome. */
  interruptRun: (scope: WorkspaceScope, runId: string, fencingToken: number, now: string, reason: string) => Promise<RunInterruptResult>;
  /** Reaper pass for one workspace. Bounded and idempotent. */
  recoverExpiredLeases: (scope: WorkspaceScope, now: string, batchSize: number) => Promise<readonly RecoveredRun[]>;
  /** Fenced running -> dead_letter. The only way into dead_letter; persists the reason and attempts. */
  deadLetterRun: (scope: WorkspaceScope, runId: string, fencingToken: number, now: string, detail: DeadLetterDetail) => Promise<DeadLetterResult>;
  /** Newest dead-lettered runs first, cursor paginated, one workspace only. */
  listDeadLetters: (scope: WorkspaceScope, page: Readonly<{ after: DeadLetterCursor | undefined; limit: number }>) => Promise<DeadLetterPage>;
  listActionAttempts: (scope: WorkspaceScope, runId: string) => Promise<readonly ActionAttempt[]>;
  /** Controlled dead_letter -> queued (revision checked). The generic transition table keeps dead_letter terminal. */
  requeueDeadLetter: (scope: WorkspaceScope, runId: string, expectedRevision: number, now: string) => Promise<RequeueDeadLetterResult>;
  deadLetterBacklog: (scope: WorkspaceScope, now: string) => Promise<DeadLetterBacklog>;
}>;

export type RunCollectionNames = Readonly<{ runs: string; actions: string }>;
export const runCollectionNames: RunCollectionNames = Object.freeze({ runs: "automation_runs", actions: "automation_action_attempts" });

// dead_letter is reachable only through deadLetterRun and left only through requeueDeadLetter.
const legalTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  queued: ["running", "cancelled"], running: ["retry_wait", "completed", "failed", "cancelled"],
  retry_wait: ["running", "cancelled"], completed: [], failed: [], cancelled: [], skipped: [], dead_letter: []
};

export const isLegalRunTransition = (from: RunStatus, to: RunStatus): boolean => legalTransitions[from].includes(to);

const duplicate = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === 11000;
const asRun = (run: StoredRun): StoredRun => Object.freeze(structuredClone(run));
const asAttempt = (attempt: ActionAttempt): ActionAttempt => Object.freeze({
  runId: attempt.runId,
  workspaceId: attempt.workspaceId,
  actionIndex: attempt.actionIndex,
  attempt: attempt.attempt,
  status: attempt.status,
  createdAt: attempt.createdAt,
  updatedAt: attempt.updatedAt,
  ...(attempt.actionType === undefined ? {} : { actionType: attempt.actionType })
});
const maxRecoveryBatch = 100;
const maxListPage = 100;

export const ensureRunRepositoryIndexes = async (database: MongoDatabase, names = runCollectionNames): Promise<void> => {
  await Promise.all([
    database.collection(names.runs).createIndex({ workspaceId: 1, eventId: 1, automationId: 1, version: 1 }, { unique: true, name: "run_event_automation_version_unique" }),
    database.collection(names.runs).createIndex({ workspaceId: 1, status: 1, runAfter: 1, leaseExpiresAt: 1 }, { name: "run_claim_queue" }),
    database.collection(names.runs).createIndex({ workspaceId: 1, status: 1, leaseExpiresAt: 1 }, { name: "run_lease_expiry" }),
    database.collection(names.runs).createIndex({ workspaceId: 1, status: 1, updatedAt: -1, runId: -1 }, { name: "run_dead_letter_list" }),
    database.collection(names.runs).createIndex({ workspaceId: 1, createdAt: -1 }, { name: "run_history" }),
    database.collection(names.actions).createIndex({ workspaceId: 1, runId: 1, actionIndex: 1, attempt: 1 }, { unique: true, name: "action_attempt_unique" }),
    database.collection(names.actions).createIndex({ workspaceId: 1, runId: 1, createdAt: 1 }, { name: "action_history" })
  ]);
};

export const createMongoRunRepository = async ({ database, ownsScope, collectionNames = runCollectionNames }: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: RunCollectionNames;
}>): Promise<RunRepository> => {
  await ensureRunRepositoryIndexes(database, collectionNames);
  const requireScope = (scope: WorkspaceScope): void => { if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required."); };
  const runs = database.collection<StoredRun>(collectionNames.runs);
  const actions = database.collection<ActionAttempt>(collectionNames.actions);

  /** An action that was running when its worker disappeared may or may not have produced its effect. */
  const markActionsUnknown = async (scope: WorkspaceScope, runId: string, now: string): Promise<void> => {
    await actions.updateMany(
      { workspaceId: scope.workspaceId, runId, status: "running" },
      { $set: { status: "unknown_outcome", updatedAt: now } }
    );
  };

  return Object.freeze({
    insert: async (scope, run) => {
      requireScope(scope);
      if (run.workspaceId !== scope.workspaceId) throw new Error("Run workspace must match trusted scope.");
      try { await runs.insertOne(structuredClone(run)); return "created" as const; }
      catch (error) { if (!duplicate(error)) throw error; return "idempotent" as const; }
    },
    transition: async (scope, runId, expectedRevision, from, to, now, fencingToken) => {
      requireScope(scope);
      if (!isLegalRunTransition(from, to)) return "illegal";
      const filter: Record<string, unknown> = { workspaceId: scope.workspaceId, runId, status: from, revision: expectedRevision };
      if (fencingToken !== undefined) filter.fencingToken = fencingToken;
      const result = await runs.updateOne(filter, { $set: { status: to, updatedAt: now }, $inc: { revision: 1 } });
      if (result.matchedCount === 1) return "updated";
      const exists = await runs.findOne({ workspaceId: scope.workspaceId, runId });
      return exists ? "stale" : "not-found";
    },
    claimNext: async (scope, workerId, now, leaseDurationMs) => {
      requireScope(scope);
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseDurationMs).toISOString();
      const claimed = await runs.findOneAndUpdate(
        { workspaceId: scope.workspaceId, status: { $in: ["queued", "retry_wait"] }, runAfter: { $lte: now }, $or: [{ leaseExpiresAt: { $exists: false } }, { leaseExpiresAt: { $lte: now } }] },
        { $set: { status: "running", leaseOwner: workerId, leaseExpiresAt, updatedAt: now }, $inc: { revision: 1, fencingToken: 1, attemptCount: 1 } },
        { sort: { runAfter: 1, createdAt: 1 }, returnDocument: "after" }
      );
      return claimed ? Object.freeze({ kind: "claimed", run: asRun(claimed) }) : Object.freeze({ kind: "none" });
    },
    insertActionAttempt: async (scope, attempt) => {
      requireScope(scope);
      if (attempt.workspaceId !== scope.workspaceId) throw new Error("Action workspace must match trusted scope.");
      try { await actions.insertOne(structuredClone(attempt)); return "created" as const; }
      catch (error) { if (!duplicate(error)) throw error; return "idempotent" as const; }
    },
    updateActionAttempt: async (scope, attempt) => {
      requireScope(scope);
      const result = await actions.updateOne(
        { workspaceId: scope.workspaceId, runId: attempt.runId, actionIndex: attempt.actionIndex, attempt: attempt.attempt, status: "running" },
        { $set: { status: attempt.status, updatedAt: attempt.updatedAt, ...(attempt.actionType === undefined ? {} : { actionType: attempt.actionType }) } }
      );
      if (result.matchedCount === 1) return "updated" as const;
      const exists = await actions.findOne({ workspaceId: scope.workspaceId, runId: attempt.runId, actionIndex: attempt.actionIndex, attempt: attempt.attempt });
      return exists ? "stale" as const : "not-found" as const;
    },
    scheduleRetry: async (scope, runId, expectedRevision, fencingToken, now, runAfter, firstAttemptAt, failureCode) => {
      requireScope(scope);
      const result = await runs.updateOne(
        { workspaceId: scope.workspaceId, runId, status: "running", revision: expectedRevision, fencingToken },
        { $set: { status: "retry_wait", runAfter, firstAttemptAt, updatedAt: now, interruptedReason: failureCode }, $unset: { leaseOwner: "", leaseExpiresAt: "" }, $inc: { revision: 1 } }
      );
      if (result.matchedCount === 1) return "updated" as const;
      const exists = await runs.findOne({ workspaceId: scope.workspaceId, runId });
      return exists ? "stale" as const : "not-found" as const;
    },
    findById: async (scope, runId) => {
      requireScope(scope);
      const found = await runs.findOne({ workspaceId: scope.workspaceId, runId });
      return found ? asRun(found) : undefined;
    },
    renewLease: async (scope, runId, workerId, fencingToken, now, leaseDurationMs) => {
      requireScope(scope);
      const leaseExpiresAt = new Date(new Date(now).getTime() + leaseDurationMs).toISOString();
      const renewed = await runs.findOneAndUpdate(
        { workspaceId: scope.workspaceId, runId, status: "running", leaseOwner: workerId, fencingToken, leaseExpiresAt: { $gt: now } },
        { $set: { leaseExpiresAt, updatedAt: now } },
        { returnDocument: "after" }
      );
      return renewed ? Object.freeze({ kind: "renewed", run: asRun(renewed) }) : Object.freeze({ kind: "stale" });
    },
    interruptRun: async (scope, runId, fencingToken, now, reason) => {
      requireScope(scope);
      // Verify ownership BEFORE touching actions, so a stale caller cannot damage the new owner's work.
      const owned = await runs.findOne({ workspaceId: scope.workspaceId, runId, status: "running", fencingToken });
      if (!owned) return "stale";
      await markActionsUnknown(scope, runId, now);
      const result = await runs.updateOne(
        { workspaceId: scope.workspaceId, runId, status: "running", fencingToken },
        { $set: { status: "queued", updatedAt: now, interruptedReason: reason }, $unset: { leaseOwner: "", leaseExpiresAt: "" }, $inc: { revision: 1 } }
      );
      return result.matchedCount === 1 ? "requeued" : "stale";
    },
    recoverExpiredLeases: async (scope, now, batchSize) => {
      requireScope(scope);
      const recovered: RecoveredRun[] = [];
      const limit = Math.max(1, Math.min(batchSize, maxRecoveryBatch));
      for (let index = 0; index < limit; index += 1) {
        const expired = await runs.findOne(
          { workspaceId: scope.workspaceId, status: "running", leaseExpiresAt: { $lte: now } },
          { sort: { leaseExpiresAt: 1 } }
        );
        if (!expired) break;
        await markActionsUnknown(scope, expired.runId, now);
        const result = await runs.updateOne(
          { workspaceId: scope.workspaceId, runId: expired.runId, status: "running", fencingToken: expired.fencingToken, leaseExpiresAt: { $lte: now } },
          { $set: { status: "queued", updatedAt: now, interruptedReason: "LEASE_EXPIRED" }, $unset: { leaseOwner: "", leaseExpiresAt: "" }, $inc: { revision: 1 } }
        );
        if (result.matchedCount === 1) recovered.push(Object.freeze({ runId: expired.runId, previousFencingToken: expired.fencingToken }));
      }
      return Object.freeze(recovered);
    },
    deadLetterRun: async (scope, runId, fencingToken, now, detail) => {
      requireScope(scope);
      const deadLetter: DeadLetterInfo = { ...detail, deadLetteredAt: now };
      const result = await runs.updateOne(
        { workspaceId: scope.workspaceId, runId, status: "running", fencingToken },
        { $set: { status: "dead_letter", updatedAt: now, deadLetter }, $unset: { leaseOwner: "", leaseExpiresAt: "" }, $inc: { revision: 1 } }
      );
      return result.matchedCount === 1 ? "dead_lettered" : "stale";
    },
    listDeadLetters: async (scope, page) => {
      requireScope(scope);
      const limit = Math.max(1, Math.min(page.limit, maxListPage));
      const cursorFilter = page.after
        ? { $or: [{ updatedAt: { $lt: page.after.updatedAt } }, { updatedAt: page.after.updatedAt, runId: { $lt: page.after.runId } }] }
        : {};
      const selected = await runs.find({ workspaceId: scope.workspaceId, status: "dead_letter", ...cursorFilter })
        .sort({ updatedAt: -1, runId: -1 })
        .limit(limit + 1)
        .toArray();
      const hasMore = selected.length > limit;
      const items = Object.freeze(selected.slice(0, limit).map((run) => asRun(run)));
      const last = items[items.length - 1];
      const next = hasMore && last ? Object.freeze({ updatedAt: last.updatedAt, runId: last.runId }) : undefined;
      return Object.freeze({ items, next });
    },
    listActionAttempts: async (scope, runId) => {
      requireScope(scope);
      const found = await actions.find({ workspaceId: scope.workspaceId, runId }).sort({ actionIndex: 1, attempt: 1 }).toArray();
      return Object.freeze(found.map((attempt) => asAttempt(attempt)));
    },
    requeueDeadLetter: async (scope, runId, expectedRevision, now) => {
      requireScope(scope);
      const result = await runs.updateOne(
        { workspaceId: scope.workspaceId, runId, status: "dead_letter", revision: expectedRevision },
        { $set: { status: "queued", runAfter: now, updatedAt: now, interruptedReason: "DEAD_LETTER_RETRY" }, $unset: { deadLetter: "" }, $inc: { revision: 1 } }
      );
      if (result.matchedCount === 1) return "requeued";
      const exists = await runs.findOne({ workspaceId: scope.workspaceId, runId });
      return exists ? "stale" : "not-found";
    },
    deadLetterBacklog: async (scope, now) => {
      requireScope(scope);
      const filter = { workspaceId: scope.workspaceId, status: "dead_letter" as const };
      const count = await runs.countDocuments(filter);
      if (count === 0) return Object.freeze({ count, oldestAgeMs: undefined });
      const oldest = await runs.findOne(filter, { sort: { updatedAt: 1 } });
      const oldestAgeMs = oldest ? Math.max(0, Date.parse(now) - Date.parse(oldest.updatedAt)) : undefined;
      return Object.freeze({ count, oldestAgeMs });
    }
  });
};
