import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createActionHandlerRegistry, type ActionHandler, type ActionHandlerContext } from "../action.handler.js";
import {
  createActionExecutor,
  type ActionExecutionRequest,
  type ActionExecutionResult,
  type ActionFailure
} from "../action.executor.js";
import { createActionRegistry, notificationSendAction } from "../automation.registry.js";
import {
  createPrincipalResolver,
  type PolicyPort,
  type WorkspaceScope
} from "../automation.ports.js";

type TestConfig = Readonly<{ message: string }>;
type TestResult = Readonly<{ ok: boolean }>;

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user-1", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const registration = (overrides: Record<string, unknown> = {}) => ({
  ...notificationSendAction,
  type: "test.action",
  configSchema: z.object({ message: z.string().min(1) }).strict(),
  resultSchema: z.object({ ok: z.boolean() }).strict(),
  sideEffect: "internal-idempotent" as const,
  timeoutMs: Object.freeze({ internal: 30 }),
  ...overrides
});

const waitForAbort = (signal: AbortSignal): Promise<TestResult> =>
  new Promise<TestResult>((_resolve, reject) => {
    signal.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
  });

const policyFixture = (allow = true) => {
  const calls: string[] = [];
  const policy: PolicyPort = {
    authorize: (principal, permission, resource) => {
      calls.push(`${principal.id}:${permission}:${resource.type}:${resource.id}`);
      return Promise.resolve(allow);
    }
  };
  return { policy, calls };
};

const setup = async (options: Readonly<{
  registrationOverrides?: Record<string, unknown>;
  handler?: Partial<ActionHandler<TestConfig, TestResult>>;
  policy?: PolicyPort;
  registerHandler?: boolean;
}> = {}) => {
  const counter = { count: 0, contexts: [] as ActionHandlerContext[] };
  const handler: ActionHandler<TestConfig, TestResult> = Object.freeze({
    type: "test.action",
    execute: (_config: TestConfig, context: ActionHandlerContext) => {
      counter.count += 1;
      counter.contexts.push(context);
      return Promise.resolve({ ok: true });
    },
    classifyError: () => "transient" as const,
    ...options.handler
  });
  const actions = createActionRegistry([registration(options.registrationOverrides), notificationSendAction]);
  const handlers = createActionHandlerRegistry(options.registerHandler === false ? [] : [handler], actions);
  const fixture = policyFixture();
  const scope = await scopeFor("workspace-1");
  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: options.policy ?? fixture.policy,
    handlers,
    actions
  });
  const request = (overrides: Partial<ActionExecutionRequest> = {}): ActionExecutionRequest => ({
    scope,
    run: { runId: "run-1", workspaceId: "workspace-1", automationId: "automation-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "test.action", config: { message: "hello" } },
    ...overrides
  });
  return { executor, request, scope, counter, policyCalls: fixture.calls };
};

const failureOf = (result: ActionExecutionResult): ActionFailure => {
  if (result.status === "succeeded") throw new Error("Expected a failure.");
  return result.failure;
};

void test("TC-0311 registered handler executes once with validated input and trusted context", async () => {
  const f = await setup();
  const result = await f.executor.execute(f.request());

  assert.ok(result.status === "succeeded");
  assert.deepEqual(result.output, { ok: true });
  assert.equal(f.counter.count, 1);
  const context = f.counter.contexts[0];
  assert.ok(context);
  assert.equal(context.workspaceId, "workspace-1");
  assert.equal(context.principal.id, "automation:automation-1");
  assert.match(context.idempotencyKey, /^[a-f0-9]{64}$/);
  assert.equal(result.idempotencyKey, context.idempotencyKey);
  assert.equal(Object.isFrozen(context), true);
  // permission was checked for both the delegated principal and the creator
  assert.equal(f.policyCalls.length, 2);
});

void test("TC-0312 unknown or handler-less action causes no side effect", async () => {
  const f = await setup();
  const unknown = await f.executor.execute(f.request({ action: { type: "does.not.exist", config: {} } }));
  assert.equal(failureOf(unknown).code, "ACTION_UNKNOWN_TYPE");
  assert.equal(unknown.handlerInvoked, false);

  // registered in the action registry but without a handler
  const withoutHandler = await f.executor.execute(f.request({
    action: { type: "notification.send", config: { recipient: { type: "project_lead" }, template: "task_completed" } }
  }));
  assert.equal(failureOf(withoutHandler).code, "ACTION_UNKNOWN_TYPE");
  assert.equal(f.counter.count, 0);
  assert.equal(f.policyCalls.length, 0);

  const noHandlers = await setup({ registerHandler: false });
  assert.equal(failureOf(await noHandlers.executor.execute(noHandlers.request())).code, "ACTION_UNKNOWN_TYPE");
  assert.equal(noHandlers.counter.count, 0);
});

void test("TC-0313 malformed or oversized input is rejected before permission check and handler", async () => {
  const f = await setup();
  for (const config of [
    {},
    { message: "" },
    { message: "ok", extra: true },
    { message: 5 },
    { message: "x".repeat(5_000) }
  ]) {
    const result = await f.executor.execute(f.request({ action: { type: "test.action", config } }));
    assert.equal(failureOf(result).code, "ACTION_INVALID_INPUT");
    assert.equal(failureOf(result).errorClass, "permanent");
    assert.equal(result.handlerInvoked, false);
  }
  assert.equal(f.counter.count, 0);
  assert.equal(f.policyCalls.length, 0);
});

void test("permission denial and policy outage prevent invocation", async () => {
  const denied = policyFixture(false);
  const f = await setup({ policy: denied.policy });
  const result = await f.executor.execute(f.request());
  assert.equal(failureOf(result).code, "ACTION_PERMISSION_DENIED");
  assert.equal(failureOf(result).errorClass, "permanent");
  assert.equal(f.counter.count, 0);

  const outage = await setup({ policy: { authorize: () => Promise.reject(new Error("db down")) } });
  const outageResult = await outage.executor.execute(outage.request());
  assert.equal(failureOf(outageResult).code, "ACTION_POLICY_UNAVAILABLE");
  assert.equal(failureOf(outageResult).errorClass, "transient");
  assert.equal(JSON.stringify(outageResult).includes("db down"), false);
  assert.equal(outage.counter.count, 0);
});

void test("TC-0314 handler timeout is represented as timed_out with the configured limit", async () => {
  let observedSignal: AbortSignal | undefined;
  const f = await setup({
    handler: {
      execute: (_config, context) => {
        observedSignal = context.signal;
        return waitForAbort(context.signal);
      }
    }
  });
  const result = await f.executor.execute(f.request());
  assert.ok(result.status === "timed_out");
  assert.equal(result.timeoutMs, 30);
  assert.equal(result.failure.code, "ACTION_TIMEOUT");
  assert.equal(result.failure.errorClass, "transient"); // idempotent action
  assert.equal(observedSignal?.aborted, true);

  const external = await setup({
    registrationOverrides: { sideEffect: "external", timeoutMs: Object.freeze({ external: 30 }) },
    handler: { execute: (_config, context) => waitForAbort(context.signal) }
  });
  const externalResult = await external.executor.execute(external.request());
  assert.ok(externalResult.status === "timed_out");
  assert.equal(externalResult.failure.errorClass, "ambiguous"); // never blindly repeated
});

void test("handler errors are classified; classifier failure becomes ambiguous; messages are not echoed", async () => {
  const classified = await setup({
    handler: {
      execute: () => Promise.reject(new Error("secret-provider-detail")),
      classifyError: () => "permanent"
    }
  });
  const result = await classified.executor.execute(classified.request());
  assert.equal(failureOf(result).code, "ACTION_HANDLER_ERROR");
  assert.equal(failureOf(result).errorClass, "permanent");
  assert.equal(result.handlerInvoked, true);
  assert.equal(JSON.stringify(result).includes("secret-provider-detail"), false);

  const brokenClassifier = await setup({
    handler: {
      execute: () => { throw new Error("sync failure"); },
      classifyError: () => { throw new Error("classifier bug"); }
    }
  });
  assert.equal(failureOf(await brokenClassifier.executor.execute(brokenClassifier.request())).errorClass, "ambiguous");
});

void test("invalid handler output is rejected and not treated as success", async () => {
  const f = await setup({
    registrationOverrides: { sideEffect: "external" },
    handler: { execute: () => Promise.resolve({ ok: true, leaked: "x" } as TestResult) }
  });
  const result = await f.executor.execute(f.request());
  assert.equal(failureOf(result).code, "ACTION_INVALID_OUTPUT");
  assert.equal(failureOf(result).errorClass, "ambiguous");
});

void test("TC-0315 handler cannot widen workspace scope", async () => {
  // run belonging to another workspace
  const f = await setup();
  const mismatched = await f.executor.execute(f.request({
    run: { runId: "run-1", workspaceId: "workspace-2", automationId: "automation-1" }
  }));
  assert.equal(failureOf(mismatched).code, "ACTION_SCOPE_MISMATCH");

  // forged, non-minted scope
  const forged = { workspaceId: "workspace-1" } as unknown as WorkspaceScope;
  assert.equal(failureOf(await f.executor.execute(f.request({ scope: forged }))).code, "ACTION_SCOPE_MISMATCH");
  assert.equal(f.counter.count, 0);

  // handler-resolved permission resource outside the workspace
  const foreignResource = await setup({
    handler: { resolveResource: () => ({ type: "workspace", id: "workspace-2" }) }
  });
  assert.equal(
    failureOf(await foreignResource.executor.execute(foreignResource.request())).code,
    "ACTION_SCOPE_MISMATCH"
  );
  assert.equal(foreignResource.counter.count, 0);

// Handler cannot mutate the trusted context it receives
const tamper: boolean[] = [];
let capturedWorkspaceId: string | undefined;

const mutating = await setup({
  handler: {
    execute: (_config, context) => {
      capturedWorkspaceId = context.workspaceId;
      tamper.push(Reflect.set(context, "workspaceId", "workspace-2"));
      tamper.push(Reflect.set(context.scope, "workspaceId", "workspace-2"));
      tamper.push(Reflect.set(context.principal, "id", "someone-else"));
      return Promise.resolve({ ok: true });
    }
  }
});

const result = await mutating.executor.execute(mutating.request());
assert.ok(result.status === "succeeded");
assert.deepEqual(tamper, [false, false, false]);
assert.equal(capturedWorkspaceId, "workspace-1");
});

void test("caller abort before or during execution stops the action", async () => {
  const f = await setup();
  const already = new AbortController();
  already.abort();
  const before = await f.executor.execute(f.request({ signal: already.signal }));
  assert.equal(failureOf(before).code, "ACTION_ABORTED");
  assert.equal(before.handlerInvoked, false);

  const running = await setup({
    registrationOverrides: { timeoutMs: Object.freeze({ internal: 5_000 }) },
    handler: { execute: (_config, context) => waitForAbort(context.signal) }
  });
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 10);
  const during = await running.executor.execute(running.request({ signal: controller.signal }));
  assert.equal(failureOf(during).code, "ACTION_ABORTED");
  assert.equal(during.handlerInvoked, true);
});

void test("handler registry fails closed on duplicates and unregistered actions", () => {
  const actions = createActionRegistry([registration()]);
  const handler: ActionHandler<TestConfig, TestResult> = Object.freeze({
    type: "test.action",
    execute: () => Promise.resolve({ ok: true }),
    classifyError: () => "transient" as const
  });
  assert.throws(() => createActionHandlerRegistry([handler, handler], actions), /Duplicate registry type/);
  assert.throws(
    () => createActionHandlerRegistry([{ ...handler, type: "unregistered.action" }], actions),
    /no registered action/
  );
});