import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";

export type RecoveryReceipt =
  | Readonly<{ kind: "requeued"; runId: string; revision: number }>
  | Readonly<{ kind: "replayed"; runId: string; replayRunId: string }>;

export type RecoveryReserveResult =
  | Readonly<{ kind: "reserved" }>
  | Readonly<{ kind: "replay"; receipt: RecoveryReceipt }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "in-progress" }>;

/**
 * Atomic reserve -> complete|release. Only successful recoveries are completed; every other
 * outcome releases the key so the client can retry with the same key after fixing the cause.
 */
export type RecoveryIdempotencyStore = Readonly<{
  reserve: (scope: WorkspaceScope, key: string, requestHash: string, now: string) => Promise<RecoveryReserveResult>;
  complete: (scope: WorkspaceScope, key: string, receipt: RecoveryReceipt) => Promise<void>;
  release: (scope: WorkspaceScope, key: string) => Promise<void>;
}>;

export const recoveryIdempotencyMethodNames = Object.freeze([
  "reserve",
  "complete",
  "release"
] as const satisfies readonly (keyof RecoveryIdempotencyStore)[]);

type StoredRecord = Readonly<{
  workspaceId: string;
  key: string;
  requestHash: string;
  status: "pending" | "complete";
  createdAt: string;
  receipt?: RecoveryReceipt;
}>;

export const recoveryIdempotencyCollectionName = "automation_recovery_idempotency";

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

const fromRecord = (record: StoredRecord, requestHash: string): RecoveryReserveResult => {
  if (record.requestHash !== requestHash) return Object.freeze({ kind: "conflict" });
  if (record.status === "complete" && record.receipt) {
    return Object.freeze({ kind: "replay", receipt: record.receipt });
  }
  return Object.freeze({ kind: "in-progress" });
};

export const createInMemoryRecoveryIdempotencyStore = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): RecoveryIdempotencyStore => {
  const records = new Map<string, StoredRecord>();
  const keyOf = (scope: WorkspaceScope, key: string): string => `${scope.workspaceId}\u0000${key}`;
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };
  return Object.freeze({
    reserve: async (scope, key, requestHash, now) => {
      await Promise.resolve();
      requireScope(scope);
      const existing = records.get(keyOf(scope, key));
      if (existing) return fromRecord(existing, requestHash);
      records.set(keyOf(scope, key), Object.freeze({
        workspaceId: scope.workspaceId, key, requestHash, status: "pending" as const, createdAt: now
      }));
      return Object.freeze({ kind: "reserved" as const });
    },
    complete: async (scope, key, receipt) => {
      await Promise.resolve();
      requireScope(scope);
      const existing = records.get(keyOf(scope, key));
      if (!existing) return;
      records.set(keyOf(scope, key), Object.freeze({ ...existing, status: "complete" as const, receipt }));
    },
    release: async (scope, key) => {
      await Promise.resolve();
      requireScope(scope);
      const existing = records.get(keyOf(scope, key));
      if (existing?.status === "pending") records.delete(keyOf(scope, key));
    }
  });
};

export const ensureRecoveryIdempotencyIndexes = async (
  database: MongoDatabase,
  collectionName: string = recoveryIdempotencyCollectionName
): Promise<void> => {
  await database.collection(collectionName).createIndex(
    { workspaceId: 1, key: 1 },
    { unique: true, name: "recovery_idempotency_workspace_key_unique" }
  );
};

export const createMongoRecoveryIdempotencyStore = async ({
  database,
  ownsScope,
  collectionName = recoveryIdempotencyCollectionName
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionName?: string;
}>): Promise<RecoveryIdempotencyStore> => {
  await ensureRecoveryIdempotencyIndexes(database, collectionName);
  const records = database.collection<StoredRecord>(collectionName);
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };
  return Object.freeze({
    reserve: async (scope, key, requestHash, now) => {
      requireScope(scope);
      try {
        await records.insertOne({
          workspaceId: scope.workspaceId, key, requestHash, status: "pending", createdAt: now
        });
        return Object.freeze({ kind: "reserved" as const });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await records.findOne({ workspaceId: scope.workspaceId, key });
        // Released between the duplicate error and the read: treat as busy, the client retries.
        return existing ? fromRecord(existing, requestHash) : Object.freeze({ kind: "in-progress" as const });
      }
    },
    complete: async (scope, key, receipt) => {
      requireScope(scope);
      await records.updateOne(
        { workspaceId: scope.workspaceId, key, status: "pending" },
        { $set: { status: "complete", receipt } }
      );
    },
    release: async (scope, key) => {
      requireScope(scope);
      await records.deleteOne({ workspaceId: scope.workspaceId, key, status: "pending" });
    }
  });
};