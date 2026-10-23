import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import {
  runCollectionNames,
  type ActionAttempt,
  type RunCollectionNames,
  type StoredRun
} from "./run.repository.js";
import type { RunQueueHealth, RunQueueHealthPort } from "./ops.signals.js";
export type RunHistoryCursor = Readonly<{ createdAt: string; runId: string }>;
export type RunHistoryPage = Readonly<{
  items: readonly StoredRun[];
  next: RunHistoryCursor | undefined;
}>;

/** Read-only port: nothing here can create, change, or delete run state. */
export type RunHistoryRepository = Readonly<{
  listRuns: (
    scope: WorkspaceScope,
    automationId: string,
    page: Readonly<{ after: RunHistoryCursor | undefined; limit: number }>
  ) => Promise<RunHistoryPage>;
  findRun: (scope: WorkspaceScope, runId: string) => Promise<StoredRun | undefined>;
  listActionAttempts: (scope: WorkspaceScope, runId: string) => Promise<readonly ActionAttempt[]>;
}>;

export const runHistoryRepositoryMethodNames = Object.freeze([
  "listRuns",
  "findRun",
  "listActionAttempts"
] as const satisfies readonly (keyof RunHistoryRepository)[]);

export const maxRunHistoryPage = 100;

const clampLimit = (limit: number): number =>
  Math.max(1, Math.min(Math.trunc(limit), maxRunHistoryPage));

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const freezeRun = (run: StoredRun): StoredRun => Object.freeze(structuredClone(run));
const freezeAttempt = (attempt: ActionAttempt): ActionAttempt =>
  Object.freeze(structuredClone(attempt));

export const ensureRunHistoryIndexes = async (
  database: MongoDatabase,
  names: RunCollectionNames = runCollectionNames
): Promise<void> => {
  await database.collection(names.runs).createIndex(
    { workspaceId: 1, automationId: 1, createdAt: -1, runId: -1 },
    { name: "run_history_by_automation" }
  );
};

export const createMongoRunHistoryRepository = async ({
  database,
  ownsScope,
  collectionNames = runCollectionNames
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: RunCollectionNames;
}>): Promise<RunHistoryRepository> => {
  await ensureRunHistoryIndexes(database, collectionNames);
  const runs = database.collection<StoredRun>(collectionNames.runs);
  const actions = database.collection<ActionAttempt>(collectionNames.actions);
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    listRuns: async (scope, automationId, page): Promise<RunHistoryPage> => {
      requireScope(scope);
      const limit = clampLimit(page.limit);
      const cursorFilter = page.after
        ? {
          $or: [
            { createdAt: { $lt: page.after.createdAt } },
            { createdAt: page.after.createdAt, runId: { $lt: page.after.runId } }
          ]
        }
        : {};
      const selected = await runs.find({
        workspaceId: scope.workspaceId,
        automationId,
        ...cursorFilter
      }).sort({ createdAt: -1, runId: -1 }).limit(limit + 1).toArray();
      const hasMore = selected.length > limit;
      const items = Object.freeze(selected.slice(0, limit).map((run) => freezeRun(run)));
      const last = items[items.length - 1];
      const next = hasMore && last
        ? Object.freeze({ createdAt: last.createdAt, runId: last.runId })
        : undefined;
      return Object.freeze({ items, next });
    },

    findRun: async (scope, runId): Promise<StoredRun | undefined> => {
      requireScope(scope);
      const found = await runs.findOne({ workspaceId: scope.workspaceId, runId });
      return found ? freezeRun(found) : undefined;
    },

    listActionAttempts: async (scope, runId): Promise<readonly ActionAttempt[]> => {
      requireScope(scope);
      const found = await actions
        .find({ workspaceId: scope.workspaceId, runId })
        .sort({ actionIndex: 1, attempt: 1 })
        .toArray();
      return Object.freeze(found.map((attempt) => freezeAttempt(attempt)));
    }
  });
};

export type InMemoryRunHistoryRepository = Readonly<{
  repository: RunHistoryRepository;
  seedRun: (run: StoredRun) => void;
  seedAttempt: (attempt: ActionAttempt) => void;
  driverCallCount: () => number;
}>;

export const createInMemoryRunHistoryRepository = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryRunHistoryRepository => {
  const runs: StoredRun[] = [];
  const attempts: ActionAttempt[] = [];
  let driverCalls = 0;
  const beginDriverCall = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
    driverCalls += 1;
  };

  const repository: RunHistoryRepository = Object.freeze({
    listRuns: async (scope, automationId, page): Promise<RunHistoryPage> => {
      await Promise.resolve();
      beginDriverCall(scope);
      const limit = clampLimit(page.limit);
      const cursor = page.after;
      const ordered = runs
        .filter((run) => run.workspaceId === scope.workspaceId && run.automationId === automationId)
        .sort((left, right) =>
          compareText(right.createdAt, left.createdAt) || compareText(right.runId, left.runId));
      const afterCursor = cursor
        ? ordered.filter((run) =>
          run.createdAt < cursor.createdAt ||
          (run.createdAt === cursor.createdAt && run.runId < cursor.runId))
        : ordered;
      const selected = afterCursor.slice(0, limit + 1);
      const hasMore = selected.length > limit;
      const items = Object.freeze(selected.slice(0, limit).map((run) => freezeRun(run)));
      const last = items[items.length - 1];
      const next = hasMore && last
        ? Object.freeze({ createdAt: last.createdAt, runId: last.runId })
        : undefined;
      return Object.freeze({ items, next });
    },

    findRun: async (scope, runId): Promise<StoredRun | undefined> => {
      await Promise.resolve();
      beginDriverCall(scope);
      const found = runs.find((run) => run.workspaceId === scope.workspaceId && run.runId === runId);
      return found ? freezeRun(found) : undefined;
    },

    listActionAttempts: async (scope, runId): Promise<readonly ActionAttempt[]> => {
      await Promise.resolve();
      beginDriverCall(scope);
      return Object.freeze(attempts
        .filter((attempt) => attempt.workspaceId === scope.workspaceId && attempt.runId === runId)
        .sort((left, right) => left.actionIndex - right.actionIndex || left.attempt - right.attempt)
        .map((attempt) => freezeAttempt(attempt)));
    }
  });

  return Object.freeze({
    repository,
    seedRun: (run) => { runs.push(structuredClone(run)); },
    seedAttempt: (attempt) => { attempts.push(structuredClone(attempt)); },
    driverCallCount: () => driverCalls
  });
};


/**
 * Read-only queue health for alerts. Uses the existing claim and lease-expiry indexes.
 * Kept separate from RunHistoryRepository so that port's method list does not change.
 */
export const createMongoRunQueueHealth = ({
  database,
  ownsScope,
  collectionNames = runCollectionNames
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: RunCollectionNames;
}>): RunQueueHealthPort => {
  const runs = database.collection<StoredRun>(collectionNames.runs);
  return Object.freeze({
    read: async (scope: WorkspaceScope, now: string): Promise<RunQueueHealth> => {
      if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
      const [queuedCount, expiredRunningCount, oldest] = await Promise.all([
        runs.countDocuments({ workspaceId: scope.workspaceId, status: { $in: ["queued", "retry_wait"] } }),
        runs.countDocuments({
          workspaceId: scope.workspaceId,
          status: "running",
          leaseExpiresAt: { $lte: now }
        }),
        runs.findOne(
          { workspaceId: scope.workspaceId, status: { $in: ["queued", "retry_wait"] }, runAfter: { $lte: now } },
          { sort: { runAfter: 1 } }
        )
      ]);
      const oldestEligibleAgeMs = oldest
        ? Math.max(0, Date.parse(now) - Date.parse(oldest.runAfter))
        : undefined;
      return Object.freeze({ queuedCount, oldestEligibleAgeMs, expiredRunningCount });
    }
  });
};
