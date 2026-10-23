/**
 * Dead-letter recording, inspection and audited retry (AE-T-032.2).
 *
 * Authorization failures always look like "not found" so a run's existence never leaks.
 * Every recovery attempt (succeeded, denied or blocked) is audited. Replay as a NEW run is not
 * part of this task (it needs the run unique index changed; see AE-T-052.2).
 */
import type { ActionFailure } from "./action.executor.js";
import type { ActionMetricsPort } from "./action.outcome.js";
import type { PolicyPort, Principal, WorkspaceScope } from "./automation.ports.js";
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import type { Clock, Rng } from "./automation.service.js";
import { automationLimits, isIsoInstant } from "./condition.validation.js";
import { decideDeadLetterRecovery, type RecoveryBlockCode } from "./dead-letter.policy.js";
import type { RetryDecision } from "./retry.policy.js";
import type {
  ActionAttempt,
  ActionStatus,
  DeadLetterBacklog,
  DeadLetterCursor,
  DeadLetterInfo,
  RunRepository,
  RunStatus,
  StoredRun
} from "./run.repository.js";

/** [VERIFY] These names must exist in the platform policy engine. replay is spec D-15. */
export const deadLetterPermissions = Object.freeze({
  read: "automation.run.read",
  replay: "automation.run.replay"
});

// ---- Recovery audit ----

export type RecoveryAuditActor = Readonly<{ type: "user" | "system"; id: string }>;
export type RecoveryAuditOutcome = "succeeded" | "denied" | "blocked";
export type RecoveryBlockedCode = RecoveryBlockCode | "NOT_DEAD_LETTER" | "NOT_REPLAYABLE";

export type RecoveryAuditEvent = Readonly<{
  workspaceId: string;
  actor: RecoveryAuditActor;
  action: "retry"| "replay";
  target: Readonly<{ type: "run"; id: string }>;
  automationId: string;
  occurredAt: string;
  outcome: RecoveryAuditOutcome;
  correlationId: string;
  /** Operator-supplied justification: bounded, control characters stripped. Never put secrets in it. */
  reason: string;
  confirmedActionIndexes: readonly number[];
  blockedCode?: RecoveryBlockedCode;
  change: Readonly<{ status: Readonly<{ from: RunStatus; to: RunStatus }> }>;
}>;

export type RecoveryAuditPort = Readonly<{
  append: (scope: WorkspaceScope, event: RecoveryAuditEvent) => Promise<void>;
}>;

export type InMemoryRecoveryAuditStore = Readonly<{
  auditPort: RecoveryAuditPort;
  read: (scope: WorkspaceScope, runId: string) => Promise<readonly RecoveryAuditEvent[]>;
}>;

const auditActorTypes: readonly string[] = Object.freeze(["user", "system"]);
const auditActions: readonly string[] = Object.freeze(["retry","replay"]);
const auditOutcomes: readonly string[] = Object.freeze(["succeeded", "denied", "blocked"]);

const safeRecoveryAuditEvent = (scope: WorkspaceScope, event: RecoveryAuditEvent): RecoveryAuditEvent => {
  if (
    event.workspaceId !== scope.workspaceId ||
    !auditActorTypes.includes(event.actor.type) ||
    event.actor.id.length === 0 ||
    event.target.id.length === 0 ||
    event.automationId.length === 0 ||
    event.correlationId.length === 0 ||
    event.reason.length === 0 ||
    !isIsoInstant(event.occurredAt) ||
    !auditActions.includes(event.action) ||
    !auditOutcomes.includes(event.outcome)
  ) {
    throw new Error("Invalid recovery audit event.");
  }
  // Rebuilt from an allowlist so caller-supplied extras (tokens, payloads) never reach storage.
  return Object.freeze({
    workspaceId: scope.workspaceId,
    actor: Object.freeze({ type: event.actor.type, id: event.actor.id }),
    action: event.action,
    target: Object.freeze({ type: "run" as const, id: event.target.id }),
    automationId: event.automationId,
    occurredAt: event.occurredAt,
    outcome: event.outcome,
    correlationId: event.correlationId,
    reason: event.reason,
    confirmedActionIndexes: Object.freeze([...event.confirmedActionIndexes]),
    ...(event.blockedCode === undefined ? {} : { blockedCode: event.blockedCode }),
    change: Object.freeze({
      status: Object.freeze({ from: event.change.status.from, to: event.change.status.to })
    })
  });
};

/** Test/flag-off double. Durable append-only audit storage is ADR-0010 persistence work. */
export const createInMemoryRecoveryAuditStore = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryRecoveryAuditStore => {
  const events: RecoveryAuditEvent[] = [];
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };
  const auditPort: RecoveryAuditPort = Object.freeze({
    append: async (scope, event): Promise<void> => {
      await Promise.resolve();
      requireScope(scope);
      events.push(safeRecoveryAuditEvent(scope, event));
    }
  });
  return Object.freeze({
    auditPort,
    read: async (scope, runId): Promise<readonly RecoveryAuditEvent[]> => {
      await Promise.resolve();
      requireScope(scope);
      return Object.freeze(events.filter((event) =>
        event.workspaceId === scope.workspaceId && event.target.id === runId));
    }
  });
};

// ---- Views (internal fields such as lease owner and fencing token are never exposed) ----

export type DeadLetterView = Readonly<{
  runId: string;
  automationId: string;
  version: number;
  revision: number;
  deadLetter?: DeadLetterInfo;
}>;

export type ActionAttemptSummary = Readonly<{
  actionIndex: number;
  attempt: number;
  status: ActionStatus;
  actionType?: string;
}>;

export type DeadLetterRunDetail = DeadLetterView & Readonly<{ actions: readonly ActionAttemptSummary[] }>;

const toView = (run: StoredRun): DeadLetterView => Object.freeze({
  runId: run.runId,
  automationId: run.automationId,
  version: run.version,
  revision: run.revision,
  ...(run.deadLetter === undefined ? {} : { deadLetter: run.deadLetter })
});

const toSummary = (attempt: ActionAttempt): ActionAttemptSummary => Object.freeze({
  actionIndex: attempt.actionIndex,
  attempt: attempt.attempt,
  status: attempt.status,
  ...(attempt.actionType === undefined ? {} : { actionType: attempt.actionType })
});

// ---- Results ----

export type RecoveryInvalidCode =
  | "RECOVERY_INVALID_PRINCIPAL"
  | "RECOVERY_REASON_REQUIRED"
  | "RECOVERY_INVALID_REQUEST";

export type DeadLetterListResult =
  | Readonly<{ kind: "page"; items: readonly DeadLetterView[]; next: DeadLetterCursor | undefined }>
  | Readonly<{ kind: "not-found" }>;

export type DeadLetterGetResult =
  | Readonly<{ kind: "found"; item: DeadLetterRunDetail }>
  | Readonly<{ kind: "not-found" }>;

export type RetryRequest = Readonly<{
  runId: string;
  /** Revision the caller inspected; a stale value is a conflict. */
  expectedRevision: number;
  /** Required justification, 1 to 500 characters. */
  reason: string;
  /** Explicit per-action confirmation for non-idempotent actions (D-15). Cannot override reconciliation. */
  confirmedActionIndexes?: readonly number[];
}>;

export type RetryResult =
  | Readonly<{ kind: "requeued"; runId: string; revision: number }>
  | Readonly<{ kind: "blocked"; code: RecoveryBlockCode; actionIndexes: readonly number[] }>
  | Readonly<{ kind: "not-retryable" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "invalid"; code: RecoveryInvalidCode }>;

export type RecordDeadLetterInput = Readonly<{
  runId: string;
  fencingToken: number;
  /** Must be a stop decision with outcome dead_letter (from decideRetry). */
  decision: RetryDecision;
  /** Attempts made so far, including the first. */
  attempt: number;
  firstAttemptAt: string;
  failure?: Pick<ActionFailure, "code" | "errorClass">;
  actionIndex?: number;
}>;

export type DeadLetterService = Readonly<{
  /** System path used by the worker when the retry budget ends. */
  recordDeadLetter: (scope: WorkspaceScope, input: RecordDeadLetterInput) => Promise<"dead_lettered" | "stale" | "invalid">;
  list: (
    scope: WorkspaceScope,
    principal: Principal,
    page: Readonly<{ after: DeadLetterCursor | undefined; limit: number }>
  ) => Promise<DeadLetterListResult>;
  get: (scope: WorkspaceScope, principal: Principal, runId: string) => Promise<DeadLetterGetResult>;
  retry: (scope: WorkspaceScope, principal: Principal, request: RetryRequest) => Promise<RetryResult>;
  /** Operations path: feeds dashboards and evaluateDeadLetterBacklog. */
  backlog: (scope: WorkspaceScope) => Promise<DeadLetterBacklog>;
}>;

const maxReasonLength = 500;

export const normalizeReason = (value: string): string | undefined => {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length >= 1 && cleaned.length <= maxReasonLength ? cleaned : undefined;
};

const toActor = (principal: Principal): RecoveryAuditActor | undefined =>
  principal.type === "user" || principal.type === "system"
    ? Object.freeze({ type: principal.type, id: principal.id })
    : undefined;

const notFound = Object.freeze({ kind: "not-found" as const });
const notRetryable = Object.freeze({ kind: "not-retryable" as const });
const conflict = Object.freeze({ kind: "conflict" as const });
const invalid = (code: RecoveryInvalidCode): RetryResult => Object.freeze({ kind: "invalid" as const, code });

export const createDeadLetterService = ({
  runs,
  policy,
  audit,
  metrics,
  clock,
  rng,
  ownsScope,
  actions = actionRegistry
}: Readonly<{
  runs: RunRepository;
  policy: PolicyPort;
  audit: RecoveryAuditPort;
  metrics: ActionMetricsPort;
  clock: Clock;
  rng: Rng;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  actions?: ActionRegistry;
}>): DeadLetterService => {
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const service: DeadLetterService = Object.freeze({
    recordDeadLetter: async (scope, input) => {
      requireScope(scope);
      const { decision } = input;
      if (
        decision.decision !== "stop" ||
        decision.outcome !== "dead_letter" ||
        !Number.isSafeInteger(input.attempt) ||
        input.attempt < 1 ||
        !Number.isSafeInteger(input.fencingToken) ||
        !isIsoInstant(input.firstAttemptAt)
      ) {
        return "invalid";
      }
      return runs.deadLetterRun(scope, input.runId, input.fencingToken, clock.now(), {
        reason: decision.reason,
        attempts: input.attempt,
        firstAttemptAt: input.firstAttemptAt,
        ...(input.failure === undefined
          ? {}
          : { failureCode: input.failure.code, errorClass: input.failure.errorClass }),
        ...(input.actionIndex === undefined ? {} : { actionIndex: input.actionIndex })
      });
    },

    list: async (scope, principal, page) => {
      requireScope(scope);
      const allowed = await policy.authorize(
        principal,
        deadLetterPermissions.read,
        { type: "workspace", id: scope.workspaceId }
      );
      if (!allowed) return notFound;
      const result = await runs.listDeadLetters(scope, { after: page.after, limit: page.limit });
      return Object.freeze({
        kind: "page" as const,
        items: Object.freeze(result.items.map((run) => toView(run))),
        next: result.next
      });
    },

    get: async (scope, principal, runId) => {
      requireScope(scope);
      const run = await runs.findById(scope, runId);
      if (!run || run.status !== "dead_letter") return notFound;
      const allowed = await policy.authorize(
        principal,
        deadLetterPermissions.read,
        { type: "automation", id: run.automationId }
      );
      if (!allowed) return notFound;
      const attempts = await runs.listActionAttempts(scope, runId);
      return Object.freeze({
        kind: "found" as const,
        item: Object.freeze({ ...toView(run), actions: Object.freeze(attempts.map((attempt) => toSummary(attempt))) })
      });
    },

    retry: async (scope, principal, request) => {
      requireScope(scope);
      const actor = toActor(principal);
      if (actor === undefined) return invalid("RECOVERY_INVALID_PRINCIPAL");
      const reason = normalizeReason(request.reason);
      if (reason === undefined) return invalid("RECOVERY_REASON_REQUIRED");
      const confirmed = Object.freeze([...(request.confirmedActionIndexes ?? [])]);
      if (
        request.runId.length === 0 ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision < 0 ||
        confirmed.length > automationLimits.actionsPerRule ||
        confirmed.some((index) => !Number.isSafeInteger(index) || index < 0)
      ) {
        return invalid("RECOVERY_INVALID_REQUEST");
      }

      const run = await runs.findById(scope, request.runId);
      if (!run) return notFound;

      const occurredAt = clock.now();
      const correlationId = rng.nextId();
      const record = async (
        outcome: RecoveryAuditOutcome,
        to: RunStatus,
        blockedCode?: RecoveryBlockedCode
      ): Promise<void> => {
        metrics.increment("automation_dead_letter_recovery_total", { outcome });
        await audit.append(scope, Object.freeze({
          workspaceId: scope.workspaceId,
          actor,
          action: "retry" as const,
          target: Object.freeze({ type: "run" as const, id: run.runId }),
          automationId: run.automationId,
          occurredAt,
          outcome,
          correlationId,
          reason,
          confirmedActionIndexes: confirmed,
          ...(blockedCode === undefined ? {} : { blockedCode }),
          change: Object.freeze({ status: Object.freeze({ from: run.status, to }) })
        }));
      };

      const allowed = await policy.authorize(
        principal,
        deadLetterPermissions.replay,
        { type: "automation", id: run.automationId }
      );
      if (!allowed) {
        await record("denied", run.status);
        return notFound;
      }
      if (run.status !== "dead_letter") {
        await record("blocked", run.status, "NOT_DEAD_LETTER");
        return notRetryable;
      }
      if (run.revision !== request.expectedRevision) return conflict;

      const attempts = await runs.listActionAttempts(scope, run.runId);
      const decision = decideDeadLetterRecovery({ attempts, confirmedActionIndexes: confirmed }, actions);
      if (decision.decision === "blocked") {
        await record("blocked", run.status, decision.code);
        return Object.freeze({
          kind: "blocked" as const,
          code: decision.code,
          actionIndexes: decision.actionIndexes
        });
      }

      const requeued = await runs.requeueDeadLetter(scope, run.runId, request.expectedRevision, occurredAt);
      if (requeued === "requeued") {
        await record("succeeded", "queued");
        return Object.freeze({
          kind: "requeued" as const,
          runId: run.runId,
          revision: request.expectedRevision + 1
        });
      }
      return requeued === "not-found" ? notFound : conflict;
    },

    backlog: async (scope) => {
      requireScope(scope);
      return runs.deadLetterBacklog(scope, clock.now());
    }
  });
  return service;
};