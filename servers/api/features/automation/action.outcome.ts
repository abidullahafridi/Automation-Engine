/**
 * Action outcome audit and metrics (AE-T-031.2).
 *
 * Wraps an ActionExecutor so every execution leaves one allowlisted, payload-free outcome
 * record and one low-cardinality metric. The record never contains action config, handler
 * messages, recipients or message content. Result fields are limited to the registered
 * redaction.resultFields of the action.
 */
import type { ActionErrorClass } from "./action.handler.js";
import type {
  ActionExecutionRequest,
  ActionExecutionResult,
  ActionExecutor,
  ActionFailureCode
} from "./action.executor.js";
import type { WorkspaceScope } from "./automation.ports.js";
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import type { Clock } from "./automation.service.js";

export type ActionOutcomeRecord = Readonly<{
  workspaceId: string;
  automationId: string;
  runId: string;
  actionIndex: number;
  actionType: string;
  status: ActionExecutionResult["status"];
  handlerInvoked: boolean;
  occurredAt: string;
  idempotencyKey?: string;
  failureCode?: ActionFailureCode;
  errorClass?: ActionErrorClass;
  result?: Readonly<Record<string, string>>;
}>;

export type ActionOutcomeSink = Readonly<{
  record: (scope: WorkspaceScope, outcome: ActionOutcomeRecord) => Promise<void>;
}>;

/** Labels must stay low-cardinality: never user, run or automation ids. */
export type ActionMetricsPort = Readonly<{
  increment: (name: string, labels: Readonly<Record<string, string>>) => void;
}>;

const pickResult = (
  fields: readonly string[],
  output: unknown
): Readonly<Record<string, string>> | undefined => {
  if (typeof output !== "object" || output === null) return undefined;
  const picked: Record<string, string> = {};
  for (const field of fields) {
    const value: unknown = Reflect.get(output, field);
    if (typeof value === "string") picked[field] = value;
  }
  return Object.freeze(picked);
};

const buildRecord = (
  request: ActionExecutionRequest,
  result: ActionExecutionResult,
  actions: ActionRegistry,
  occurredAt: string
): ActionOutcomeRecord => {
  const registration = actions.get(request.action.type);
  const failure = result.status === "succeeded" ? undefined : result.failure;
  const picked = result.status === "succeeded" && registration
    ? pickResult(registration.redaction.resultFields, result.output)
    : undefined;
  return Object.freeze({
    workspaceId: request.run.workspaceId,
    automationId: request.run.automationId,
    runId: request.run.runId,
    actionIndex: request.actionIndex,
    // Unregistered (possibly user-supplied) types are never copied into audit data.
    actionType: registration ? registration.type : "unknown",
    status: result.status,
    handlerInvoked: result.handlerInvoked,
    occurredAt,
    ...(result.idempotencyKey === undefined ? {} : { idempotencyKey: result.idempotencyKey }),
    ...(failure === undefined ? {} : { failureCode: failure.code, errorClass: failure.errorClass }),
    ...(picked === undefined ? {} : { result: picked })
  });
};

/**
 * Audit failure never changes or hides the action result (the effect may already have
 * happened and is idempotent); it is counted so an alert can fire.
 */
export const createAuditedActionExecutor = ({
  executor,
  sink,
  metrics,
  clock,
  actions = actionRegistry
}: Readonly<{
  executor: ActionExecutor;
  sink: ActionOutcomeSink;
  metrics: ActionMetricsPort;
  clock: Clock;
  actions?: ActionRegistry;
}>): ActionExecutor => Object.freeze({
  execute: async (request): Promise<ActionExecutionResult> => {
    const result = await executor.execute(request);
    const registration = actions.get(request.action.type);
    const actionType = registration ? registration.type : "unknown";

    metrics.increment("automation_action_attempts_total", {
      action_type: actionType,
      outcome: result.status
    });
    try {
      await sink.record(request.scope, buildRecord(request, result, actions, clock.now()));
    } catch {
      metrics.increment("automation_action_audit_failures_total", { action_type: actionType });
    }
    return result;
  }
});

export type InMemoryActionOutcomeStore = Readonly<{
  sink: ActionOutcomeSink;
  read: (scope: WorkspaceScope, runId: string) => Promise<readonly ActionOutcomeRecord[]>;
}>;

/** Test/flag-off double. Durable, append-only storage is a persistence task (AE-T-030.x/032.x). */
export const createInMemoryActionOutcomeStore = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryActionOutcomeStore => {
  const records: ActionOutcomeRecord[] = [];
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };
  const sink: ActionOutcomeSink = Object.freeze({
    record: async (scope, outcome): Promise<void> => {
      await Promise.resolve();
      requireScope(scope);
      if (outcome.workspaceId !== scope.workspaceId) {
        throw new Error("Outcome workspace must match the trusted scope.");
      }
      records.push(Object.freeze({ ...outcome }));
    }
  });
  return Object.freeze({
    sink,
    read: async (scope, runId): Promise<readonly ActionOutcomeRecord[]> => {
      await Promise.resolve();
      requireScope(scope);
      return Object.freeze(records.filter((record) =>
        record.workspaceId === scope.workspaceId && record.runId === runId));
    }
  });
};