import { createHash } from "node:crypto";
import {
  actionRegistry,
  type ActionRegistration,
  type ActionRegistry
} from "./automation.registry.js";
import {
  authorizeAutomationExecution,
  automationExecutionPrincipal,
  type PermissionResource,
  type PolicyPort,
  type WorkspaceScope
} from "./automation.ports.js";
import { checkAutomationJsonBounds } from "./condition.validation.js";
import type {
  ActionErrorClass,
  ActionHandler,
  ActionHandlerContext,
  ActionHandlerRegistry,
  ActionResourceContext
} from "./action.handler.js";

export type ActionFailureCode =
  | "ACTION_UNKNOWN_TYPE"
  | "ACTION_INVALID_INPUT"
  | "ACTION_PERMISSION_DENIED"
  | "ACTION_POLICY_UNAVAILABLE"
  | "ACTION_SCOPE_MISMATCH"
  | "ACTION_TIMEOUT_NOT_CONFIGURED"
  | "ACTION_ABORTED"
  | "ACTION_TIMEOUT"
  | "ACTION_HANDLER_ERROR"
  | "ACTION_INVALID_OUTPUT";

export type ActionFailure = Readonly<{
  code: ActionFailureCode;
  errorClass: ActionErrorClass;
  /** Static safe text. Never contains submitted values, handler messages or stack traces. */
  message: string;
}>;

export type ActionExecutionRequest = Readonly<{
  scope: WorkspaceScope;
  run: Readonly<{ runId: string; workspaceId: string; automationId: string }>;
  /** Automation creator; execution permission is the intersection with this user's live permission. */
  creatorId: string;
  actionIndex: number;
  action: Readonly<{ type: string; config: unknown }>;
  /** Lease loss / shutdown signal from the run worker. */
  signal?: AbortSignal;
}>;

export type ActionExecutionResult =
  | Readonly<{
      status: "succeeded";
      handlerInvoked: true;
      idempotencyKey: string;
      output: unknown;
    }>
  | Readonly<{
      status: "failed";
      handlerInvoked: boolean;
      failure: ActionFailure;
      idempotencyKey?: string;
      workspaceId?: string;
    }>
  | Readonly<{
      status: "timed_out";
      handlerInvoked: true;
      failure: ActionFailure;
      timeoutMs: number;
      idempotencyKey: string;
    }>;

export type ActionExecutor = Readonly<{
  execute: (request: ActionExecutionRequest) => Promise<ActionExecutionResult>;
}>;

const reject = (
  code: ActionFailureCode,
  errorClass: ActionErrorClass,
  message: string,
  workspaceId?: string
): ActionExecutionResult => Object.freeze({
  status: "failed",
  handlerInvoked: false,
  failure: Object.freeze({ code, errorClass, message }),
  ...(workspaceId ? { workspaceId } : {})
});

const scopeMismatch = (workspaceId?: string): ActionExecutionResult =>
  reject("ACTION_SCOPE_MISMATCH", "permanent", "Action scope does not match the trusted workspace.", workspaceId);

/** An effect may have happened unless the action is safe to repeat. */
const uncertainClass = (sideEffect: ActionRegistration["sideEffect"]): ActionErrorClass =>
  sideEffect === "none" || sideEffect === "internal-idempotent" || sideEffect === "external-idempotent"
    ? "transient"
    : "ambiguous";

const timeoutFor = (registration: ActionRegistration): number | undefined => {
  const external = registration.sideEffect === "external" || registration.sideEffect === "external-idempotent";
  const preferred = external ? registration.timeoutMs.external : registration.timeoutMs.internal;
  return preferred ?? registration.timeoutMs.internal ?? registration.timeoutMs.external;
};

type Settled =
  | Readonly<{ kind: "value"; value: unknown }>
  | Readonly<{ kind: "error"; error: unknown }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "aborted" }>;

const invokeBounded = async (
  call: (signal: AbortSignal) => Promise<unknown>,
  timeoutMs: number,
  external: AbortSignal | undefined
): Promise<Settled> => {
  const controller = new AbortController();
  let finish: (settled: Settled) => void = () => undefined;
  const limit = new Promise<Settled>((resolve) => { finish = resolve; });
  const onExternalAbort = (): void => {
    controller.abort();
    finish({ kind: "aborted" });
  };
  const timer = setTimeout(() => {
    controller.abort();
    finish({ kind: "timeout" });
  }, timeoutMs);
  external?.addEventListener("abort", onExternalAbort, { once: true });

  // Promise.resolve().then also converts a synchronous throw into a rejection.
  const work: Promise<Settled> = Promise.resolve()
    .then(() => call(controller.signal))
    .then(
      (value): Settled => ({ kind: "value", value }),
      (error: unknown): Settled => ({ kind: "error", error })
    );
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  }
};

const classify = (handler: ActionHandler, error: unknown): ActionErrorClass => {
  try {
    return handler.classifyError(error);
  } catch {
    // An unclassifiable failure must not be retried blindly.
    return "ambiguous";
  }
};

export const createActionExecutor = ({
  ownsScope,
  policy,
  handlers,
  actions = actionRegistry
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  policy: PolicyPort;
  handlers: ActionHandlerRegistry;
  actions?: ActionRegistry;
}>): ActionExecutor => Object.freeze({
  execute: async (request): Promise<ActionExecutionResult> => {
    const { scope, run, creatorId, actionIndex, action } = request;

    // 1. Trusted scope. Fail closed, never throw.
    if (!ownsScope(scope) || run.workspaceId !== scope.workspaceId) return scopeMismatch(run.workspaceId);
    if (!Number.isSafeInteger(actionIndex) || actionIndex < 0 || creatorId.length === 0) {
      return reject("ACTION_INVALID_INPUT", "permanent", "Action request is invalid.");
    }

    // 2. Registered type + handler. Unknown => no side effect.
    const registration = actions.get(action.type);
    const erased = handlers.get(action.type);
    if (!registration || !erased) {
      return reject("ACTION_UNKNOWN_TYPE", "permanent", "Action type is not available.");
    }
    // Safe: the config below is validated by the registered schema that this handler is bound to.
    const handler = erased as ActionHandler;

    // 3. Bounded, schema-validated input. Handler is never reached on failure.
    if (checkAutomationJsonBounds(action.config)) {
      return reject("ACTION_INVALID_INPUT", "permanent", "Action configuration exceeds supported bounds.");
    }
    const parsed = registration.configSchema.safeParse(action.config);
    if (!parsed.success) {
      return reject("ACTION_INVALID_INPUT", "permanent", "Action configuration is invalid.");
    }
    const config: unknown = parsed.data;

    const resourceContext: ActionResourceContext = Object.freeze({
      scope,
      workspaceId: scope.workspaceId,
      automationId: run.automationId,
      runId: run.runId,
      actionIndex
    });

    // 4. Permission check BEFORE invocation (delegated principal AND creator's live permission).
    let resource: PermissionResource;
    try {
      resource = handler.resolveResource?.(config, resourceContext)
        ?? Object.freeze({ type: "workspace" as const, id: scope.workspaceId });
    } catch {
      return reject("ACTION_PERMISSION_DENIED", "permanent", "Action is not permitted.");
    }
    if (resource.type === "workspace" && resource.id !== scope.workspaceId) return scopeMismatch(scope.workspaceId);

    let allowed: boolean;
    try {
      allowed = await authorizeAutomationExecution(
        policy,
        run.automationId,
        creatorId,
        registration.requiredPermission.permission,
        resource
      );
    } catch {
      return reject("ACTION_POLICY_UNAVAILABLE", "transient", "Authorization could not be evaluated.");
    }
    if (!allowed) return reject("ACTION_PERMISSION_DENIED", "permanent", "Action is not permitted.");

    const timeoutMs = timeoutFor(registration);
    if (timeoutMs === undefined) {
      return reject("ACTION_TIMEOUT_NOT_CONFIGURED", "permanent", "Action has no configured timeout.");
    }
    if (request.signal?.aborted) {
      return reject("ACTION_ABORTED", "transient", "Execution was aborted before the action started.");
    }

    // 5. Invoke with a frozen context and a hard timeout.
    const idempotencyKey = createHash("sha256")
      .update(`${run.runId}:${String(actionIndex)}`, "utf8")
      .digest("hex");
    const principal = automationExecutionPrincipal(run.automationId, creatorId);

    const settled = await invokeBounded(
      (signal) => {
        const context: ActionHandlerContext = Object.freeze({
          ...resourceContext,
          principal,
          idempotencyKey,
          signal
        });
        return handler.execute(config, context);
      },
      timeoutMs,
      request.signal
    );

    switch (settled.kind) {
      case "timeout":
        return Object.freeze({
          status: "timed_out",
          handlerInvoked: true,
          timeoutMs,
          idempotencyKey,
          failure: Object.freeze({
            code: "ACTION_TIMEOUT",
            errorClass: uncertainClass(registration.sideEffect),
            message: "Action exceeded its time limit."
          })
        });
      case "aborted":
        return Object.freeze({
          status: "failed",
          handlerInvoked: true,
          idempotencyKey,
          failure: Object.freeze({
            code: "ACTION_ABORTED",
            errorClass: uncertainClass(registration.sideEffect),
            message: "Execution was aborted while the action was running."
          })
        });
      case "error":
        return Object.freeze({
          status: "failed",
          handlerInvoked: true,
          idempotencyKey,
          failure: Object.freeze({
            code: "ACTION_HANDLER_ERROR",
            errorClass: classify(handler, settled.error),
            message: "Action failed."
          })
        });
      case "value": {
        const output = registration.resultSchema.safeParse(settled.value);
        if (!output.success) {
          // The effect may already have happened, so this is never retried blindly.
          return Object.freeze({
            status: "failed",
            handlerInvoked: true,
            idempotencyKey,
            failure: Object.freeze({
              code: "ACTION_INVALID_OUTPUT",
              errorClass: uncertainClass(registration.sideEffect) === "transient" ? "transient" : "ambiguous",
              message: "Action returned an unexpected result."
            })
          });
        }
        return Object.freeze({
          status: "succeeded",
          handlerInvoked: true,
          idempotencyKey,
          output: Object.freeze(output.data)
        });
      }
    }
  }
});