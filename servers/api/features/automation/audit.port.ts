import { isIsoInstant } from "./condition.validation.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type {
  AutomationLifecycleStatus,
  LifecycleAuditAction,
  LifecycleAuditEvent,
  LifecycleAuditOutcome
} from "./version.lifecycle.service.js";

export type AuditPort = Readonly<{
  append: (scope: WorkspaceScope, event: LifecycleAuditEvent) => Promise<void>;
}>;

export type InMemoryAuditStore = Readonly<{
  auditPort: AuditPort;
  read: (scope: WorkspaceScope, automationId: string) => Promise<readonly LifecycleAuditEvent[]>;
}>;

const auditActions: readonly LifecycleAuditAction[] = Object.freeze([
  "enable", "pause", "resume", "disable", "archive"
]);
const auditOutcomes: readonly LifecycleAuditOutcome[] = Object.freeze(["succeeded", "denied"]);
const actorTypes: readonly string[] = Object.freeze(["user", "system"]);
const lifecycleStatuses: readonly AutomationLifecycleStatus[] = Object.freeze([
  "draft", "enabled", "paused", "disabled", "archived"
]);
const isAuditActorType = (value: string): boolean =>
  actorTypes.some((actorType) => actorType === value);

const safeAuditEvent = (
  scope: WorkspaceScope,
  event: LifecycleAuditEvent
): LifecycleAuditEvent => {
  if (
    event.workspaceId !== scope.workspaceId ||
    !isAuditActorType(event.actor.type) ||
    !event.actor.id ||
    !event.target.id ||
    !event.correlationId ||
    !isIsoInstant(event.occurredAt) ||
    !auditActions.includes(event.action) ||
    !auditOutcomes.includes(event.outcome) ||
    !lifecycleStatuses.includes(event.change.status.from) ||
    !lifecycleStatuses.includes(event.change.status.to) ||
    (event.change.version !== null && (!Number.isSafeInteger(event.change.version) || event.change.version < 1))
  ) {
    throw new Error("Invalid lifecycle audit event.");
  }
  return Object.freeze({
    workspaceId: scope.workspaceId,
    actor: Object.freeze({ type: event.actor.type, id: event.actor.id }),
    action: event.action,
    target: Object.freeze({ type: "automation", id: event.target.id }),
    occurredAt: event.occurredAt,
    outcome: event.outcome,
    correlationId: event.correlationId,
    change: Object.freeze({
      status: Object.freeze({
        from: event.change.status.from,
        to: event.change.status.to
      }),
      version: event.change.version
    })
  });
};

export const createInMemoryAuditStore = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryAuditStore => {
  const events: LifecycleAuditEvent[] = [];
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };
  const auditPort: AuditPort = Object.freeze({
    append: async (scope, event): Promise<void> => {
      await Promise.resolve();
      requireScope(scope);
      const safeEvent = safeAuditEvent(scope, event);
      events.push(safeEvent);
    }
  });
  return Object.freeze({
    auditPort,
    read: async (scope, automationId): Promise<readonly LifecycleAuditEvent[]> => {
      await Promise.resolve();
      requireScope(scope);
      return Object.freeze(events.filter((event) =>
        event.workspaceId === scope.workspaceId &&
        event.target.id === automationId));
    }
  });
};
