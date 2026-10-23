import type { RuleDocument } from "./rule.validation.js";
import type { WorkspaceScope } from "./automation.ports.js";

export type AutomationHeader = Readonly<{
  automationId: string;
  workspaceId: string;
  name: string;
  createdBy: string;
  rev: number;
  status: "draft" | "enabled" | "paused" | "disabled" | "archived";
  draft: unknown;
  hasDraft: boolean;
  currentVersion: number | null;
  createdAt: string;
  updatedAt: string;
}>;

export type AutomationCursor = Readonly<{ createdAt: string; automationId: string }>;

export type AutomationPage = Readonly<{
  items: readonly AutomationHeader[];
  next: AutomationCursor | undefined;
}>;

export type CreateAutomationInput = Readonly<{
  automationId: string;
  name: string;
  createdBy: string;
  draft: unknown;
  idempotencyKey: string;
  requestHash: string;
  now: string;
}>;

export type CreateAutomationResult =
  | Readonly<{ kind: "created"; automation: AutomationHeader }>
  | Readonly<{ kind: "idempotent"; automation: AutomationHeader }>
  | Readonly<{ kind: "idempotency-conflict" }>;

export type PublishedAutomationVersion = Readonly<{
  automationId: string;
  workspaceId: string;
  version: number;
  schemaVersion: number;
  contentHash: string;
  publishKey: string;
  rule: RuleDocument;
  createdAt: string;
}>;

export type InsertVersionResult =
  | Readonly<{ kind: "inserted"; version: PublishedAutomationVersion }>
  | Readonly<{ kind: "idempotent"; version: PublishedAutomationVersion }>
  | Readonly<{ kind: "conflict" }>;

export type RevisionUpdateResult = "updated" | "idempotent" | "conflict" | "not-found";

export type StatusTransitionResult = "updated" | "conflict" | "not-found";

export type AutomationRepository = Readonly<{
  createDraft: (scope: WorkspaceScope, input: CreateAutomationInput) => Promise<CreateAutomationResult>;
  findById: (scope: WorkspaceScope, automationId: string) => Promise<AutomationHeader | undefined>;
  list: (
    scope: WorkspaceScope,
    page: Readonly<{ after: AutomationCursor | undefined; limit: number }>
  ) => Promise<AutomationPage>;
  updateDraft: (
    scope: WorkspaceScope,
    automationId: string,
    expectedRevision: number,
    draft: unknown,
    now: string
  ) => Promise<RevisionUpdateResult>;
  insertVersion: (
    scope: WorkspaceScope,
    version: PublishedAutomationVersion
  ) => Promise<InsertVersionResult>;
  findVersionByPublishKey: (
    scope: WorkspaceScope,
    automationId: string,
    publishKey: string
  ) => Promise<PublishedAutomationVersion | undefined>;
  listVersions: (
    scope: WorkspaceScope,
    automationId: string
  ) => Promise<readonly PublishedAutomationVersion[]>;
  compareAndSetCurrentVersion: (
    scope: WorkspaceScope,
    automationId: string,
    expectedRevision: number,
    version: number
  ) => Promise<RevisionUpdateResult>;
  transitionStatus: (
    scope: WorkspaceScope,
    automationId: string,
    expected: Readonly<{ revision: number; status: AutomationHeader["status"] }>,
    nextStatus: AutomationHeader["status"],
    now: string
  ) => Promise<StatusTransitionResult>;
}>;

export const automationRepositoryMethodNames = Object.freeze([
  "createDraft",
  "findById",
  "list",
  "updateDraft",
  "insertVersion",
  "findVersionByPublishKey",
  "listVersions",
  "compareAndSetCurrentVersion",
  "transitionStatus"
] as const satisfies readonly (keyof AutomationRepository)[]);

export type InMemoryAutomationRepository = Readonly<{
  repository: AutomationRepository;
  driverCallCount: () => number;
}>;

export const createInMemoryAutomationRepository = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryAutomationRepository => {
  const headers = new Map<string, AutomationHeader>();
  const versions = new Map<string, PublishedAutomationVersion>();
  const idempotency = new Map<string, Readonly<{ requestHash: string; automationId: string }>>();
  let driverCalls = 0;

  const storageKey = (workspaceId: string, automationId: string): string =>
    `${workspaceId}\u0000${automationId}`;
  const versionKey = (workspaceId: string, automationId: string, version: number): string =>
    `${storageKey(workspaceId, automationId)}\u0000${String(version)}`;
  const idempotencyKey = (workspaceId: string, key: string): string =>
    `${workspaceId}\u0000${key}`;
  const freezeDeep = <T>(value: T): T => {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freezeDeep(child);
      Object.freeze(value);
    }
    return value;
  };
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };
  const beginDriverCall = (scope: WorkspaceScope): void => {
    requireScope(scope);
    driverCalls += 1;
  };

  const repository: AutomationRepository = Object.freeze({
    createDraft: async (scope, input): Promise<CreateAutomationResult> => {
      await Promise.resolve();
      beginDriverCall(scope);
      const idemKey = idempotencyKey(scope.workspaceId, input.idempotencyKey);
      const previous = idempotency.get(idemKey);
      if (previous) {
        if (previous.requestHash !== input.requestHash) {
          return Object.freeze({ kind: "idempotency-conflict" });
        }
        const existing = headers.get(storageKey(scope.workspaceId, previous.automationId));
        if (!existing) throw new Error("Idempotency record references a missing automation.");
        return Object.freeze({ kind: "idempotent", automation: existing });
      }
      const key = storageKey(scope.workspaceId, input.automationId);
      if (headers.has(key)) return Object.freeze({ kind: "idempotency-conflict" });
      const storedDraft = freezeDeep(structuredClone(input.draft));
      const automation = Object.freeze({
        automationId: input.automationId,
        workspaceId: scope.workspaceId,
        name: input.name,
        createdBy: input.createdBy,
        rev: 0,
        status: "draft" as const,
        draft: storedDraft,
        hasDraft: true,
        currentVersion: null,
        createdAt: input.now,
        updatedAt: input.now
      });
      headers.set(key, automation);
      idempotency.set(idemKey, Object.freeze({
        requestHash: input.requestHash,
        automationId: input.automationId
      }));
      return Object.freeze({ kind: "created", automation });
    },
    findById: async (scope, automationId): Promise<AutomationHeader | undefined> => {
      await Promise.resolve();
      beginDriverCall(scope);
      return headers.get(storageKey(scope.workspaceId, automationId));
    },
    list: async (scope, page): Promise<AutomationPage> => {
      await Promise.resolve();
      beginDriverCall(scope);
      const cursor = page.after;
      const ordered = [...headers.values()]
        .filter((item) => item.workspaceId === scope.workspaceId)
        .sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.automationId.localeCompare(left.automationId));
      const afterCursor = cursor
        ? ordered.filter((item) =>
          item.createdAt < cursor.createdAt ||
          (item.createdAt === cursor.createdAt && item.automationId < cursor.automationId))
        : ordered;
      const selected = afterCursor.slice(0, page.limit + 1);
      const hasMore = selected.length > page.limit;
      const items = Object.freeze(selected.slice(0, page.limit));
      const last = items[items.length - 1];
      const next = hasMore && last
        ? Object.freeze({ createdAt: last.createdAt, automationId: last.automationId })
        : undefined;
      return Object.freeze({ items, next });
    },
    updateDraft: async (scope, automationId, expectedRevision, draft, now): Promise<RevisionUpdateResult> => {
      await Promise.resolve();
      beginDriverCall(scope);
      const key = storageKey(scope.workspaceId, automationId);
      const current = headers.get(key);
      if (!current) return "not-found";
      if (current.rev !== expectedRevision) return "conflict";
      headers.set(key, Object.freeze({
        ...current,
        draft: freezeDeep(structuredClone(draft)),
        hasDraft: true,
        rev: current.rev + 1,
        updatedAt: now
      }));
      return "updated";
    },
    insertVersion: async (scope, version): Promise<InsertVersionResult> => {
      await Promise.resolve();
      beginDriverCall(scope);
      if (version.workspaceId !== scope.workspaceId) return Object.freeze({ kind: "conflict" });
      const key = versionKey(scope.workspaceId, version.automationId, version.version);
      const existing = versions.get(key);
      if (existing) {
        return existing.publishKey === version.publishKey && existing.contentHash === version.contentHash
          ? Object.freeze({ kind: "idempotent", version: existing })
          : Object.freeze({ kind: "conflict" });
      }
      const frozen = freezeDeep(structuredClone(version));
      versions.set(key, frozen);
      return Object.freeze({ kind: "inserted", version: frozen });
    },
    findVersionByPublishKey: async (scope, automationId, publishKey) => {
      await Promise.resolve();
      beginDriverCall(scope);
      return [...versions.values()].find((item) =>
        item.workspaceId === scope.workspaceId &&
        item.automationId === automationId &&
        item.publishKey === publishKey);
    },
    listVersions: async (scope, automationId) => {
      await Promise.resolve();
      beginDriverCall(scope);
      return Object.freeze([...versions.values()]
        .filter((item) =>
          item.workspaceId === scope.workspaceId &&
          item.automationId === automationId)
        .sort((left, right) => left.version - right.version));
    },
    compareAndSetCurrentVersion: async (scope, automationId, expectedRevision, version) => {
      await Promise.resolve();
      beginDriverCall(scope);
      const key = storageKey(scope.workspaceId, automationId);
      const current = headers.get(key);
      if (!current) return "not-found";
      if (
        current.currentVersion === version &&
        current.rev === expectedRevision + 1
      ) return "idempotent";
      if (current.rev !== expectedRevision) return "conflict";
      if (!versions.has(versionKey(scope.workspaceId, automationId, version))) return "not-found";
      headers.set(key, Object.freeze({
        ...current,
        currentVersion: version,
        rev: current.rev + 1
      }));
      return "updated";
    },
    transitionStatus: async (scope, automationId, expected, nextStatus, now): Promise<StatusTransitionResult> => {
      await Promise.resolve();
      beginDriverCall(scope);
      const key = storageKey(scope.workspaceId, automationId);
      const current = headers.get(key);
      if (!current) return "not-found";
      if (current.rev !== expected.revision || current.status !== expected.status) return "conflict";
      headers.set(key, Object.freeze({
        ...current,
        status: nextStatus,
        rev: current.rev + 1,
        updatedAt: now
      }));
      return "updated";
    }
  });

  return Object.freeze({
    repository,
    driverCallCount: () => driverCalls
  });
};