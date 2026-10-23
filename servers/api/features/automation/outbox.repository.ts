/**
 * Outbox repository — ADR-0003
 *
 * Domain mutation and its outbox event are written in the SAME MongoDB multi-document
 * transaction (majority write concern). The relay then claims pending records, publishes
 * them, and marks them published. Stale leases are recoverable.
 *
 * Production feature flag: outbox/ingest stays default OFF behind the ADR-0003 gate.
 */

import type { Collection } from "mongodb";
import type { MongoDatabase, TransactionSession } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type OutboxStatus = "pending" | "published";

export type OutboxRecord = Readonly<{
  /** Globally-unique event id (used for idempotency). */
  outboxId: string;
  workspaceId: string;
  eventType: string;
  /** Raw validated event payload (BSON-serialisable, no credentials). */
  payload: Record<string, unknown>;
  createdAt: string; // ISO-8601 instant
  status: OutboxStatus;
  /** Set while relay holds the lease; undefined when not claimed. */
  leaseExpiresAt?: string; // ISO-8601 instant
  publishedAt?: string; // ISO-8601 instant
}>;

export type ClaimOutboxResult =
  | Readonly<{ kind: "claimed"; record: OutboxRecord }>
  | Readonly<{ kind: "none" }>;

export type MarkPublishedResult = "published" | "not-found";

/**
 * OutboxRepository — all methods require a resolver-minted WorkspaceScope.
 */
export type OutboxRepository = Readonly<{
  /**
   * Insert an outbox record as part of an in-progress MongoDB session/transaction.
   * The session parameter is required so the insert participates in the caller's transaction.
   */
  insertPending: (
    scope: WorkspaceScope,
    record: Omit<OutboxRecord, "status" | "leaseExpiresAt" | "publishedAt">,
    session: TransactionSession
  ) => Promise<void>;

  /**
   * Claim the next pending record whose lease has not yet been set or has expired.
   * Sets leaseExpiresAt to now + leaseDurationMs.
   */
  claimNextPending: (
    scope: WorkspaceScope,
    now: string,
    leaseDurationMs: number
  ) => Promise<ClaimOutboxResult>;

  /**
   * Mark a claimed record as published. Only succeeds if the record exists in the
   * given workspace (cross-workspace safety).
   */
  markPublished: (
    scope: WorkspaceScope,
    outboxId: string,
    publishedAt: string
  ) => Promise<MarkPublishedResult>;

  /**
   * Count records by status for observability (pending-age metric support).
   */
  countByStatus: (
    scope: WorkspaceScope,
    status: OutboxStatus
  ) => Promise<number>;

  /**
   * Find a record by outboxId within the workspace (for idempotency verification).
   */
  findById: (
    scope: WorkspaceScope,
    outboxId: string
  ) => Promise<OutboxRecord | undefined>;

  /**
   * Get the age in milliseconds of the oldest pending record in the workspace.
   * Returns undefined if there are no pending records.
   */
  getOldestPendingAgeMs: (
    scope: WorkspaceScope,
    now: string
  ) => Promise<number | undefined>;
}>;

/** Method names for the tenant matrix. */
export const outboxRepositoryMethodNames = Object.freeze([
  "insertPending",
  "claimNextPending",
  "markPublished",
  "countByStatus",
  "findById",
  "getOldestPendingAgeMs"
] as const satisfies readonly (keyof OutboxRepository)[]);


// ---------------------------------------------------------------------------
// Collection names
// ---------------------------------------------------------------------------

export const outboxCollectionNames = Object.freeze({
  records: "automation_outbox"
});

export type OutboxCollectionNames = Readonly<{ records: string }>;

// ---------------------------------------------------------------------------
// MongoDB helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MongoDB index setup
// ---------------------------------------------------------------------------

export const ensureOutboxRepositoryIndexes = async (
  database: MongoDatabase,
  names: OutboxCollectionNames = outboxCollectionNames
): Promise<void> => {
  const records = database.collection<StoredOutboxRecord>(names.records);
  await Promise.all([
    // Unique index on outboxId (global dedup / idempotency for the relay).
    records.createIndex(
      { outboxId: 1 },
      { unique: true, name: "outbox_id_unique" }
    ),
    // Compound index for the relay claim query (status, leaseExpiresAt, workspaceId).
    records.createIndex(
      { workspaceId: 1, status: 1, leaseExpiresAt: 1 },
      { name: "outbox_workspace_status_lease" }
    ),
    // Index for workspace-scoped reads.
    records.createIndex(
      { workspaceId: 1, outboxId: 1 },
      { unique: true, name: "outbox_workspace_id_unique" }
    )
  ]);
};

// ---------------------------------------------------------------------------
// Stored document type (same shape as OutboxRecord for Mongo)
// ---------------------------------------------------------------------------

type StoredOutboxRecord = {
  outboxId: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: OutboxStatus;
  leaseExpiresAt?: string;
  publishedAt?: string;
};

const toOutboxRecord = (stored: StoredOutboxRecord): OutboxRecord =>
  Object.freeze({
    outboxId: stored.outboxId,
    workspaceId: stored.workspaceId,
    eventType: stored.eventType,
    payload: Object.freeze(structuredClone(stored.payload)),
    createdAt: stored.createdAt,
    status: stored.status,
    ...(stored.leaseExpiresAt === undefined ? {} : { leaseExpiresAt: stored.leaseExpiresAt }),
    ...(stored.publishedAt === undefined ? {} : { publishedAt: stored.publishedAt })
  });

// ---------------------------------------------------------------------------
// MongoDB implementation
// ---------------------------------------------------------------------------

export const createMongoOutboxRepository = async ({
  database,
  ownsScope,
  collectionNames = outboxCollectionNames
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: OutboxCollectionNames;
}>): Promise<OutboxRepository> => {
  await ensureOutboxRepositoryIndexes(database, collectionNames);
  const records: Collection<StoredOutboxRecord> = database.collection<StoredOutboxRecord>(
    collectionNames.records
  );

  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const repository: OutboxRepository = Object.freeze({
    insertPending: async (scope, record, session): Promise<void> => {
      requireScope(scope);
      const stored: StoredOutboxRecord = {
        outboxId: record.outboxId,
        workspaceId: scope.workspaceId,
        eventType: record.eventType,
        payload: structuredClone(record.payload),
        createdAt: record.createdAt,
        status: "pending"
      };
      await records.insertOne(stored, { session: session as never, writeConcern: { w: "majority" } });
    },


    claimNextPending: async (scope, now, leaseDurationMs): Promise<ClaimOutboxResult> => {
      requireScope(scope);
      const leaseExpiry = new Date(new Date(now).getTime() + leaseDurationMs).toISOString();
      // Claim: find a pending record that has no lease, or whose lease has expired.
      const updated = await records.findOneAndUpdate(
        {
          workspaceId: scope.workspaceId,
          status: "pending",
          $or: [
            { leaseExpiresAt: { $exists: false } },
            { leaseExpiresAt: { $lt: now } }
          ]
        },
        { $set: { leaseExpiresAt: leaseExpiry } },
        {
          sort: { createdAt: 1 },
          returnDocument: "after",
          writeConcern: { w: "majority" }
        }
      );
      if (!updated) return Object.freeze({ kind: "none" });
      return Object.freeze({ kind: "claimed", record: toOutboxRecord(updated) });
    },

    markPublished: async (scope, outboxId, publishedAt): Promise<MarkPublishedResult> => {
      requireScope(scope);
      const result = await records.updateOne(
        { workspaceId: scope.workspaceId, outboxId },
        { $set: { status: "published", publishedAt } },
        { writeConcern: { w: "majority" } }
      );
      return result.matchedCount === 1 ? "published" : "not-found";
    },

    countByStatus: async (scope, status): Promise<number> => {
      requireScope(scope);
      return records.countDocuments({ workspaceId: scope.workspaceId, status });
    },

    findById: async (scope, outboxId): Promise<OutboxRecord | undefined> => {
      requireScope(scope);
      const stored = await records.findOne({ workspaceId: scope.workspaceId, outboxId });
      return stored ? toOutboxRecord(stored) : undefined;
    },

    getOldestPendingAgeMs: async (scope, now): Promise<number | undefined> => {
      requireScope(scope);
      const oldest = await records.findOne(
        { workspaceId: scope.workspaceId, status: "pending" },
        { sort: { createdAt: 1 } }
      );
      if (!oldest) return undefined;
      const oldestTime = new Date(oldest.createdAt).getTime();
      const currentTime = new Date(now).getTime();
      return Math.max(0, currentTime - oldestTime);
    }
  });

  return repository;
};

// ---------------------------------------------------------------------------
// In-memory implementation (contract tests / flag-OFF path)
// ---------------------------------------------------------------------------

export type InMemoryOutboxRepository = Readonly<{
  repository: OutboxRepository;
  /** Access stored records for assertion in tests. */
  snapshot: () => readonly OutboxRecord[];
}>;

export const createInMemoryOutboxRepository = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryOutboxRepository => {
  const store = new Map<string, OutboxRecord>();

  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const repository: OutboxRepository = Object.freeze({
    insertPending: async (scope, record, _session): Promise<void> => {
      await Promise.resolve();
      requireScope(scope);
      if (store.has(record.outboxId)) return; // idempotent duplicate
      const stored: OutboxRecord = Object.freeze({
        outboxId: record.outboxId,
        workspaceId: scope.workspaceId,
        eventType: record.eventType,
        payload: Object.freeze(structuredClone(record.payload)),
        createdAt: record.createdAt,
        status: "pending"
      });
      store.set(record.outboxId, stored);
    },

    claimNextPending: async (scope, now, leaseDurationMs): Promise<ClaimOutboxResult> => {
      await Promise.resolve();
      requireScope(scope);
      const leaseExpiry = new Date(new Date(now).getTime() + leaseDurationMs).toISOString();
      const candidate = [...store.values()].find(
        (r) =>
          r.workspaceId === scope.workspaceId &&
          r.status === "pending" &&
          (r.leaseExpiresAt === undefined || r.leaseExpiresAt < now)
      );
      if (!candidate) return Object.freeze({ kind: "none" });
      const updated: OutboxRecord = Object.freeze({ ...candidate, leaseExpiresAt: leaseExpiry });
      store.set(candidate.outboxId, updated);
      return Object.freeze({ kind: "claimed", record: updated });
    },

    markPublished: async (scope, outboxId, publishedAt): Promise<MarkPublishedResult> => {
      await Promise.resolve();
      requireScope(scope);
      const record = store.get(outboxId);
      if (!record || record.workspaceId !== scope.workspaceId) return "not-found";
      store.set(outboxId, Object.freeze({ ...record, status: "published", publishedAt }));
      return "published";
    },

    countByStatus: async (scope, status): Promise<number> => {
      await Promise.resolve();
      requireScope(scope);
      return [...store.values()].filter(
        (r) => r.workspaceId === scope.workspaceId && r.status === status
      ).length;
    },

    findById: async (scope, outboxId): Promise<OutboxRecord | undefined> => {
      await Promise.resolve();
      requireScope(scope);
      const record = store.get(outboxId);
      return record && record.workspaceId === scope.workspaceId ? record : undefined;
    },

    getOldestPendingAgeMs: async (scope, now): Promise<number | undefined> => {
      await Promise.resolve();
      requireScope(scope);
      const pending = [...store.values()]
        .filter((r) => r.workspaceId === scope.workspaceId && r.status === "pending")
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const oldest = pending[0];
      if (!oldest) return undefined;
      const oldestTime = new Date(oldest.createdAt).getTime();
      const currentTime = new Date(now).getTime();
      return Math.max(0, currentTime - oldestTime);
    }
  });

  return Object.freeze({
    repository,
    snapshot: () => Object.freeze([...store.values()])
  });
};


