import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import {
  assertStorableAuditRecord,
  normalizeAuditLimit,
  toAuditPage,
  type AuditAppendResult,
  type AuditLog,
  type AuditPage,
  type AuditQuery
} from "./audit.log.js";
import { freezeAuditRecord, type AuditRecord } from "./audit.record.js";

export type AuditCollectionNames = Readonly<{ records: string }>;

export const auditCollectionNames: AuditCollectionNames = Object.freeze({ records: "automation_audit" });

/**
 * No TTL index on purpose: audit evidence is never removed by an operational expiry.
 * Retention is a separate, approved, audited process.
 */
export const ensureAuditRepositoryIndexes = async (
  database: MongoDatabase,
  names: AuditCollectionNames = auditCollectionNames
): Promise<void> => {
  const records = database.collection<AuditRecord>(names.records);
  await Promise.all([
    records.createIndex(
      { workspaceId: 1, recordId: 1 },
      { unique: true, name: "audit_workspace_record_unique" }
    ),
    records.createIndex(
      { workspaceId: 1, "target.id": 1, occurredAt: 1, recordId: 1 },
      { name: "audit_workspace_target_time" }
    ),
    records.createIndex(
      { workspaceId: 1, occurredAt: 1, recordId: 1 },
      { name: "audit_workspace_time" }
    )
  ]);
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

export const createMongoAuditLog = async ({
  database,
  ownsScope,
  collectionNames = auditCollectionNames,
  ensureIndexes = true
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: AuditCollectionNames;
  /** Set false when the runtime role only has find and insert; run migrations with a separate role. */
  ensureIndexes?: boolean;
}>): Promise<AuditLog> => {
  if (ensureIndexes) await ensureAuditRepositoryIndexes(database, collectionNames);
  const records = database.collection<AuditRecord>(collectionNames.records);

  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    append: async (scope: WorkspaceScope, record: AuditRecord): Promise<AuditAppendResult> => {
      requireScope(scope);
      assertStorableAuditRecord(scope, record);
      try {
        await records.insertOne(structuredClone(record));
        return "appended";
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await records.findOne({
          workspaceId: scope.workspaceId,
          recordId: record.recordId
        });
        return existing !== null && existing.contentHash === record.contentHash
          ? "idempotent"
          : "conflict";
      }
    },
    list: async (scope: WorkspaceScope, query: AuditQuery): Promise<AuditPage> => {
      requireScope(scope);
      const limit = normalizeAuditLimit(query.limit);
      const filter: Record<string, unknown> = { workspaceId: scope.workspaceId };
      if (query.targetId !== undefined) filter["target.id"] = query.targetId;
      if (query.after !== undefined) {
        filter.$or = [
          { occurredAt: { $gt: query.after.occurredAt } },
          { occurredAt: query.after.occurredAt, recordId: { $gt: query.after.recordId } }
        ];
      }
      const rows = await records.find(filter)
        .sort({ occurredAt: 1, recordId: 1 })
        .limit(limit + 1)
        .toArray();
      return toAuditPage(rows.map((row) => freezeAuditRecord(row)), limit);
    }
  });
};