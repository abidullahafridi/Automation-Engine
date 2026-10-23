import type { MongoDatabase } from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type { ScheduleDefinition, ScheduleOccurrence } from "./schedule.occurrence.js";

export type ScheduleCursor = Readonly<{
  workspaceId: string;
  automationId: string;
  timezone: string;
  definition: ScheduleDefinition;
  enabled: boolean;
  /** Next UTC instant that still has to produce an occurrence. The durable cursor. */
  nextOccurrenceAt: string;
  rev: number;
  createdAt: string;
  updatedAt: string;
}>;

export type RegisterScheduleInput = Readonly<{
  automationId: string;
  timezone: string;
  definition: ScheduleDefinition;
  enabled: boolean;
  nextOccurrenceAt: string;
  now: string;
}>;

export type AdvanceCursorInput = Readonly<{
  automationId: string;
  expectedRev: number;
  expectedNextOccurrenceAt: string;
  nextOccurrenceAt: string;
  now: string;
}>;

export type UpdateScheduleInput = Readonly<{
  automationId: string;
  expectedRev: number;
  timezone: string;
  definition: ScheduleDefinition;
  nextOccurrenceAt: string;
  now: string;
}>;

export type ScheduleRepository = Readonly<{
  register: (scope: WorkspaceScope, input: RegisterScheduleInput) => Promise<"created" | "exists">;
  findCursor: (scope: WorkspaceScope, automationId: string) => Promise<ScheduleCursor | undefined>;
  update: (scope: WorkspaceScope, input: UpdateScheduleInput) => Promise<"updated" | "conflict" | "not-found">;
  /** When enabling, nextOccurrenceAt resets the cursor (no catch-up burst). Ignored when disabling. */
  setEnabled: (
    scope: WorkspaceScope,
    automationId: string,
    enabled: boolean,
    now: string,
    nextOccurrenceAt: string | undefined,
    expectedRev?: number
  ) => Promise<"updated" | "conflict" | "not-found">;
  /** Enabled cursors whose nextOccurrenceAt <= now, oldest first. Disabled schedules are never returned. */
  findDue: (scope: WorkspaceScope, now: string, limit: number) => Promise<readonly ScheduleCursor[]>;
  insertOccurrence: (scope: WorkspaceScope, occurrence: ScheduleOccurrence) => Promise<"created" | "idempotent">;
  /** Compare-and-set. Zero matches is "stale", never success. */
  advanceCursor: (scope: WorkspaceScope, input: AdvanceCursorInput) => Promise<"advanced" | "stale">;
  listOccurrences: (scope: WorkspaceScope, automationId: string) => Promise<readonly ScheduleOccurrence[]>;
}>;

export const scheduleRepositoryMethodNames = Object.freeze([
  "register",
  "findCursor",
  "update",
  "setEnabled",
  "findDue",
  "insertOccurrence",
  "advanceCursor",
  "listOccurrences"
] as const satisfies readonly (keyof ScheduleRepository)[]);

export type ScheduleCollectionNames = Readonly<{ cursors: string; occurrences: string }>;
export const scheduleCollectionNames: ScheduleCollectionNames = Object.freeze({
  cursors: "automation_schedule_cursors",
  occurrences: "automation_schedule_occurrences"
});

export const maxDuePage = 100;

const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === 11000;

const asCursor = (stored: ScheduleCursor): ScheduleCursor => Object.freeze({
  workspaceId: stored.workspaceId,
  automationId: stored.automationId,
  timezone: stored.timezone,
  definition: Object.freeze({ ...stored.definition }),
  enabled: stored.enabled,
  nextOccurrenceAt: stored.nextOccurrenceAt,
  rev: stored.rev,
  createdAt: stored.createdAt,
  updatedAt: stored.updatedAt
});

const asOccurrence = (stored: ScheduleOccurrence): ScheduleOccurrence => Object.freeze({
  occurrenceId: stored.occurrenceId,
  workspaceId: stored.workspaceId,
  automationId: stored.automationId,
  scheduledFor: stored.scheduledFor,
  timezone: stored.timezone,
  createdAt: stored.createdAt,
  ...(stored.skipReason === undefined ? {} : { skipReason: stored.skipReason })
});

const clampLimit = (limit: number): number =>
  Math.max(1, Math.min(Math.trunc(limit), maxDuePage));

export const ensureScheduleRepositoryIndexes = async (
  database: MongoDatabase,
  names: ScheduleCollectionNames = scheduleCollectionNames
): Promise<void> => {
  await Promise.all([
    database.collection(names.cursors).createIndex(
      { workspaceId: 1, automationId: 1 },
      { unique: true, name: "schedule_cursor_unique" }
    ),
    database.collection(names.cursors).createIndex(
      { workspaceId: 1, enabled: 1, nextOccurrenceAt: 1 },
      { name: "schedule_cursor_due" }
    ),
    database.collection(names.occurrences).createIndex(
      { workspaceId: 1, automationId: 1, scheduledFor: 1 },
      { unique: true, name: "schedule_occurrence_unique" }
    ),
    database.collection(names.occurrences).createIndex(
      { workspaceId: 1, occurrenceId: 1 },
      { unique: true, name: "schedule_occurrence_id_unique" }
    )
  ]);
};

export const createMongoScheduleRepository = async ({
  database,
  ownsScope,
  collectionNames = scheduleCollectionNames
}: Readonly<{
  database: MongoDatabase;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  collectionNames?: ScheduleCollectionNames;
}>): Promise<ScheduleRepository> => {
  await ensureScheduleRepositoryIndexes(database, collectionNames);
  const cursors = database.collection<ScheduleCursor>(collectionNames.cursors);
  const occurrences = database.collection<ScheduleOccurrence>(collectionNames.occurrences);
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    register: async (scope, input) => {
      requireScope(scope);
      const record: ScheduleCursor = {
        workspaceId: scope.workspaceId,
        automationId: input.automationId,
        timezone: input.timezone,
        definition: structuredClone(input.definition),
        enabled: input.enabled,
        nextOccurrenceAt: input.nextOccurrenceAt,
        rev: 0,
        createdAt: input.now,
        updatedAt: input.now
      };
      try {
        await cursors.insertOne(record);
        return "created" as const;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        return "exists" as const;
      }
    },

    findCursor: async (scope, automationId) => {
      requireScope(scope);
      const found = await cursors.findOne({ workspaceId: scope.workspaceId, automationId });
      return found ? asCursor(found) : undefined;
    },

    update: async (scope, input) => {
      requireScope(scope);
      const result = await cursors.updateOne(
        { workspaceId: scope.workspaceId, automationId: input.automationId, rev: input.expectedRev },
        { $set: {
          timezone: input.timezone,
          definition: structuredClone(input.definition),
          nextOccurrenceAt: input.nextOccurrenceAt,
          updatedAt: input.now
        }, $inc: { rev: 1 } }
      );
      if (result.matchedCount === 1) return "updated" as const;
      return await cursors.findOne({ workspaceId: scope.workspaceId, automationId: input.automationId })
        ? "conflict" as const
        : "not-found" as const;
    },

    setEnabled: async (scope, automationId, enabled, now, nextOccurrenceAt, expectedRev) => {
      requireScope(scope);
      const changes = enabled && nextOccurrenceAt !== undefined
        ? { enabled, updatedAt: now, nextOccurrenceAt }
        : { enabled, updatedAt: now };
      const result = await cursors.updateOne(
        { workspaceId: scope.workspaceId, automationId, ...(expectedRev === undefined ? {} : { rev: expectedRev }) },
        { $set: changes, $inc: { rev: 1 } }
      );
      if (result.matchedCount === 1) return "updated" as const;
      if (expectedRev !== undefined && await cursors.findOne({ workspaceId: scope.workspaceId, automationId })) {
        return "conflict" as const;
      }
      return "not-found" as const;
    },

    findDue: async (scope, now, limit) => {
      requireScope(scope);
      const found = await cursors
        .find({ workspaceId: scope.workspaceId, enabled: true, nextOccurrenceAt: { $lte: now } })
        .sort({ nextOccurrenceAt: 1, automationId: 1 })
        .limit(clampLimit(limit))
        .toArray();
      return Object.freeze(found.map((item) => asCursor(item)));
    },

    insertOccurrence: async (scope, occurrence) => {
      requireScope(scope);
      if (occurrence.workspaceId !== scope.workspaceId) {
        throw new Error("Occurrence workspace must match the trusted scope.");
      }
      try {
        await occurrences.insertOne(structuredClone(occurrence));
        return "created" as const;
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
        return "idempotent" as const;
      }
    },

    advanceCursor: async (scope, input) => {
      requireScope(scope);
      const result = await cursors.updateOne(
        {
          workspaceId: scope.workspaceId,
          automationId: input.automationId,
          enabled: true,
          rev: input.expectedRev,
          nextOccurrenceAt: input.expectedNextOccurrenceAt
        },
        { $set: { nextOccurrenceAt: input.nextOccurrenceAt, updatedAt: input.now }, $inc: { rev: 1 } }
      );
      return result.matchedCount === 1 ? "advanced" as const : "stale" as const;
    },

    listOccurrences: async (scope, automationId) => {
      requireScope(scope);
      const found = await occurrences
        .find({ workspaceId: scope.workspaceId, automationId })
        .sort({ scheduledFor: 1 })
        .toArray();
      return Object.freeze(found.map((item) => asOccurrence(item)));
    }
  });
};

export const createInMemoryScheduleRepository = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): ScheduleRepository => {
  const cursors = new Map<string, ScheduleCursor>();
  const occurrences = new Map<string, ScheduleOccurrence>();
  const cursorKey = (workspaceId: string, automationId: string): string =>
    `${workspaceId}\u0000${automationId}`;
  const occurrenceKeyOf = (workspaceId: string, automationId: string, scheduledFor: string): string =>
    `${workspaceId}\u0000${automationId}\u0000${scheduledFor}`;
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    register: async (scope, input) => {
      await Promise.resolve();
      requireScope(scope);
      const key = cursorKey(scope.workspaceId, input.automationId);
      if (cursors.has(key)) return "exists" as const;
      cursors.set(key, asCursor({
        workspaceId: scope.workspaceId,
        automationId: input.automationId,
        timezone: input.timezone,
        definition: input.definition,
        enabled: input.enabled,
        nextOccurrenceAt: input.nextOccurrenceAt,
        rev: 0,
        createdAt: input.now,
        updatedAt: input.now
      }));
      return "created" as const;
    },

    findCursor: async (scope, automationId) => {
      await Promise.resolve();
      requireScope(scope);
      return cursors.get(cursorKey(scope.workspaceId, automationId));
    },

    update: async (scope, input) => {
      await Promise.resolve();
      requireScope(scope);
      const key = cursorKey(scope.workspaceId, input.automationId);
      const current = cursors.get(key);
      if (!current) return "not-found" as const;
      if (current.rev !== input.expectedRev) return "conflict" as const;
      cursors.set(key, asCursor({
        ...current,
        timezone: input.timezone,
        definition: input.definition,
        nextOccurrenceAt: input.nextOccurrenceAt,
        updatedAt: input.now,
        rev: current.rev + 1
      }));
      return "updated" as const;
    },

    setEnabled: async (scope, automationId, enabled, now, nextOccurrenceAt, expectedRev) => {
      await Promise.resolve();
      requireScope(scope);
      const key = cursorKey(scope.workspaceId, automationId);
      const current = cursors.get(key);
      if (!current) return "not-found" as const;
      if (expectedRev !== undefined && current.rev !== expectedRev) return "conflict" as const;
      cursors.set(key, asCursor({
        ...current,
        enabled,
        nextOccurrenceAt: enabled && nextOccurrenceAt !== undefined ? nextOccurrenceAt : current.nextOccurrenceAt,
        updatedAt: now,
        rev: current.rev + 1
      }));
      return "updated" as const;
    },

    findDue: async (scope, now, limit) => {
      await Promise.resolve();
      requireScope(scope);
      const due = [...cursors.values()]
        .filter((item) =>
          item.workspaceId === scope.workspaceId && item.enabled && item.nextOccurrenceAt <= now)
        .sort((left, right) =>
          left.nextOccurrenceAt.localeCompare(right.nextOccurrenceAt) ||
          left.automationId.localeCompare(right.automationId))
        .slice(0, clampLimit(limit));
      return Object.freeze(due);
    },

    insertOccurrence: async (scope, occurrence) => {
      await Promise.resolve();
      requireScope(scope);
      if (occurrence.workspaceId !== scope.workspaceId) {
        throw new Error("Occurrence workspace must match the trusted scope.");
      }
      const key = occurrenceKeyOf(scope.workspaceId, occurrence.automationId, occurrence.scheduledFor);
      if (occurrences.has(key)) return "idempotent" as const;
      occurrences.set(key, asOccurrence(occurrence));
      return "created" as const;
    },

    advanceCursor: async (scope, input) => {
      await Promise.resolve();
      requireScope(scope);
      const key = cursorKey(scope.workspaceId, input.automationId);
      const current = cursors.get(key);
      if (
        !current ||
        !current.enabled ||
        current.rev !== input.expectedRev ||
        current.nextOccurrenceAt !== input.expectedNextOccurrenceAt
      ) {
        return "stale" as const;
      }
      cursors.set(key, asCursor({
        ...current,
        nextOccurrenceAt: input.nextOccurrenceAt,
        updatedAt: input.now,
        rev: current.rev + 1
      }));
      return "advanced" as const;
    },

    listOccurrences: async (scope, automationId) => {
      await Promise.resolve();
      requireScope(scope);
      return Object.freeze([...occurrences.values()]
        .filter((item) => item.workspaceId === scope.workspaceId && item.automationId === automationId)
        .sort((left, right) => left.scheduledFor.localeCompare(right.scheduledFor)));
    }
  });
};
