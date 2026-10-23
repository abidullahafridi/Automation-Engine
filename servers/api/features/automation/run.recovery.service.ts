import { createHash } from "node:crypto";
import type { ActionMetricsPort } from "./action.outcome.js";
import type { PolicyPort, Principal, WorkspaceScope } from "./automation.ports.js";
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import type { Clock, Rng } from "./automation.service.js";
import { automationLimits } from "./condition.validation.js";
import { decideDeadLetterRecovery, type RecoveryBlockCode } from "./dead-letter.policy.js";
import {
  deadLetterPermissions,
  normalizeReason,
  type DeadLetterService,
  type RecoveryAuditActor,
  type RecoveryAuditOutcome,
  type RecoveryAuditPort,
  type RecoveryBlockedCode,
  type RecoveryInvalidCode
} from "./dead-letter.service.js";
import type { RecoveryIdempotencyStore, RecoveryReceipt } from "./run.recovery.idempotency.js";
import type { RunRepository, RunStatus, StoredRun } from "./run.repository.js";

export type RecoveryRequestBase = Readonly<{
  runId: string;
  /** Required justification, 1 to 500 characters. */
  reason: string;
  /** Explicit per-action confirmation for non-idempotent actions (D-15). Never overrides reconciliation. */
  confirmedActionIndexes?: readonly number[];
  /** Client Idempotency-Key, 1 to 200 characters. */
  idempotencyKey: string;
}>;

export type RetryRecoveryRequest = RecoveryRequestBase & Readonly<{ expectedRevision: number }>;
export type ReplayRecoveryRequest = RecoveryRequestBase;

export type RecoveryInvalidKind = RecoveryInvalidCode | "RECOVERY_IDEMPOTENCY_KEY_REQUIRED";

export type RecoveryOutcome =
  | Readonly<{ kind: "requeued"; runId: string; revision: number; idempotentReplay: boolean }>
  | Readonly<{ kind: "replayed"; runId: string; replayRunId: string; idempotentReplay: boolean }>
  | Readonly<{ kind: "blocked"; code: RecoveryBlockCode; actionIndexes: readonly number[] }>
  | Readonly<{ kind: "not-retryable" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "invalid"; code: RecoveryInvalidKind }>
  | Readonly<{ kind: "idempotency-conflict" }>
  | Readonly<{ kind: "in-progress" }>;

export type RunRecoveryService = Readonly<{
  retry: (scope: WorkspaceScope, principal: Principal, request: RetryRecoveryRequest) => Promise<RecoveryOutcome>;
  replay: (scope: WorkspaceScope, principal: Principal, request: ReplayRecoveryRequest) => Promise<RecoveryOutcome>;
}>;

const maxKeyLength = 200;
const replayableStatuses: readonly RunStatus[] = Object.freeze(["dead_letter", "failed"]);

const notFound: RecoveryOutcome = Object.freeze({ kind: "not-found" });
const invalid = (code: RecoveryInvalidKind): RecoveryOutcome => Object.freeze({ kind: "invalid", code });
const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const toActor = (principal: Principal): RecoveryAuditActor | undefined =>
  principal.type === "user" || principal.type === "system"
    ? Object.freeze({ type: principal.type, id: principal.id })
    : undefined;

type Prepared =
  | Readonly<{ ok: false; outcome: RecoveryOutcome }>
  | Readonly<{
      ok: true;
      actor: RecoveryAuditActor;
      reason: string;
      confirmed: readonly number[];
      storeKey: string;
    }>;

const prepare = (principal: Principal, request: RecoveryRequestBase): Prepared => {
  const actor = toActor(principal);
  if (actor === undefined) return { ok: false, outcome: invalid("RECOVERY_INVALID_PRINCIPAL") };
  if (request.idempotencyKey.length < 1 || request.idempotencyKey.length > maxKeyLength) {
    return { ok: false, outcome: invalid("RECOVERY_IDEMPOTENCY_KEY_REQUIRED") };
  }
  const reason = normalizeReason(request.reason);
  if (reason === undefined) return { ok: false, outcome: invalid("RECOVERY_REASON_REQUIRED") };
  const confirmed = Object.freeze([...new Set(request.confirmedActionIndexes ?? [])].sort((a, b) => a - b));
  if (
    request.runId.length === 0 ||
    confirmed.length > automationLimits.actionsPerRule ||
    confirmed.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    return { ok: false, outcome: invalid("RECOVERY_INVALID_REQUEST") };
  }
  // The principal is part of the key so one user's key can never return another user's receipt.
  return { ok: true, actor, reason, confirmed, storeKey: `${principal.id}\u0000${request.idempotencyKey}` };
};

export const createRunRecoveryService = ({
  runs,
  deadLetters,
  policy,
  audit,
  metrics,
  idempotency,
  clock,
  rng,
  ownsScope,
  actions = actionRegistry
}: Readonly<{
  runs: RunRepository;
  deadLetters: DeadLetterService;
  policy: PolicyPort;
  audit: RecoveryAuditPort;
  metrics: ActionMetricsPort;
  idempotency: RecoveryIdempotencyStore;
  clock: Clock;
  rng: Rng;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  actions?: ActionRegistry;
}>): RunRecoveryService => {
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  const fromReceipt = (receipt: RecoveryReceipt): RecoveryOutcome =>
    receipt.kind === "requeued"
      ? Object.freeze({ kind: "requeued", runId: receipt.runId, revision: receipt.revision, idempotentReplay: true })
      : Object.freeze({
          kind: "replayed",
          runId: receipt.runId,
          replayRunId: receipt.replayRunId,
          idempotentReplay: true
        });

  const toReceipt = (outcome: RecoveryOutcome): RecoveryReceipt | undefined => {
    if (outcome.kind === "requeued") {
      return Object.freeze({ kind: "requeued", runId: outcome.runId, revision: outcome.revision });
    }
    if (outcome.kind === "replayed") {
      return Object.freeze({ kind: "replayed", runId: outcome.runId, replayRunId: outcome.replayRunId });
    }
    return undefined;
  };

  const withIdempotency = async (
    scope: WorkspaceScope,
    storeKey: string,
    requestHash: string,
    execute: () => Promise<RecoveryOutcome>
  ): Promise<RecoveryOutcome> => {
    const reserved = await idempotency.reserve(scope, storeKey, requestHash, clock.now());
    if (reserved.kind === "replay") return fromReceipt(reserved.receipt);
    if (reserved.kind === "conflict") return Object.freeze({ kind: "idempotency-conflict" });
    if (reserved.kind === "in-progress") return Object.freeze({ kind: "in-progress" });
    let outcome: RecoveryOutcome;
    try {
      outcome = await execute();
    } catch (error) {
      await idempotency.release(scope, storeKey);
      throw error;
    }
    const receipt = toReceipt(outcome);
    if (receipt) await idempotency.complete(scope, storeKey, receipt);
    else await idempotency.release(scope, storeKey);
    return outcome;
  };

  const service: RunRecoveryService = Object.freeze({
    retry: async (scope, principal, request) => {
      requireScope(scope);
      const prepared = prepare(principal, request);
      if (!prepared.ok) return prepared.outcome;
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
        return invalid("RECOVERY_INVALID_REQUEST");
      }
      const requestHash = sha256(JSON.stringify({
        op: "retry",
        runId: request.runId,
        expectedRevision: request.expectedRevision,
        reason: prepared.reason,
        confirmed: prepared.confirmed
      }));
      return withIdempotency(scope, prepared.storeKey, requestHash, async () => {
        // Same run, same effect keys: DeadLetterService owns authorization, policy, audit, and CAS.
        const result = await deadLetters.retry(scope, principal, {
          runId: request.runId,
          expectedRevision: request.expectedRevision,
          reason: prepared.reason,
          confirmedActionIndexes: prepared.confirmed
        });
        if (result.kind === "requeued") {
          return Object.freeze({
            kind: "requeued" as const,
            runId: result.runId,
            revision: result.revision,
            idempotentReplay: false
          });
        }
        if (result.kind === "invalid") return invalid(result.code);
        return result;
      });
    },

    replay: async (scope, principal, request) => {
      requireScope(scope);
      const prepared = prepare(principal, request);
      if (!prepared.ok) return prepared.outcome;
      const requestHash = sha256(JSON.stringify({
        op: "replay",
        runId: request.runId,
        reason: prepared.reason,
        confirmed: prepared.confirmed
      }));
      return withIdempotency(scope, prepared.storeKey, requestHash, async () => {
        const source = await runs.findById(scope, request.runId);
        if (!source) return notFound;

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
            actor: prepared.actor,
            action: "replay" as const,
            target: Object.freeze({ type: "run" as const, id: source.runId }),
            automationId: source.automationId,
            occurredAt,
            outcome,
            correlationId,
            reason: prepared.reason,
            confirmedActionIndexes: prepared.confirmed,
            ...(blockedCode === undefined ? {} : { blockedCode }),
            change: Object.freeze({ status: Object.freeze({ from: source.status, to }) })
          }));
        };

        const allowed = await policy.authorize(
          principal,
          deadLetterPermissions.replay,
          { type: "automation", id: source.automationId }
        );
        if (!allowed) {
          await record("denied", source.status);
          return notFound;
        }
        if (!replayableStatuses.includes(source.status)) {
          await record("blocked", source.status, "NOT_REPLAYABLE");
          return Object.freeze({ kind: "not-retryable" as const });
        }

        const attempts = await runs.listActionAttempts(scope, source.runId);
        const decision = decideDeadLetterRecovery(
          { attempts, confirmedActionIndexes: prepared.confirmed },
          actions
        );
        if (decision.decision === "blocked") {
          await record("blocked", source.status, decision.code);
          return Object.freeze({
            kind: "blocked" as const,
            code: decision.code,
            actionIndexes: decision.actionIndexes
          });
        }

        // Deterministic per (workspace, run, principal, key): a duplicate insert is idempotent.
        const suffix = sha256(
          `${scope.workspaceId}\u0000${source.runId}\u0000${principal.id}\u0000${request.idempotencyKey}`
        ).slice(0, 24);
        const replayRun: StoredRun = Object.freeze({
          runId: `${source.runId}-replay-${suffix}`,
          eventId: `replay:${source.runId}:${suffix}`,
          workspaceId: scope.workspaceId,
          automationId: source.automationId,
          version: source.version,
          contentHash: source.contentHash,
          status: "queued" as const,
          revision: 0,
          fencingToken: 0,
          runAfter: occurredAt,
          createdAt: occurredAt,
          updatedAt: occurredAt,
          replayOf: source.runId,
          ...(source.traceparent === undefined ? {} : { traceparent: source.traceparent })
        });
        await runs.insert(scope, replayRun);
        await record("succeeded", "queued");
        return Object.freeze({
          kind: "replayed" as const,
          runId: source.runId,
          replayRunId: replayRun.runId,
          idempotentReplay: false
        });
      });
    }
  });
  return service;
};