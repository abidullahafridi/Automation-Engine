import type { WorkspaceScope } from "./automation.ports.js";
import { freezeAuditRecord, verifyAuditRecord, type AuditRecord } from "./audit.record.js";

export const maxAuditPage = 100;

export type AuditCursor = Readonly<{ occurredAt: string; recordId: string }>;

export type AuditQuery = Readonly<{
  targetId: string | undefined;
  after: AuditCursor | undefined;
  limit: number;
}>;

export type AuditPage = Readonly<{
  items: readonly AuditRecord[];
  next: AuditCursor | undefined;
}>;

export type AuditAppendResult = "appended" | "idempotent" | "conflict";

/**
 * Append-only by construction: this surface has no update, replace or delete.
 * A second append with the same recordId and different content is a conflict and changes nothing.
 */
export type AuditLog = Readonly<{
  append: (scope: WorkspaceScope, record: AuditRecord) => Promise<AuditAppendResult>;
  list: (scope: WorkspaceScope, query: AuditQuery) => Promise<AuditPage>;
}>;

export const normalizeAuditLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Audit page limit must be a positive integer.");
  return Math.min(limit, maxAuditPage);
};

/** Fail closed before storage: wrong workspace or a record that does not match its own hash. */
export const assertStorableAuditRecord = (scope: WorkspaceScope, record: AuditRecord): void => {
  if (record.workspaceId !== scope.workspaceId) {
    throw new Error("Audit record workspace must match the trusted scope.");
  }
  if (!verifyAuditRecord(record)) throw new Error("Audit record failed its integrity check.");
};

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const compareAuditRecords = (left: AuditRecord, right: AuditRecord): number =>
  compareText(left.occurredAt, right.occurredAt) || compareText(left.recordId, right.recordId);

export const isAfterAuditCursor = (record: AuditRecord, cursor: AuditCursor): boolean =>
  record.occurredAt > cursor.occurredAt ||
  (record.occurredAt === cursor.occurredAt && record.recordId > cursor.recordId);

/** `rows` must already be ordered and may contain one extra row to signal another page. */
export const toAuditPage = (rows: readonly AuditRecord[], limit: number): AuditPage => {
  const items = Object.freeze(rows.slice(0, limit));
  const last = items[items.length - 1];
  const next = rows.length > limit && last !== undefined
    ? Object.freeze({ occurredAt: last.occurredAt, recordId: last.recordId })
    : undefined;
  return Object.freeze({ items, next });
};

export type InMemoryAuditLog = Readonly<{
  log: AuditLog;
  size: () => number;
}>;

export const createInMemoryAuditLog = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryAuditLog => {
  const records = new Map<string, AuditRecord>();
  const keyOf = (workspaceId: string, recordId: string): string => `${workspaceId}\u0000${recordId}`;
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const log: AuditLog = Object.freeze({
    append: async (scope: WorkspaceScope, record: AuditRecord): Promise<AuditAppendResult> => {
      await Promise.resolve();
      requireScope(scope);
      assertStorableAuditRecord(scope, record);
      const key = keyOf(scope.workspaceId, record.recordId);
      const existing = records.get(key);
      if (existing !== undefined) {
        return existing.contentHash === record.contentHash ? "idempotent" : "conflict";
      }
      records.set(key, freezeAuditRecord(structuredClone(record)));
      return "appended";
    },
    list: async (scope: WorkspaceScope, query: AuditQuery): Promise<AuditPage> => {
      await Promise.resolve();
      requireScope(scope);
      const limit = normalizeAuditLimit(query.limit);
      const after = query.after;
      const rows = [...records.values()]
        .filter((record) =>
          record.workspaceId === scope.workspaceId &&
          (query.targetId === undefined || record.target.id === query.targetId) &&
          (after === undefined || isAfterAuditCursor(record, after)))
        .sort(compareAuditRecords);
      return toAuditPage(rows.slice(0, limit + 1), limit);
    }
  });

  return Object.freeze({ log, size: (): number => records.size });
};