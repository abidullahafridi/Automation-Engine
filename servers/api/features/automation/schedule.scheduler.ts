import type { WorkspaceScope } from "./automation.ports.js";
import type { Clock } from "./automation.service.js";
import {
  computeNextOccurrence,
  occurrenceKey,
  validateSchedule,
  type OccurrenceSkipReason,
  type ScheduleDefinition,
  type ScheduleIssue,
  type ScheduleOccurrence
} from "./schedule.occurrence.js";
import type { ScheduleCursor, ScheduleRepository } from "./schedule.repository.js";

/** Spec D-22 default catch-up window: 1 hour. */
export const defaultCatchUpWindowMs = 3_600_000;
/** Bound on occurrences examined per cursor per tick, so a long outage never runs unbounded. */
export const defaultMaxOccurrencesPerTick = 100;

/** Low-cardinality signals only. Failures are swallowed: telemetry never changes behavior. */
export type ScheduleTelemetry = Readonly<{
  occurrence: (result: "created" | "duplicate") => void;
  /** now - scheduledFor, clamped at 0, for newly created occurrences only. */
  lateness: (latenessMs: number) => void;
  /** Number of newly recorded MISSED_SKIPPED occurrences in one cursor pass. */
  missed?: (count: number) => void;
}>;

export type TickSummary = Readonly<{
  claimed: number;
  created: number;
  duplicates: number;
  /** Cursor CAS lost to another scheduler instance (the occurrence is still exactly one). */
  stale: number;
  /** Cursor could not compute a next occurrence; left untouched for operator attention. */
  failed: number;
  /** Newly recorded MISSED_SKIPPED occurrences. Present only when greater than zero. */
  missed?: number;
}>;

export type RegisterScheduleRequest = Readonly<{
  automationId: string;
  timezone: string;
  definition: ScheduleDefinition;
  enabled?: boolean;
}>;

export type RegisterScheduleResult =
  | Readonly<{ kind: "registered"; cursor: ScheduleCursor }>
  | Readonly<{ kind: "exists"; cursor: ScheduleCursor }>
  | Readonly<{ kind: "invalid"; issues: readonly ScheduleIssue[] }>;

export type ScheduleService = Readonly<{
  register: (scope: WorkspaceScope, request: RegisterScheduleRequest) => Promise<RegisterScheduleResult>;
  find: (scope: WorkspaceScope, automationId: string) => Promise<ScheduleCursor | undefined>;
  listOccurrences: (scope: WorkspaceScope, automationId: string) => Promise<readonly ScheduleOccurrence[]>;
  update: (
    scope: WorkspaceScope,
    request: RegisterScheduleRequest & Readonly<{ expectedRev: number }>
  ) => Promise<"updated" | "conflict" | "not-found" | "invalid">;
  setEnabled: (
    scope: WorkspaceScope,
    automationId: string,
    enabled: boolean,
    expectedRev?: number
  ) => Promise<"updated" | "conflict" | "not-found" | "invalid">;
  tick: (scope: WorkspaceScope, options?: Readonly<{ limit?: number }>) => Promise<TickSummary>;
}>;

export const defaultTickLimit = 50;

export type CatchUpPlan = Readonly<{
  /** Due occurrences that are recorded as MISSED_SKIPPED. */
  missed: readonly string[];
  /** The single occurrence that should produce a run (coalesced), if any. */
  run: string | undefined;
  /** The cursor's next occurrence after this pass. */
  next: string;
}>;

/**
 * Pure missed-run policy (spec D-22).
 * Walks the due occurrences from `firstDueAt` up to `nowMs`. If the whole backlog fits inside
 * the per-tick cap, only the latest due occurrence may run (when inside the catch-up window);
 * every earlier one is skipped. If the cap is hit, everything collected is skipped and the cursor
 * moves on; the next tick continues. Returns undefined when no next occurrence can be computed.
 */
export const planCatchUp = (
  timezone: string,
  definition: ScheduleDefinition,
  firstDueAt: string,
  nowMs: number,
  catchUpWindowMs: number,
  maxOccurrences: number
): CatchUpPlan | undefined => {
  const due: string[] = [firstDueAt];
  let last = firstDueAt;
  let next: string | undefined;
  let capped = false;

  for (let step = 0; step <= maxOccurrences; step += 1) {
    const candidate = computeNextOccurrence(timezone, definition, last);
    if (candidate === undefined) return undefined;
    if (Date.parse(candidate) > nowMs) {
      next = candidate;
      break;
    }
    if (due.length >= maxOccurrences) {
      next = candidate;
      capped = true;
      break;
    }
    due.push(candidate);
    last = candidate;
  }
  if (next === undefined) return undefined;

  const latest = due[due.length - 1];
  if (!capped && latest !== undefined && nowMs - Date.parse(latest) <= catchUpWindowMs) {
    return Object.freeze({ missed: Object.freeze(due.slice(0, -1)), run: latest, next });
  }
  return Object.freeze({ missed: Object.freeze([...due]), run: undefined, next });
};

const emit = (action: () => void): void => {
  try {
    action();
  } catch {
    // A failing sink must never affect scheduling.
  }
};

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const buildOccurrence = (
  scope: WorkspaceScope,
  cursor: ScheduleCursor,
  scheduledFor: string,
  createdAt: string,
  skipReason?: OccurrenceSkipReason
): ScheduleOccurrence => Object.freeze({
  occurrenceId: occurrenceKey(scope.workspaceId, cursor.automationId, scheduledFor),
  workspaceId: scope.workspaceId,
  automationId: cursor.automationId,
  scheduledFor,
  timezone: cursor.timezone,
  createdAt,
  ...(skipReason === undefined ? {} : { skipReason })
});

export const createScheduleService = ({
  repository,
  ownsScope,
  clock,
  telemetry,
  catchUpWindowMs = defaultCatchUpWindowMs,
  maxOccurrencesPerTick = defaultMaxOccurrencesPerTick
}: Readonly<{
  repository: ScheduleRepository;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  clock: Clock;
  telemetry?: ScheduleTelemetry;
  catchUpWindowMs?: number;
  maxOccurrencesPerTick?: number;
}>): ScheduleService => {
  if (!isPositiveInteger(catchUpWindowMs) || !isPositiveInteger(maxOccurrencesPerTick)) {
    throw new Error("Catch-up window and per-tick occurrence cap must be positive integers.");
  }
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    register: async (scope, request) => {
      requireScope(scope);
      const issues = validateSchedule(request.timezone, request.definition);
      if (issues.length > 0) return Object.freeze({ kind: "invalid" as const, issues });
      const now = clock.now();
      const next = computeNextOccurrence(request.timezone, request.definition, now);
      if (next === undefined) {
        return Object.freeze({
          kind: "invalid" as const,
          issues: Object.freeze([Object.freeze({
            code: "INVALID_DEFINITION" as const,
            message: "Schedule has no computable next occurrence."
          })])
        });
      }
      const created = await repository.register(scope, {
        automationId: request.automationId,
        timezone: request.timezone,
        definition: request.definition,
        enabled: request.enabled ?? true,
        nextOccurrenceAt: next,
        now
      });
      const cursor = await repository.findCursor(scope, request.automationId);
      if (!cursor) throw new Error("Registered schedule cursor could not be read back.");
      return Object.freeze({ kind: created === "created" ? "registered" as const : "exists" as const, cursor });
    },

    find: async (scope, automationId) => {
      requireScope(scope);
      return repository.findCursor(scope, automationId);
    },

    listOccurrences: async (scope, automationId) => {
      requireScope(scope);
      return repository.listOccurrences(scope, automationId);
    },

    update: async (scope, request) => {
      requireScope(scope);
      const issues = validateSchedule(request.timezone, request.definition);
      if (issues.length > 0) return "invalid" as const;
      const cursor = await repository.findCursor(scope, request.automationId);
      if (!cursor) return "not-found" as const;
      if (cursor.rev !== request.expectedRev) return "conflict" as const;
      const now = clock.now();
      const next = computeNextOccurrence(request.timezone, request.definition, now);
      if (next === undefined) return "invalid" as const;
      return repository.update(scope, {
        automationId: request.automationId,
        expectedRev: request.expectedRev,
        timezone: request.timezone,
        definition: request.definition,
        nextOccurrenceAt: next,
        now
      });
    },

    setEnabled: async (scope, automationId, enabled, expectedRev) => {
      requireScope(scope);
      const now = clock.now();
      if (!enabled) return repository.setEnabled(scope, automationId, false, now, undefined, expectedRev);
      const cursor = await repository.findCursor(scope, automationId);
      if (!cursor) return "not-found" as const;
      if (expectedRev !== undefined && cursor.rev !== expectedRev) return "conflict" as const;
      // Re-enable resumes from the next future occurrence: no catch-up burst for the disabled period.
      const next = computeNextOccurrence(cursor.timezone, cursor.definition, now);
      if (next === undefined) return "invalid" as const;
      return repository.setEnabled(scope, automationId, true, now, next, expectedRev);
    },

    tick: async (scope, options) => {
      requireScope(scope);
      const now = clock.now();
      const nowMs = Date.parse(now);
      const due = await repository.findDue(scope, now, options?.limit ?? defaultTickLimit);
      let created = 0;
      let duplicates = 0;
      let stale = 0;
      let failed = 0;
      let missed = 0;

      for (const cursor of due) {
        const plan = planCatchUp(
          cursor.timezone,
          cursor.definition,
          cursor.nextOccurrenceAt,
          nowMs,
          catchUpWindowMs,
          maxOccurrencesPerTick
        );
        if (plan === undefined) {
          failed += 1;
          continue;
        }

        // 1. Durable, idempotent records first. A crash after this point is recovered on restart.
        let missedHere = 0;
        for (const instant of plan.missed) {
          const skipped = await repository.insertOccurrence(
            scope,
            buildOccurrence(scope, cursor, instant, now, "MISSED_SKIPPED")
          );
          if (skipped === "created") missedHere += 1;
        }
        if (missedHere > 0) {
          missed += missedHere;
          const count = missedHere;
          emit(() => { telemetry?.missed?.(count); });
        }

        if (plan.run !== undefined) {
          const inserted = await repository.insertOccurrence(
            scope,
            buildOccurrence(scope, cursor, plan.run, now)
          );
          if (inserted === "created") {
            created += 1;
            const lateness = Math.max(0, nowMs - Date.parse(plan.run));
            emit(() => { telemetry?.occurrence("created"); });
            emit(() => { telemetry?.lateness(lateness); });
          } else {
            duplicates += 1;
            emit(() => { telemetry?.occurrence("duplicate"); });
          }
        }

        // 2. Atomically advance the cursor. Zero matches means another instance already did.
        const advanced = await repository.advanceCursor(scope, {
          automationId: cursor.automationId,
          expectedRev: cursor.rev,
          expectedNextOccurrenceAt: cursor.nextOccurrenceAt,
          nextOccurrenceAt: plan.next,
          now
        });
        if (advanced === "stale") stale += 1;
      }

      return Object.freeze({
        claimed: due.length,
        created,
        duplicates,
        stale,
        failed,
        ...(missed > 0 ? { missed } : {})
      });
    }
  });
};
