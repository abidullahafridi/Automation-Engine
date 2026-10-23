/**
 * Inbox/deduplication repository — AE-T-021.1
 *
 * The event id is globally unique. An event accepted in one workspace can therefore not
 * be replayed into another workspace, and a duplicate delivery never creates a second
 * accepted inbox record. The inbox stores identifiers only, never an event payload.
 */

import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";

export const inboxRetentionPolicy = Object.freeze({
  maximumReplayWindowDays: 30,
  retentionDays: 35,
  rationale: "A five-day recovery buffer keeps deduplication keys beyond the supported 30-day replay/redelivery window."
});

export type InboxEvent = Readonly<{
  eventId: string;
  receivedAt: string;
}>;

export type AcceptedInboxEvent = Readonly<{
  eventId: string;
  workspaceId: string;
  receivedAt: string;
  expiresAt: string;
}>;

export type InboxRecordResult =
  | Readonly<{ kind: "accepted"; event: AcceptedInboxEvent }>
  | Readonly<{ kind: "duplicate"; event: AcceptedInboxEvent }>
  | Readonly<{ kind: "rejected"; reason: "event-id-conflicts-with-workspace" | "invalid-event" }>;

type InboxRejectionReason = "event-id-conflicts-with-workspace" | "invalid-event";

export type InboxMetrics = Readonly<{
  duplicate: (workspaceId: string) => void;
  rejected: (workspaceId: string, reason: InboxRejectionReason) => void;
}>;

export type InboxRepository = Readonly<{
  record: (scope: WorkspaceScope, event: InboxEvent) => Promise<InboxRecordResult>;
  findByEventId: (scope: WorkspaceScope, eventId: string) => Promise<AcceptedInboxEvent | undefined>;
}>;

export const inboxRepositoryMethodNames = Object.freeze([
  "record",
  "findByEventId"
] as const satisfies readonly (keyof InboxRepository)[]);

export const inboxCollectionNames = Object.freeze({ records: "automation_event_inbox" });
export type InboxCollectionNames = Readonly<{ records: string }>;

type StoredInboxEvent = AcceptedInboxEvent;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

const isValidEvent = (event: InboxEvent): boolean =>
  event.eventId.trim().length > 0 && !Number.isNaN(new Date(event.receivedAt).getTime());

const expiresAt = (receivedAt: string): string =>
  new Date(new Date(receivedAt).getTime() + inboxRetentionPolicy.retentionDays * 86_400_000).toISOString();

const toAcceptedEvent = (event: StoredInboxEvent): AcceptedInboxEvent => Object.freeze({ ...event });

const createMetrics = (): InboxMetrics => Object.freeze({
  duplicate: () => undefined,
  rejected: () => undefined
});

export const ensureInboxRepositoryIndexes = async (
  database: MongoDatabase,
  names: InboxCollectionNames = inboxCollectionNames
): Promise<void> => {
  const records = database.collection<StoredInboxEvent>(names.records);
  await Promise.all([
    records.createIndex({ eventId: 1 }, { unique: true, name: "inbox_event_id_unique" }),
    records.createIndex({ workspaceId: 1, receivedAt: 1 }, { name: "inbox_workspace_received_at" }),
    records.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "inbox_retention_ttl" })
  ]);
};

export const createMongoInboxRepository = async ({
  database,
  ownsScope,
  metrics = createMetrics(),
  collectionNames = inboxCollectionNames
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  metrics?: InboxMetrics;
  collectionNames?: InboxCollectionNames;
}>): Promise<InboxRepository> => {
  await ensureInboxRepositoryIndexes(database, collectionNames);
  const records = database.collection<StoredInboxEvent>(collectionNames.records);
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    record: async (scope, event): Promise<InboxRecordResult> => {
      requireScope(scope);
      if (!isValidEvent(event)) {
        metrics.rejected(scope.workspaceId, "invalid-event");
        return Object.freeze({ kind: "rejected", reason: "invalid-event" });
      }
      const stored: StoredInboxEvent = {
        eventId: event.eventId,
        workspaceId: scope.workspaceId,
        receivedAt: event.receivedAt,
        expiresAt: expiresAt(event.receivedAt)
      };
      try {
        await records.insertOne(stored, { writeConcern: { w: "majority" } });
        return Object.freeze({ kind: "accepted", event: toAcceptedEvent(stored) });
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        const existing = await records.findOne({ eventId: event.eventId });
        if (!existing || existing.workspaceId !== scope.workspaceId) {
          metrics.rejected(scope.workspaceId, "event-id-conflicts-with-workspace");
          return Object.freeze({ kind: "rejected", reason: "event-id-conflicts-with-workspace" });
        }
        const accepted = toAcceptedEvent(existing);
        metrics.duplicate(scope.workspaceId);
        return Object.freeze({ kind: "duplicate", event: accepted });
      }
    },
    findByEventId: async (scope, eventId): Promise<AcceptedInboxEvent | undefined> => {
      requireScope(scope);
      const stored = await records.findOne({ workspaceId: scope.workspaceId, eventId });
      return stored ? toAcceptedEvent(stored) : undefined;
    }
  });
};

export const createInMemoryInboxRepository = ({
  ownsScope,
  metrics = createMetrics()
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  metrics?: InboxMetrics;
}>): InboxRepository => {
  const records = new Map<string, AcceptedInboxEvent>();
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    record: (scope, event): Promise<InboxRecordResult> => {
      requireScope(scope);
      if (!isValidEvent(event)) {
        metrics.rejected(scope.workspaceId, "invalid-event");
        return Promise.resolve(Object.freeze({ kind: "rejected", reason: "invalid-event" }));
      }
      const existing = records.get(event.eventId);
      if (existing) {
        if (existing.workspaceId !== scope.workspaceId) {
          metrics.rejected(scope.workspaceId, "event-id-conflicts-with-workspace");
          return Promise.resolve(Object.freeze({ kind: "rejected", reason: "event-id-conflicts-with-workspace" }));
        }
        metrics.duplicate(scope.workspaceId);
        return Promise.resolve(Object.freeze({ kind: "duplicate", event: existing }));
      }
      const accepted = Object.freeze({
        eventId: event.eventId,
        workspaceId: scope.workspaceId,
        receivedAt: event.receivedAt,
        expiresAt: expiresAt(event.receivedAt)
      });
      records.set(event.eventId, accepted);
      return Promise.resolve(Object.freeze({ kind: "accepted", event: accepted }));
    },
    findByEventId: (scope, eventId): Promise<AcceptedInboxEvent | undefined> => {
      requireScope(scope);
      const event = records.get(eventId);
      return Promise.resolve(event?.workspaceId === scope.workspaceId ? event : undefined);
    }
  });
};
