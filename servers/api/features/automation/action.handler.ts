import type { PermissionResource, Principal, WorkspaceScope } from "./automation.ports.js";
import {
  actionRegistry,
  createRegistry,
  type ActionRegistry,
  type Registry
} from "./automation.registry.js";

export type ActionErrorClass = "transient" | "permanent" | "ambiguous";

/** Trusted, read-only facts available before the handler is invoked. */
export type ActionResourceContext = Readonly<{
  scope: WorkspaceScope;
  workspaceId: string;
  automationId: string;
  runId: string;
  actionIndex: number;
}>;

/** Everything a handler may see. Frozen by the executor; handlers cannot widen scope. */
export type ActionHandlerContext = ActionResourceContext & Readonly<{
  principal: Principal;
  /** sha256(runId:actionIndex). Pass it to the domain service so the effect is deduplicated. */
  idempotencyKey: string;
  /** Aborted on timeout or when the caller (lease loss / shutdown) aborts. Must be honoured. */
  signal: AbortSignal;
}>;

export type ActionHandler<TConfig = unknown, TResult = unknown> = Readonly<{
  /** Must match a type declared in the ActionRegistry. */
  type: string;
  /** Receives config already validated by the registered schema. */
  execute: (config: TConfig, context: ActionHandlerContext) => Promise<TResult>;
  /** Drives retry / unknown_outcome. Must be pure and must not throw. */
  classifyError: (error: unknown) => ActionErrorClass;
  /**
   * Resource the permission check is evaluated against. Defaults to the workspace.
   * Must stay inside the trusted workspace.
   */
  resolveResource?: (config: TConfig, context: ActionResourceContext) => PermissionResource;
}>;

/** Type-erased form stored in the registry. */
export type AnyActionHandler = ActionHandler<never>;

export type ActionHandlerRegistry = Registry<AnyActionHandler>;

/**
 * Fail-closed: duplicate handler types throw, and a handler whose type is not declared
 * in the action registry (schema, permission, timeout, redaction) throws.
 */
export const createActionHandlerRegistry = (
  handlers: readonly AnyActionHandler[],
  actions: ActionRegistry = actionRegistry
): ActionHandlerRegistry => {
  for (const handler of handlers) {
    if (!actions.get(handler.type)) {
      throw new Error(`Action handler has no registered action: ${handler.type}`);
    }
  }
  return createRegistry(handlers);
};