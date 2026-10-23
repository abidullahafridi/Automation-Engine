import type { WorkspaceScope } from "./automation.ports.js";
import type { AuditLog } from "./audit.log.js";
import {
  buildAuditRecord,
  type AuditAction,
  type AuditActor,
  type AuditOutcome,
  type AuditRecord,
  type AuditRejectionCode,
  type AuditTarget
} from "./audit.record.js";

/** Structurally compatible with the feature's Clock and Rng. */
export type AuditClock = Readonly<{ now: () => string }>;
export type AuditIdSource = Readonly<{ nextId: () => string }>;

export type AuditRequest = Readonly<{
  /** Provide a deterministic id to make retries idempotent. */
  recordId: string | undefined;
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  outcome: AuditOutcome;
  correlationId: string | undefined;
  occurredAt: string | undefined;
  details: Readonly<Record<string, unknown>>;
}>;

export type AuditRecordRejection = AuditRejectionCode | "SCOPE_MISSING" | "RECORD_CONFLICT";

export type AuditRecordResult =
  | Readonly<{ kind: "recorded"; record: AuditRecord }>
  | Readonly<{ kind: "idempotent"; record: AuditRecord }>
  | Readonly<{ kind: "rejected"; code: AuditRecordRejection }>
  | Readonly<{ kind: "unavailable" }>;

export type AuditRecorder = Readonly<{
  record: (scope: WorkspaceScope, request: AuditRequest) => Promise<AuditRecordResult>;
}>;

export const createAuditRecorder = ({
  ownsScope,
  log,
  clock,
  ids
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  log: AuditLog;
  clock: AuditClock;
  ids: AuditIdSource;
}>): AuditRecorder => {
  const rejected = (code: AuditRecordRejection): AuditRecordResult =>
    Object.freeze({ kind: "rejected", code });

  return Object.freeze({
    record: async (scope: WorkspaceScope, request: AuditRequest): Promise<AuditRecordResult> => {
      // Workspace always comes from the trusted scope, never from the request.
      if (!ownsScope(scope)) return rejected("SCOPE_MISSING");
      try {
        const built = buildAuditRecord({
          recordId: request.recordId ?? ids.nextId(),
          workspaceId: scope.workspaceId,
          input: {
            actor: request.actor,
            action: request.action,
            target: request.target,
            outcome: request.outcome,
            correlationId: request.correlationId ?? ids.nextId(),
            occurredAt: request.occurredAt ?? clock.now(),
            details: request.details
          }
        });
        if (!built.ok) return rejected(built.code);
        const result = await log.append(scope, built.record);
        if (result === "conflict") return rejected("RECORD_CONFLICT");
        if (result === "idempotent") return Object.freeze({ kind: "idempotent", record: built.record });
        return Object.freeze({ kind: "recorded", record: built.record });
      } catch {
        // The caller decides what an unwritten audit record means for its operation.
        return Object.freeze({ kind: "unavailable" });
      }
    }
  });
};