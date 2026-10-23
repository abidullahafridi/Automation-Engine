import assert from "node:assert/strict";
import test from "node:test";
import { createActionExecutor, type ActionExecutionResult } from "../action.executor.js";
import {
  createActionHandlerRegistry,
  type ActionHandler,
  type ActionHandlerContext
} from "../action.handler.js";
import {
  createPrincipalResolver,
  type PolicyPort,
  type WorkspaceScope
} from "../automation.ports.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const validConfig = Object.freeze({
  recipient: Object.freeze({ type: "project_lead" }),
  template: "task_completed"
});

const run = Object.freeze({ runId: "run-1", workspaceId: "workspace-a", automationId: "auto-1" });

type Probe = Readonly<{
  invocations: () => number;
  contexts: () => readonly ActionHandlerContext[];
  executor: ReturnType<typeof createActionExecutor>;
}>;

const buildProbe = (policy: PolicyPort): Probe => {
  const seen: ActionHandlerContext[] = [];
  let count = 0;
  const handler: ActionHandler = {
    type: "notification.send",
    execute: (_config, context) => {
      count += 1;
      seen.push(context);
      return Promise.resolve({ notificationId: "n-1", status: "sent" });
    },
    classifyError: () => "permanent"
  };
  return Object.freeze({
    invocations: () => count,
    contexts: () => seen,
    executor: createActionExecutor({
      ownsScope: resolver.ownsScope,
      policy,
      handlers: createActionHandlerRegistry([handler])
    })
  });
};

const failedOf = (result: ActionExecutionResult) => {
  if (result.status !== "failed") throw new Error("Expected a failed result.");
  return result;
};

void test("TC-0403 executor: creator permission revoked after authoring blocks the handler", async () => {
  const scope = await scopeFor("workspace-a");
  const calls: string[] = [];
  const probe = buildProbe({
    authorize: (principal, permission) => {
      calls.push(`${principal.type}:${permission}`);
      // Delegated automation principal is allowed; the creator lost the permission.
      return Promise.resolve(principal.type === "automation");
    }
  });

  const result = failedOf(await probe.executor.execute({
    scope,
    run,
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: validConfig }
  }));

  assert.equal(result.failure.code, "ACTION_PERMISSION_DENIED");
  assert.equal(result.failure.errorClass, "permanent");
  assert.equal(result.handlerInvoked, false);
  assert.equal(probe.invocations(), 0);
  assert.deepEqual([...calls].sort(), ["automation:notification.send", "user:notification.send"]);
});

void test("TC-0403 executor: both permissions valid executes once with trusted frozen context", async () => {
  const scope = await scopeFor("workspace-a");
  const probe = buildProbe({ authorize: () => Promise.resolve(true) });

  const result = await probe.executor.execute({
    scope,
    run,
    creatorId: "creator-1",
    actionIndex: 2,
    action: { type: "notification.send", config: validConfig }
  });

  assert.equal(result.status, "succeeded");
  assert.equal(probe.invocations(), 1);
  const [context] = probe.contexts();
  if (!context) throw new Error("Handler context expected.");
  assert.equal(context.workspaceId, "workspace-a");
  assert.equal(context.scope, scope);
  assert.equal(context.principal.id, "automation:auto-1");
  assert.equal(context.principal.creatorId, "creator-1");
  assert.equal(context.actionIndex, 2);
  assert.equal(Object.isFrozen(context), true);
});

void test("TC-0403 executor: policy outage is transient and causes no side effect", async () => {
  const scope = await scopeFor("workspace-a");
  const probe = buildProbe({ authorize: () => Promise.reject(new Error("platform down")) });

  const result = failedOf(await probe.executor.execute({
    scope,
    run,
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: validConfig }
  }));

  assert.equal(result.failure.code, "ACTION_POLICY_UNAVAILABLE");
  assert.equal(result.failure.errorClass, "transient");
  assert.equal(probe.invocations(), 0);
});

void test("TC-0402 executor: unknown action and invalid config never reach policy or handler", async () => {
  const scope = await scopeFor("workspace-a");
  let policyCalls = 0;
  const probe = buildProbe({
    authorize: () => {
      policyCalls += 1;
      return Promise.resolve(true);
    }
  });

  const unknown = failedOf(await probe.executor.execute({
    scope,
    run,
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "task.delete_everything", config: {} }
  }));
  assert.equal(unknown.failure.code, "ACTION_UNKNOWN_TYPE");

  const invalid = failedOf(await probe.executor.execute({
    scope,
    run,
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: { recipient: { type: "anyone" }, template: "x" } }
  }));
  assert.equal(invalid.failure.code, "ACTION_INVALID_INPUT");

  assert.equal(policyCalls, 0);
  assert.equal(probe.invocations(), 0);
});