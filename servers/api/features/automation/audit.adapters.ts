import { createHash } from "node:crypto";
import type { AuditPort } from "./audit.port.js";
import type { AuditAction } from "./audit.record.js";
import type { AuditRecorder, AuditRequest } from "./audit.recorder.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type { ExecutionDenialCode } from "./execution.context.js";
import type { LifecycleAuditAction, LifecycleAuditEvent } from "./version.lifecycle.service.js";

const lifecycleActions: Readonly<Record<LifecycleAuditAction, AuditAction>> = Object.freeze({
  enable: "automation.enable",
  pause: "automation.pause",
  resume: "automation.resume",
  disable: "automation.disable",
  archive: "automation.archive"
});

/** Same logical event always yields the same id, so a retried append is idempotent. */
const deterministicRecordId = (parts: readonly string[]): string =>
  `aud_${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 32)}`;

export const lifecycleAuditRequest = (event: LifecycleAuditEvent): AuditRequest => {
  const action = lifecycleActions[event.action];
  return Object.freeze({
    recordId: deterministicRecordId([event.workspaceId, event.correlationId, action, event.target.id]),
    actor: Object.freeze({
      type: event.actor.type === "user" ? "user" as const : "system" as const,
      id: event.actor.id
    }),
    action,
    target: Object.freeze({ type: "automation" as const, id: event.target.id }),
    outcome: event.outcome,
    correlationId: event.correlationId,
    occurredAt: event.occurredAt,
    details: Object.freeze({
      fromStatus: event.change.status.from,
      toStatus: event.change.status.to,
      version: event.change.version
    })
  });
};

/**
 * Drop-in AuditPort backed by the durable append-only log.
 * Throws when the record cannot be stored, so a lifecycle change is never silently unaudited.
 */
export const createLifecycleAuditPort = ({
  recorder
}: Readonly<{ recorder: AuditRecorder }>): AuditPort => {
  const append = async (scope: WorkspaceScope, event: LifecycleAuditEvent): Promise<void> => {
    if (event.workspaceId !== scope.workspaceId) {
      throw new Error("Lifecycle audit event does not match the trusted workspace.");
    }
    const result = await recorder.record(scope, lifecycleAuditRequest(event));
    if (result.kind === "rejected" || result.kind === "unavailable") {
      throw new Error("Lifecycle audit record could not be stored.");
    }
  };
  return Object.freeze({ append });
};

/** Denied execution (revoked permission, owner access lost). Carries codes only. */
export const executionDenialAuditRequest = ({
  automationId,
  runId,
  code,
  pauseAutomation,
  retryable,
  correlationId
}: Readonly<{
  automationId: string;
  runId: string;
  code: ExecutionDenialCode;
  pauseAutomation: boolean;
  retryable: boolean;
  correlationId: string | undefined;
}>): AuditRequest => Object.freeze({
  recordId: undefined,
  actor: Object.freeze({ type: "automation" as const, id: `automation:${automationId}` }),
  action: "execution.denied" as const,
  target: Object.freeze({ type: "run" as const, id: runId }),
  outcome: "denied" as const,
  correlationId,
  occurredAt: undefined,
  details: Object.freeze({ code, automationId, pauseAutomation, retryable })
});