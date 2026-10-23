import type { WorkspaceScope } from "../automation.ports.js";
import {
  isLegalRunTransition,
  type ActionAttempt,
  type RecoveredRun,
  type RunRepository,
  type StoredRun
} from "../run.repository.js";

const addMs = (iso: string, ms: number): string => new Date(new Date(iso).getTime() + ms).toISOString();

const clearLease = (run: StoredRun): StoredRun => {
  const copy: Record<string, unknown> = { ...run };
  delete copy.leaseOwner;
  delete copy.leaseExpiresAt;
  return copy as unknown as StoredRun;
};

/** Test double mirroring the Mongo repository's conditional-update semantics. */
export const createInMemoryRunRepository = (ownsScope: (scope: unknown) => scope is WorkspaceScope) => {
  const runs = new Map<string, StoredRun>();
  const actions = new Map<string, ActionAttempt>();
  const runKey = (workspaceId: string, runId: string): string => `${workspaceId}\u0000${runId}`;
  const actionKey = (a: ActionAttempt): string => `${a.workspaceId}\u0000${a.runId}\u0000${String(a.actionIndex)}\u0000${String(a.attempt)}`;
  const requireScope = (scope: WorkspaceScope): void => { if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required."); };

  const markActionsUnknown = (workspaceId: string, runId: string, now: string): void => {
    for (const [key, action] of actions) {
      if (action.workspaceId === workspaceId && action.runId === runId && action.status === "running") {
        actions.set(key, Object.freeze({ ...action, status: "unknown_outcome" as const, updatedAt: now }));
      }
    }
  };

  const repository: RunRepository = Object.freeze({
    insert: async (scope, run) => {
      await Promise.resolve();
      requireScope(scope);
      const key = runKey(scope.workspaceId, run.runId);
      if (runs.has(key)) return "idempotent" as const;
      runs.set(key, Object.freeze({ ...run }));
      return "created" as const;
    },
    transition: async (scope, runId, expectedRevision, from, to, now, fencingToken) => {
      await Promise.resolve();
      requireScope(scope);
      if (!isLegalRunTransition(from, to)) return "illegal";
      const key = runKey(scope.workspaceId, runId);
      const current = runs.get(key);
      if (!current) return "not-found";
      if (current.status !== from || current.revision !== expectedRevision ||
          (fencingToken !== undefined && current.fencingToken !== fencingToken)) return "stale";
      runs.set(key, Object.freeze({ ...current, status: to, updatedAt: now, revision: current.revision + 1 }));
      return "updated";
    },
    claimNext: async (scope, workerId, now, leaseDurationMs) => {
      await Promise.resolve();
      requireScope(scope);
      const candidate = [...runs.values()]
        .filter((run) => run.workspaceId === scope.workspaceId && (run.status === "queued" || run.status === "retry_wait") && run.runAfter <= now &&
          (run.leaseExpiresAt === undefined || run.leaseExpiresAt <= now))
        .sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.createdAt.localeCompare(b.createdAt))[0];
      if (!candidate) return Object.freeze({ kind: "none" as const });
      const claimed: StoredRun = Object.freeze({
        ...candidate, status: "running" as const, leaseOwner: workerId, leaseExpiresAt: addMs(now, leaseDurationMs),
        attemptCount: (candidate.attemptCount ?? 0) + 1,
        updatedAt: now, revision: candidate.revision + 1, fencingToken: candidate.fencingToken + 1
      });
      runs.set(runKey(scope.workspaceId, candidate.runId), claimed);
      return Object.freeze({ kind: "claimed" as const, run: claimed });
    },
    insertActionAttempt: async (scope, attempt) => {
      await Promise.resolve();
      requireScope(scope);
      const key = actionKey(attempt);
      if (actions.has(key)) return "idempotent" as const;
      actions.set(key, Object.freeze({ ...attempt }));
      return "created" as const;
    },
    updateActionAttempt: async (scope, attempt) => {
      await Promise.resolve();
      requireScope(scope);
      const key = actionKey(attempt);
      const current = actions.get(key);
      if (!current) return "not-found" as const;
      if (current.status !== "running") return "stale" as const;
      actions.set(key, Object.freeze({ ...current, status: attempt.status, updatedAt: attempt.updatedAt,
        ...(attempt.actionType === undefined ? {} : { actionType: attempt.actionType }) }));
      return "updated" as const;
    },
    scheduleRetry: async (scope, runId, expectedRevision, fencingToken, now, runAfter, firstAttemptAt, failureCode) => {
      await Promise.resolve();
      requireScope(scope);
      const key = runKey(scope.workspaceId, runId);
      const current = runs.get(key);
      if (!current) return "not-found" as const;
      if (current.status !== "running" || current.revision !== expectedRevision || current.fencingToken !== fencingToken) return "stale" as const;
      runs.set(key, Object.freeze({ ...clearLease(current), status: "retry_wait" as const, runAfter, firstAttemptAt,
        updatedAt: now, interruptedReason: failureCode, revision: current.revision + 1 }));
      return "updated" as const;
    },
    findById: async (scope, runId) => {
      await Promise.resolve();
      requireScope(scope);
      return runs.get(runKey(scope.workspaceId, runId));
    },
    renewLease: async (scope, runId, workerId, fencingToken, now, leaseDurationMs) => {
      await Promise.resolve();
      requireScope(scope);
      const key = runKey(scope.workspaceId, runId);
      const current = runs.get(key);
      if (!current || current.status !== "running" || current.leaseOwner !== workerId ||
          current.fencingToken !== fencingToken || current.leaseExpiresAt === undefined || current.leaseExpiresAt <= now) {
        return Object.freeze({ kind: "stale" as const });
      }
      const renewed: StoredRun = Object.freeze({ ...current, leaseExpiresAt: addMs(now, leaseDurationMs), updatedAt: now });
      runs.set(key, renewed);
      return Object.freeze({ kind: "renewed" as const, run: renewed });
    },
    interruptRun: async (scope, runId, fencingToken, now, reason) => {
      await Promise.resolve();
      requireScope(scope);
      const key = runKey(scope.workspaceId, runId);
      const current = runs.get(key);
      if (!current || current.status !== "running" || current.fencingToken !== fencingToken) return "stale";
      markActionsUnknown(scope.workspaceId, runId, now);
      runs.set(key, Object.freeze({ ...clearLease(current), status: "queued" as const, updatedAt: now, interruptedReason: reason, revision: current.revision + 1 }));
      return "requeued";
    },
    recoverExpiredLeases: async (scope, now, batchSize) => {
      await Promise.resolve();
      requireScope(scope);
      const expired = [...runs.values()]
        .filter((run) => run.workspaceId === scope.workspaceId && run.status === "running" &&
          run.leaseExpiresAt !== undefined && run.leaseExpiresAt <= now)
        .sort((a, b) => (a.leaseExpiresAt ?? "").localeCompare(b.leaseExpiresAt ?? ""))
        .slice(0, Math.max(1, Math.min(batchSize, 100)));
      const recovered: RecoveredRun[] = [];
      for (const run of expired) {
        markActionsUnknown(run.workspaceId, run.runId, now);
        runs.set(runKey(run.workspaceId, run.runId), Object.freeze({
          ...clearLease(run), status: "queued" as const, updatedAt: now, interruptedReason: "LEASE_EXPIRED", revision: run.revision + 1
        }));
        recovered.push(Object.freeze({ runId: run.runId, previousFencingToken: run.fencingToken }));
      }
      return Object.freeze(recovered);
    },
    deadLetterRun: async (scope, runId, fencingToken, now, detail) => {
      await Promise.resolve();
      requireScope(scope);
      const key = runKey(scope.workspaceId, runId);
      const current = runs.get(key);
      if (!current || current.status !== "running" || current.fencingToken !== fencingToken) return "stale";
      runs.set(key, Object.freeze({
        ...clearLease(current),
        status: "dead_letter" as const,
        updatedAt: now,
        revision: current.revision + 1,
        deadLetter: Object.freeze({ ...detail, deadLetteredAt: now })
      }));
      return "dead_lettered";
    },
    listDeadLetters: async (scope, page) => {
      await Promise.resolve();
      requireScope(scope);
      const limit = Math.max(1, Math.min(page.limit, 100));
      const selected = [...runs.values()]
        .filter((run) => run.workspaceId === scope.workspaceId && run.status === "dead_letter")
        .filter((run) => page.after === undefined || run.updatedAt < page.after.updatedAt ||
          (run.updatedAt === page.after.updatedAt && run.runId < page.after.runId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.runId.localeCompare(a.runId));
      const items = Object.freeze(selected.slice(0, limit));
      const last = items[items.length - 1];
      return Object.freeze({
        items,
        next: selected.length > limit && last
          ? Object.freeze({ updatedAt: last.updatedAt, runId: last.runId })
          : undefined
      });
    },
    listActionAttempts: async (scope, runId) => {
      await Promise.resolve();
      requireScope(scope);
      return Object.freeze([...actions.values()]
        .filter((action) => action.workspaceId === scope.workspaceId && action.runId === runId)
        .sort((a, b) => a.actionIndex - b.actionIndex || a.attempt - b.attempt));
    },
    requeueDeadLetter: async (scope, runId, expectedRevision, now) => {
      await Promise.resolve();
      requireScope(scope);
      const key = runKey(scope.workspaceId, runId);
      const current = runs.get(key);
      if (!current) return "not-found";
      if (current.status !== "dead_letter" || current.revision !== expectedRevision) return "stale";
      const requeued = { ...current, status: "queued" as const, runAfter: now, updatedAt: now,
        interruptedReason: "DEAD_LETTER_RETRY", revision: current.revision + 1 };
      delete requeued.deadLetter;
      runs.set(key, Object.freeze(requeued));
      return "requeued";
    },
    deadLetterBacklog: async (scope, now) => {
      await Promise.resolve();
      requireScope(scope);
      const deadLetters = [...runs.values()]
        .filter((run) => run.workspaceId === scope.workspaceId && run.status === "dead_letter")
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const oldest = deadLetters[0];
      return Object.freeze({
        count: deadLetters.length,
        oldestAgeMs: oldest ? Math.max(0, Date.parse(now) - Date.parse(oldest.updatedAt)) : undefined
      });
    }
  });

  return Object.freeze({
    repository,
    /** Simulates the executor starting an action (the repository has no action-update method yet). */
    startAction: (workspaceId: string, runId: string, actionIndex: number): void => {
      for (const [key, action] of actions) {
        if (action.workspaceId === workspaceId && action.runId === runId && action.actionIndex === actionIndex) {
          actions.set(key, Object.freeze({ ...action, status: "running" as const }));
        }
      }
    },
    actionStatuses: (runId: string): readonly string[] =>
      [...actions.values()].filter((action) => action.runId === runId).map((action) => action.status)
  });
};
