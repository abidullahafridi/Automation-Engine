import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type {
  AutomationCursor,
  AutomationHeader,
  AutomationPage,
  AutomationRepository,
  CreateAutomationInput,
  CreateAutomationResult,
  InsertVersionResult,
  PublishedAutomationVersion,
  RevisionUpdateResult,
  StatusTransitionResult
} from "./automation.repository.js";

type StoredAutomationHeader = AutomationHeader & Readonly<{
  idempotencyKey: string;
  requestHash: string;
}>;

export const automationCollectionNames = Object.freeze({
  headers: "automation_definitions",
  versions: "automation_versions"
});

export type AutomationCollectionNames = Readonly<{
  headers: string;
  versions: string;
}>;

export const ensureAutomationRepositoryIndexes = async (
  database: MongoDatabase,
  collectionNames: AutomationCollectionNames = automationCollectionNames
): Promise<void> => {
  const headers = database.collection<StoredAutomationHeader>(collectionNames.headers);
  const versions = database.collection<PublishedAutomationVersion>(collectionNames.versions);

  await Promise.all([
    headers.createIndex(
      { workspaceId: 1, automationId: 1 },
      { unique: true, name: "automation_workspace_id_unique" }
    ),
    headers.createIndex(
      { workspaceId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: "automation_workspace_idempotency_unique",
        partialFilterExpression: { idempotencyKey: { $type: "string" } }
      }
    ),
    headers.createIndex(
      { workspaceId: 1, createdAt: -1, automationId: -1 },
      { name: "automation_workspace_created_cursor" }
    ),
    versions.createIndex(
      { workspaceId: 1, automationId: 1, version: 1 },
      { unique: true, name: "automation_version_workspace_unique" }
    ),
    versions.createIndex(
      { workspaceId: 1, automationId: 1, publishKey: 1 },
      { unique: true, name: "automation_publish_key_workspace_unique" }
    )
  ]);
};

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === 11000;

const freezeDeep = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

const asAutomationHeader = (record: StoredAutomationHeader | null): AutomationHeader | undefined => {
  if (!record) return undefined;
  return Object.freeze({
    automationId: record.automationId,
    workspaceId: record.workspaceId,
    name: record.name,
    createdBy: record.createdBy,
    rev: record.rev,
    status: record.status,
    draft: freezeDeep(record.draft),
    hasDraft: record.hasDraft,
    currentVersion: record.currentVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
};

export const createMongoAutomationRepository = async ({
  database,
  ownsScope,
  collectionNames = automationCollectionNames
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: AutomationCollectionNames;
}>): Promise<AutomationRepository> => {
  await ensureAutomationRepositoryIndexes(database, collectionNames);
  const headers = database.collection<StoredAutomationHeader>(collectionNames.headers);
  const versions = database.collection<PublishedAutomationVersion>(collectionNames.versions);

  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const findHeader = async (
    scope: WorkspaceScope,
    automationId: string
  ): Promise<StoredAutomationHeader | null> => headers.findOne({
    workspaceId: scope.workspaceId,
    automationId
  });

  const repository: AutomationRepository = Object.freeze({
    createDraft: async (scope, input: CreateAutomationInput): Promise<CreateAutomationResult> => {
      requireScope(scope);
      const record: StoredAutomationHeader = {
        automationId: input.automationId,
        workspaceId: scope.workspaceId,
        name: input.name,
        createdBy: input.createdBy,
        rev: 0,
        status: "draft",
        draft: structuredClone(input.draft),
        hasDraft: true,
        currentVersion: null,
        createdAt: input.now,
        updatedAt: input.now,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash
      };

      try {
        await headers.insertOne(record);
        const automation = asAutomationHeader(record);
        if (!automation) throw new Error("Inserted automation could not be mapped.");
        return Object.freeze({ kind: "created", automation });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const previous = await headers.findOne({
          workspaceId: scope.workspaceId,
          idempotencyKey: input.idempotencyKey
        });
        if (!previous) return Object.freeze({ kind: "idempotency-conflict" });
        if (previous.requestHash !== input.requestHash) {
          return Object.freeze({ kind: "idempotency-conflict" });
        }
        const automation = asAutomationHeader(previous);
        if (!automation) throw new Error("Idempotency record references a missing automation.");
        return Object.freeze({ kind: "idempotent", automation });
      }
    },

    findById: async (scope, automationId): Promise<AutomationHeader | undefined> => {
      requireScope(scope);
      return asAutomationHeader(await findHeader(scope, automationId));
    },

    list: async (scope, page: Readonly<{ after: AutomationCursor | undefined; limit: number }>): Promise<AutomationPage> => {
      requireScope(scope);
      const cursorFilter = page.after
        ? {
          $or: [
            { createdAt: { $lt: page.after.createdAt } },
            { createdAt: page.after.createdAt, automationId: { $lt: page.after.automationId } }
          ]
        }
        : {};
      const selected = await headers.find({
        workspaceId: scope.workspaceId,
        ...cursorFilter
      }).sort({ createdAt: -1, automationId: -1 }).limit(page.limit + 1).toArray();
      const hasMore = selected.length > page.limit;
      const records = selected.slice(0, page.limit);
      const items = Object.freeze(records.map((record) => {
        const header = asAutomationHeader(record);
        if (!header) throw new Error("Automation query returned an invalid record.");
        return header;
      }));
      const last = items[items.length - 1];
      const next = hasMore && last
        ? Object.freeze({ createdAt: last.createdAt, automationId: last.automationId })
        : undefined;
      return Object.freeze({ items, next });
    },

    updateDraft: async (
      scope,
      automationId,
      expectedRevision,
      draft,
      now
    ): Promise<RevisionUpdateResult> => {
      requireScope(scope);
      const result = await headers.updateOne(
        { workspaceId: scope.workspaceId, automationId, rev: expectedRevision },
        {
          $set: { draft: structuredClone(draft), hasDraft: true, updatedAt: now },
          $inc: { rev: 1 }
        }
      );
      if (result.matchedCount === 1) return "updated";
      return await findHeader(scope, automationId) ? "conflict" : "not-found";
    },

    insertVersion: async (
      scope,
      version: PublishedAutomationVersion
    ): Promise<InsertVersionResult> => {
      requireScope(scope);
      if (version.workspaceId !== scope.workspaceId) return Object.freeze({ kind: "conflict" });
      const record = structuredClone(version);
      try {
        await versions.insertOne(record);
        return Object.freeze({ kind: "inserted", version: freezeDeep(record) });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await versions.findOne({
          workspaceId: scope.workspaceId,
          automationId: version.automationId,
          $or: [
            { version: version.version },
            { publishKey: version.publishKey }
          ]
        });
        return existing &&
          existing.publishKey === version.publishKey &&
          existing.contentHash === version.contentHash
          ? Object.freeze({ kind: "idempotent", version: freezeDeep(existing) })
          : Object.freeze({ kind: "conflict" });
      }
    },

    findVersionByPublishKey: async (
      scope,
      automationId,
      publishKey
    ): Promise<PublishedAutomationVersion | undefined> => {
      requireScope(scope);
      const version = await versions.findOne({
        workspaceId: scope.workspaceId,
        automationId,
        publishKey
      });
      return version ? freezeDeep(version) : undefined;
    },

    listVersions: async (scope, automationId): Promise<readonly PublishedAutomationVersion[]> => {
      requireScope(scope);
      const stored = await versions.find({
        workspaceId: scope.workspaceId,
        automationId
      }).sort({ version: 1 }).toArray();
      return Object.freeze(stored.map(freezeDeep));
    },

    compareAndSetCurrentVersion: async (
      scope,
      automationId,
      expectedRevision,
      version
    ): Promise<RevisionUpdateResult> => {
      requireScope(scope);
      const published = await versions.findOne({
        workspaceId: scope.workspaceId,
        automationId,
        version
      });
      if (!published) return "not-found";

      const current = await headers.findOne({ workspaceId: scope.workspaceId, automationId });
      if (!current) return "not-found";
      if (current.currentVersion === version && current.rev === expectedRevision + 1) {
        return "idempotent";
      }

      const result = await headers.updateOne(
        { workspaceId: scope.workspaceId, automationId, rev: expectedRevision },
        { $set: { currentVersion: version }, $inc: { rev: 1 } }
      );
      if (result.matchedCount === 1) return "updated";
      return await findHeader(scope, automationId) ? "conflict" : "not-found";
    },

    transitionStatus: async (
      scope,
      automationId,
      expected,
      nextStatus,
      now
    ): Promise<StatusTransitionResult> => {
      requireScope(scope);
      const result = await headers.updateOne(
        {
          workspaceId: scope.workspaceId,
          automationId,
          rev: expected.revision,
          status: expected.status
        },
        { $set: { status: nextStatus, updatedAt: now }, $inc: { rev: 1 } }
      );
      if (result.matchedCount === 1) return "updated";
      return await findHeader(scope, automationId) ? "conflict" : "not-found";
    }
  });

  return repository;
};