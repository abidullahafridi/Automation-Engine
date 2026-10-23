import type { AuditPort } from "./audit.port.js";
import type { PolicyPort, Principal, WorkspaceScope } from "./automation.ports.js";
import type { Clock, Rng } from "./automation.service.js";
import {
  transitionAutomationLifecycle,
  type AutomationLifecycleState,
  type LifecycleAuditAction,
  type LifecycleMutationResult
} from "./version.lifecycle.service.js";

export const permissionForAction: Readonly<Record<LifecycleAuditAction, string>> = Object.freeze({
  enable: "automation.enable",
  pause: "automation.pause",
  resume: "automation.resume",
  disable: "automation.disable",
  archive: "automation.archive"
});

export const transitionAutomationLifecycleWithAudit = async (
  state: AutomationLifecycleState,
  input: Readonly<{
    scope: WorkspaceScope;
    principal: Principal;
    action: LifecycleAuditAction;
    expectedRevision: number;
  }>,
  dependencies: Readonly<{
    ownsScope: (scope: unknown) => scope is WorkspaceScope;
    policy: PolicyPort;
    auditPort: AuditPort;
    clock: Clock;
    rng: Rng;
  }>
): Promise<LifecycleMutationResult> => {
  if (!dependencies.ownsScope(input.scope)) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: Object.freeze([Object.freeze({
        code: "AUTOMATION_INVALID_RULE",
        path: "/scope",
        message: "Resolver-minted workspace scope is required."
      })])
    });
  }
  if (input.principal.type !== "user" && input.principal.type !== "system") {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: Object.freeze([Object.freeze({
        code: "AUTOMATION_INVALID_RULE",
        path: "/principal",
        message: "Lifecycle operation requires a user or system principal."
      })])
    });
  }
  const authorized = await dependencies.policy.authorize(
    input.principal,
    permissionForAction[input.action],
    { type: "automation", id: state.automationId }
  );
  const result = transitionAutomationLifecycle(state, {
    action: input.action,
    expectedRevision: input.expectedRevision,
    authorized,
    audit: {
      workspaceId: input.scope.workspaceId,
      actor: { type: input.principal.type, id: input.principal.id },
      occurredAt: dependencies.clock.now(),
      correlationId: dependencies.rng.nextId()
    }
  });
  if (!result.ok && result.kind === "denied") {
    await dependencies.auditPort.append(input.scope, result.auditEvent);
  } else if (result.ok) {
    const auditEvent = result.state.auditEvents[result.state.auditEvents.length - 1];
    if (!auditEvent) throw new Error("Successful lifecycle transition did not create an audit event.");
    await dependencies.auditPort.append(input.scope, auditEvent);
  }
  return result;
};
