import type { AuditPort } from "./audit.port.js";
import { permissionForAction } from "./audit.lifecycle.service.js";
import type { Principal, PolicyPort, WorkspaceScope } from "./automation.ports.js";
import type { AutomationHeader, AutomationRepository } from "./automation.repository.js";
import type { Clock, Rng } from "./automation.service.js";
import {
  nextLifecycleStatus,
  transitionAutomationLifecycle,
  type AutomationLifecycleState,
  type AutomationLifecycleStatus,
  type LifecycleAuditAction,
  type LifecycleAuditEvent
} from "./version.lifecycle.service.js";

export type LifecycleTransitionRequest = Readonly<{
  automationId: string;
  action: LifecycleAuditAction;
  expectedRevision: number;
}>;

export type LifecycleTransitionOutcome =
  | Readonly<{ kind: "transitioned"; automation: AutomationHeader }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "conflict"; expectedRevision: number; actualRevision: number }>
  | Readonly<{
      kind: "invalid-transition";
      from: AutomationLifecycleStatus;
      action: LifecycleAuditAction;
    }>
  | Readonly<{ kind: "not-published" }>
  | Readonly<{ kind: "invalid-request"; message: string }>;

export type AutomationLifecycleTransitionService = Readonly<{
  transition: (
    scope: WorkspaceScope,
    principal: Principal,
    input: LifecycleTransitionRequest
  ) => Promise<LifecycleTransitionOutcome>;
}>;

const notFound: LifecycleTransitionOutcome = Object.freeze({ kind: "not-found" });

const toLifecycleState = (header: AutomationHeader): AutomationLifecycleState =>
  Object.freeze({
    automationId: header.automationId,
    revision: header.rev,
    draft: header.draft,
    hasDraft: header.hasDraft,
    versions: Object.freeze([]),
    activeVersion: header.currentVersion,
    status: header.status,
    auditEvents: Object.freeze([])
  });

export const createAutomationLifecycleTransitionService = ({
  repository,
  policy,
  auditPort,
  clock,
  rng
}: Readonly<{
  repository: AutomationRepository;
  policy: PolicyPort;
  auditPort: AuditPort;
  clock: Clock;
  rng: Rng;
}>): AutomationLifecycleTransitionService => {
  const transition: AutomationLifecycleTransitionService["transition"] = async (
    scope,
    principal,
    input
  ) => {
    const actorType = principal.type;
    // Automation principals can never manage lifecycle; stay non-enumerating.
    if (actorType !== "user" && actorType !== "system") return notFound;

    const header = await repository.findById(scope, input.automationId);
    if (!header) return notFound;

    const allowed = await policy.authorize(
      principal,
      permissionForAction[input.action],
      { type: "automation", id: header.automationId }
    );
    const occurredAt = clock.now();
    const correlationId = rng.nextId();
    const actor = Object.freeze({ type: actorType, id: principal.id });

    if (!allowed) {
      // Authorization is decided before revision/transition checks so that a
      // caller without permission learns nothing about the automation's state.
      const deniedEvent: LifecycleAuditEvent = Object.freeze({
        workspaceId: scope.workspaceId,
        actor,
        action: input.action,
        target: Object.freeze({ type: "automation", id: header.automationId }),
        occurredAt,
        outcome: "denied",
        correlationId,
        change: Object.freeze({
          status: Object.freeze({ from: header.status, to: header.status }),
          version: header.currentVersion
        })
      });
      await auditPort.append(scope, deniedEvent);
      return notFound;
    }

    const result = transitionAutomationLifecycle(toLifecycleState(header), {
      action: input.action,
      expectedRevision: input.expectedRevision,
      authorized: true,
      audit: { workspaceId: scope.workspaceId, actor, occurredAt, correlationId }
    });

    if (!result.ok) {
      if (result.kind === "conflict") {
        return Object.freeze({
          kind: "conflict",
          expectedRevision: result.expectedRevision,
          actualRevision: result.actualRevision
        });
      }
      if (result.kind === "invalid") {
        const issue = result.issues[0];
        if (issue?.path === "/action") {
          const statusAllows =
            nextLifecycleStatus(header.status, input.action, true) !== undefined;
          return statusAllows && header.currentVersion === null
            ? Object.freeze({ kind: "not-published" })
            : Object.freeze({
                kind: "invalid-transition",
                from: header.status,
                action: input.action
              });
        }
        return Object.freeze({
          kind: "invalid-request",
          message: issue?.message ?? "Lifecycle request is invalid."
        });
      }
      // "denied" cannot occur because authorization was already decided above.
      return notFound;
    }

    const persisted = await repository.transitionStatus(
      scope,
      header.automationId,
      { revision: header.rev, status: header.status },
      result.state.status,
      occurredAt
    );
    if (persisted !== "updated") {
      const latest = await repository.findById(scope, header.automationId);
      if (!latest) return notFound;
      return Object.freeze({
        kind: "conflict",
        expectedRevision: input.expectedRevision,
        actualRevision: latest.rev
      });
    }

    const auditEvent = result.state.auditEvents[result.state.auditEvents.length - 1];
    if (!auditEvent) throw new Error("Successful lifecycle transition did not create an audit event.");
    await auditPort.append(scope, auditEvent);

    const updated = await repository.findById(scope, header.automationId);
    if (!updated) throw new Error("Transitioned automation could not be re-read.");
    return Object.freeze({ kind: "transitioned", automation: updated });
  };

  return Object.freeze({ transition });
};