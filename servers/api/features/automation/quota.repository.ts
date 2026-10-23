import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type { ChainBudgetPort, ChainBudgetResult } from "./loop.guard.js";
import type { QuotaCounterKey, QuotaCounterPort, QuotaCounterResult } from "./quota.service.js";

type CounterDocument = Readonly<{
  workspaceId: string;
  name: string;
  windowStart: string;
  used: number;
  expiresAt: Date;
}>;

type CounterIdentity = Readonly<{ workspaceId: string; name: string; windowStart: string }>;

export type QuotaCollectionNames = Readonly<{
  counters: string;
  globalCounters: string;
  chainBudgets: string;
}>;

export const quotaCollectionNames: QuotaCollectionNames = Object.freeze({
  counters: "automation_quota_counters",
  globalCounters: "automation_quota_global_counters",
  chainBudgets: "automation_chain_budgets"
});

/** Provisional: must exceed the longest expected chain duration. */
const chainBudgetTtlMs = 24 * 60 * 60 * 1000;
const globalWorkspaceId = "global";
const chainWindow = "chain";

export const ensureQuotaRepositoryIndexes = async (
  database: MongoDatabase,
  names: QuotaCollectionNames = quotaCollectionNames
): Promise<void> => {
  const all = [names.counters, names.globalCounters, names.chainBudgets];
  await Promise.all(all.flatMap((name) => [
    database.collection(name).createIndex(
      { workspaceId: 1, name: 1, windowStart: 1 },
      { unique: true, name: "quota_counter_unique" }
    ),
    database.collection(name).createIndex(
      { expiresAt: 1 },
      { expireAfterSeconds: 0, name: "quota_counter_ttl" }
    )
  ]));
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

/**
 * Atomic guarded increment.
 * - Upsert creates the first counter document (used = 1).
 * - A document already at the limit no longer matches the filter, so the upsert tries to insert,
 *   hits the unique index and is denied.
 * - A duplicate-key error can also come from a racing first insert, so one non-upsert retry decides.
 * Denied calls never change the counter.
 */
const consumeCounter = async (
  database: MongoDatabase,
  collectionName: string,
  identity: CounterIdentity,
  limit: number,
  expiresAt: Date
): Promise<QuotaCounterResult> => {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("Quota limit must be a positive integer.");
  }
  const collection = database.collection<CounterDocument>(collectionName);
  try {
    const updated = await collection.findOneAndUpdate(
      { ...identity, used: { $lt: limit } },
      { $inc: { used: 1 }, $setOnInsert: { expiresAt } },
      { upsert: true, returnDocument: "after" }
    );
    if (updated === null) throw new Error("Quota counter update returned no document.");
    return Object.freeze({ allowed: true, used: updated.used });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const retried = await collection.findOneAndUpdate(
      { ...identity, used: { $lt: limit } },
      { $inc: { used: 1 } },
      { returnDocument: "after" }
    );
    return retried === null
      ? Object.freeze({ allowed: false, used: limit })
      : Object.freeze({ allowed: true, used: retried.used });
  }
};

export type MongoQuotaStores = Readonly<{
  counters: QuotaCounterPort;
  chainBudget: ChainBudgetPort;
}>;

export const createMongoQuotaStores = async ({
  database,
  ownsScope,
  collectionNames = quotaCollectionNames,
  now = (): Date => new Date()
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: QuotaCollectionNames;
  now?: () => Date;
}>): Promise<MongoQuotaStores> => {
  await ensureQuotaRepositoryIndexes(database, collectionNames);

  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const counters: QuotaCounterPort = Object.freeze({
    consume: async (scope: WorkspaceScope, counter: QuotaCounterKey, limit: number): Promise<QuotaCounterResult> => {
      requireScope(scope);
      return consumeCounter(
        database,
        collectionNames.counters,
        { workspaceId: scope.workspaceId, name: counter.name, windowStart: counter.windowStart },
        limit,
        new Date(counter.windowEnd)
      );
    },
    consumeGlobal: async (counter: QuotaCounterKey, limit: number): Promise<QuotaCounterResult> =>
      consumeCounter(
        database,
        collectionNames.globalCounters,
        { workspaceId: globalWorkspaceId, name: counter.name, windowStart: counter.windowStart },
        limit,
        new Date(counter.windowEnd)
      ),
    refund: async (scope: WorkspaceScope, counter: QuotaCounterKey): Promise<void> => {
      requireScope(scope);
      await database.collection<CounterDocument>(collectionNames.counters).updateOne(
        { workspaceId: scope.workspaceId, name: counter.name, windowStart: counter.windowStart, used: { $gt: 0 } },
        { $inc: { used: -1 } }
      );
    }
  });

  const chainBudget: ChainBudgetPort = Object.freeze({
    consume: async (scope: WorkspaceScope, chainKey: string, limit: number): Promise<ChainBudgetResult> => {
      requireScope(scope);
      return consumeCounter(
        database,
        collectionNames.chainBudgets,
        { workspaceId: scope.workspaceId, name: `chain:${chainKey}`, windowStart: chainWindow },
        limit,
        new Date(now().getTime() + chainBudgetTtlMs)
      );
    }
  });

  return Object.freeze({ counters, chainBudget });
};