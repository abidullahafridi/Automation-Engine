import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createActionHandlerRegistry } from "../action.handler.js";
import {
  createActionExecutor,
  type ActionExecutionResult,
  type ActionFailure
} from "../action.executor.js";
import {
  createPrincipalResolver,
  type WorkspaceScope
} from "../automation.ports.js";
import { createNotificationSendHandler } from "../notification.action.js";
import {
  NotificationProviderError,
  type NotificationSendRequest,
  type NotificationSendResult,
  type TemplateVariables,
  type WorkspaceMember
} from "../notification.ports.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "creator-1", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const validConfig = { recipient: { type: "project_lead" }, template: "task_completed" };

const setup = (options: Readonly<{
  leads?: Readonly<Record<string, WorkspaceMember>>; // key: `${workspaceId}:${runId}`
  variables?: TemplateVariables;
  sendError?: Error;
  hang?: boolean;
  policyAllows?: boolean;
}> = {}) => {
  const leads = options.leads ?? { "workspace-1:run-1": { userId: "lead-1", status: "active" } };
  const store = new Map<string, { id: string; request: NotificationSendRequest }>();
  const signals: AbortSignal[] = [];
  const policyCalls: string[] = [];
  let sendCalls = 0;

  const handler = createNotificationSendHandler({
    directory: {
      findProjectLeadForRun: (workspaceId, runId) =>
        Promise.resolve(leads[`${workspaceId}:${runId}`] ?? null)
    },
    notifications: {
      send: (request, sendOptions) => {
        sendCalls += 1;
        signals.push(sendOptions.signal);
        if (options.hang === true) {
          return new Promise<NotificationSendResult>((_resolve, reject) => {
            sendOptions.signal.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
          });
        }
        if (options.sendError) return Promise.reject(options.sendError);
        const existing = store.get(request.idempotencyKey);
        if (existing) return Promise.resolve({ notificationId: existing.id, deduplicated: true });
        const id = `n-${String(store.size + 1)}`;
        store.set(request.idempotencyKey, { id, request });
        return Promise.resolve({ notificationId: id, deduplicated: false });
      }
    },
    variables: {
      forRun: () => Promise.resolve(options.variables ?? { taskTitle: "Ship v1", actorName: "Sara" })
    }
  });

  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: {
      authorize: (principal, permission, resource) => {
        policyCalls.push(`${principal.id}:${permission}:${resource.type}:${resource.id}`);
        return Promise.resolve(options.policyAllows ?? true);
      }
    },
    handlers: createActionHandlerRegistry([handler])
  });

  const run = async (overrides: Readonly<{
    workspaceId?: string;
    config?: unknown;
    signal?: AbortSignal;
  }> = {}): Promise<ActionExecutionResult> => {
    const workspaceId = overrides.workspaceId ?? "workspace-1";
    return executor.execute({
      scope: await scopeFor(workspaceId),
      run: { runId: "run-1", workspaceId, automationId: "automation-1" },
      creatorId: "creator-1",
      actionIndex: 0,
      action: { type: "notification.send", config: overrides.config ?? validConfig },
      ...(overrides.signal === undefined ? {} : { signal: overrides.signal })
    });
  };

  return { run, store, signals, policyCalls, calls: () => sendCalls };
};

const failureOf = (result: ActionExecutionResult): ActionFailure => {
  if (result.status === "succeeded") throw new Error("Expected a failed result.");
  return result.failure;
};

void test("TC-0316 valid recipient receives exactly one logical notification", async () => {
  const t = setup();
  const first = await t.run();
  const second = await t.run(); // redelivery / retry of the same run action

  assert.ok(first.status === "succeeded");
  assert.ok(second.status === "succeeded");
  assert.deepEqual(first.output, { notificationId: "n-1", status: "sent" });
  assert.deepEqual(second.output, { notificationId: "n-1", status: "already_sent" });
  assert.equal(t.store.size, 1);
  // the provider received the executor's signal, which stays live on success
  assert.equal(t.signals[0]?.aborted, false);
});

void test("idempotency key sent to the notification service is the executor's sha256(runId:actionIndex)", async () => {
  const t = setup();
  await t.run();
  const expected = createHash("sha256").update("run-1:0", "utf8").digest("hex");
  assert.ok(t.store.has(expected));
});

void test("TC-0317 cross-workspace run never reaches another workspace's recipient", async () => {
  // The lead exists only in workspace-1. The same run id under workspace-2 finds nothing.
  const t = setup();
  const result = await t.run({ workspaceId: "workspace-2" });

  assert.equal(result.status, "failed");
  assert.equal(failureOf(result).code, "ACTION_HANDLER_ERROR");
  assert.equal(failureOf(result).errorClass, "permanent");
  assert.equal(t.calls(), 0);
  assert.equal(JSON.stringify(result).includes("lead-1"), false);
});

void test("TC-0318 disabled or deleted recipient fails permanently and nothing is sent", async () => {
  for (const status of ["disabled", "deleted"] as const) {
    const t = setup({ leads: { "workspace-1:run-1": { userId: "lead-1", status } } });
    const result = await t.run();
    assert.equal(result.status, "failed");
    assert.equal(failureOf(result).errorClass, "permanent");
    assert.equal(result.handlerInvoked, true);
    assert.equal(t.calls(), 0);
  }
});

void test("TC-0319 transient provider failure is retryable, permanent is not, unknown is retry-safe", async () => {
  const transient = setup({ sendError: new NotificationProviderError("transient", "provider down") });
  assert.equal(failureOf(await transient.run()).errorClass, "transient");

  const permanent = setup({ sendError: new NotificationProviderError("permanent", "rejected") });
  assert.equal(failureOf(await permanent.run()).errorClass, "permanent");

  const unknown = setup({ sendError: new Error("boom") });
  assert.equal(failureOf(await unknown.run()).errorClass, "transient");
});

void test("config outside the registered schema is rejected before the handler runs", async () => {
  const t = setup();
  for (const config of [
    { recipient: { type: "user", userId: "u-1" }, template: "task_completed" },
    { recipient: { type: "project_lead" }, template: "task_assigned" },
    { recipient: { type: "project_lead" }, template: "task_completed", extra: true }
  ]) {
    const result = await t.run({ config });
    assert.equal(failureOf(result).code, "ACTION_INVALID_INPUT");
    assert.equal(result.handlerInvoked, false);
  }
  assert.equal(t.calls(), 0);
  assert.equal(t.policyCalls.length, 0);
});

void test("permission denial blocks the action before any notification is sent", async () => {
  const t = setup({ policyAllows: false });
  const result = await t.run();
  assert.equal(failureOf(result).code, "ACTION_PERMISSION_DENIED");
  assert.equal(result.handlerInvoked, false);
  assert.equal(t.calls(), 0);

  const allowed = setup();
  await allowed.run();
  assert.deepEqual(allowed.policyCalls, [
    "automation:automation-1:notification.send:workspace:workspace-1",
    "creator-1:notification.send:workspace:workspace-1"
  ]);
});

void test("template values are HTML-escaped; missing variables fail permanently without sending", async () => {
  const escaped = setup({ variables: { taskTitle: "<b>x</b>", actorName: "S" } });
  await escaped.run();
  const saved = [...escaped.store.values()][0];
  assert.ok(saved);
  assert.equal(saved.request.title.includes("<b>"), false);
  assert.ok(saved.request.title.includes("&lt;b&gt;"));
  assert.equal(saved.request.workspaceId, "workspace-1");

  const missing = setup({ variables: { taskTitle: "only" } });
  const result = await missing.run();
  assert.equal(failureOf(result).errorClass, "permanent");
  assert.equal(missing.calls(), 0);
});

void test("results and failures never expose the recipient id or message content", async () => {
  const ok = setup();
  const success = await ok.run();
  assert.equal(JSON.stringify(success).includes("lead-1"), false);
  assert.equal(JSON.stringify(success).includes("Ship v1"), false);

  const failing = setup({ sendError: new NotificationProviderError("permanent", "lead-1 rejected") });
  assert.equal(JSON.stringify(await failing.run()).includes("lead-1"), false);
});

void test("caller abort during the send stops the action and is retry-safe", async () => {
  const t = setup({ hang: true });
  const controller = new AbortController();
  setTimeout(() => { controller.abort(); }, 10);
  const result = await t.run({ signal: controller.signal });

  assert.equal(failureOf(result).code, "ACTION_ABORTED");
  assert.equal(failureOf(result).errorClass, "transient"); // internal-idempotent
  assert.equal(t.signals[0]?.aborted, true);
});
