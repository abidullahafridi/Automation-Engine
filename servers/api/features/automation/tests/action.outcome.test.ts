import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createActionHandlerRegistry } from "../action.handler.js";
import { createActionExecutor, type ActionExecutionRequest } from "../action.executor.js";
import {
  createAuditedActionExecutor,
  createInMemoryActionOutcomeStore,
  type ActionOutcomeRecord
} from "../action.outcome.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import { createNotificationSendHandler } from "../notification.action.js";
import { NotificationProviderError } from "../notification.ports.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "creator-1", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const OCCURRED_AT = "2026-10-17T10:00:00.000Z";
const validConfig = { recipient: { type: "project_lead" }, template: "task_completed" };

const setup = async (options: Readonly<{
  sinkFails?: boolean;
  policyAllows?: boolean;
  sendError?: Error;
}> = {}) => {
  const store = createInMemoryActionOutcomeStore(resolver.ownsScope);
  const counters: string[] = [];
  const scope = await scopeFor("workspace-1");

  const handler = createNotificationSendHandler({
    directory: {
      findProjectLeadForRun: () => Promise.resolve({ userId: "lead-1", status: "active" })
    },
    notifications: {
      send: () => options.sendError === undefined
        ? Promise.resolve({ notificationId: "n-1", deduplicated: false })
        : Promise.reject(options.sendError)
    },
    variables: {
      forRun: () => Promise.resolve({ taskTitle: "Secret project plan", actorName: "Sara" })
    }
  });

  const audited = createAuditedActionExecutor({
    executor: createActionExecutor({
      ownsScope: resolver.ownsScope,
      policy: { authorize: () => Promise.resolve(options.policyAllows ?? true) },
      handlers: createActionHandlerRegistry([handler])
    }),
    sink: options.sinkFails === true
      ? { record: () => Promise.reject(new Error("audit store down")) }
      : store.sink,
    metrics: {
      increment: (name, labels) => {
        counters.push(`${name}:${Object.values(labels).join(":")}`);
      }
    },
    clock: { now: () => OCCURRED_AT }
  });

  const request = (overrides: Readonly<{ actionType?: string; config?: unknown }> = {}): ActionExecutionRequest => ({
    scope,
    run: { runId: "run-1", workspaceId: "workspace-1", automationId: "automation-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: overrides.actionType ?? "notification.send", config: overrides.config ?? validConfig }
  });

  return { audited, store, counters, scope, request };
};

const expectedKey = createHash("sha256").update("run-1:0", "utf8").digest("hex");

void test("a successful action leaves one allowlisted, payload-free outcome record and one metric", async () => {
  const t = await setup();
  const result = await t.audited.execute(t.request());
  assert.equal(result.status, "succeeded");

  const records = await t.store.read(t.scope, "run-1");
  assert.equal(records.length, 1);
  const expected: ActionOutcomeRecord = {
    workspaceId: "workspace-1",
    automationId: "automation-1",
    runId: "run-1",
    actionIndex: 0,
    actionType: "notification.send",
    status: "succeeded",
    handlerInvoked: true,
    occurredAt: OCCURRED_AT,
    idempotencyKey: expectedKey,
    result: { notificationId: "n-1", status: "sent" }
  };
  assert.deepEqual(records[0], expected);
  assert.deepEqual(t.counters, ["automation_action_attempts_total:notification.send:succeeded"]);

  const text = JSON.stringify(records);
  for (const secret of ["lead-1", "Secret project plan", "project_lead", "task_completed"]) {
    assert.equal(text.includes(secret), false, `${secret} must not be audited`);
  }
});

void test("a failed action records its stable code and error class without handler messages", async () => {
  const t = await setup({ sendError: new NotificationProviderError("permanent", "provider says lead-1 is bad") });
  const result = await t.audited.execute(t.request());
  assert.equal(result.status, "failed");

  const record = (await t.store.read(t.scope, "run-1"))[0];
  assert.ok(record);
  assert.equal(record.status, "failed");
  assert.equal(record.failureCode, "ACTION_HANDLER_ERROR");
  assert.equal(record.errorClass, "permanent");
  assert.equal(record.handlerInvoked, true);
  assert.equal("result" in record, false);
  assert.equal(JSON.stringify(record).includes("lead-1"), false);
  assert.deepEqual(t.counters, ["automation_action_attempts_total:notification.send:failed"]);
});

void test("permission denial is audited as a failure that never invoked the handler", async () => {
  const t = await setup({ policyAllows: false });
  await t.audited.execute(t.request());

  const record = (await t.store.read(t.scope, "run-1"))[0];
  assert.ok(record);
  assert.equal(record.failureCode, "ACTION_PERMISSION_DENIED");
  assert.equal(record.handlerInvoked, false);
});

void test("unregistered action types never become audit data or metric labels", async () => {
  const t = await setup();
  await t.audited.execute(t.request({ actionType: "evil.<script>-user-supplied", config: {} }));

  const record = (await t.store.read(t.scope, "run-1"))[0];
  assert.ok(record);
  assert.equal(record.actionType, "unknown");
  assert.equal(record.failureCode, "ACTION_UNKNOWN_TYPE");
  assert.deepEqual(t.counters, ["automation_action_attempts_total:unknown:failed"]);
  assert.equal(JSON.stringify(record).includes("evil"), false);
});

void test("an audit store failure never changes the action result and is counted", async () => {
  const t = await setup({ sinkFails: true });
  const result = await t.audited.execute(t.request());

  assert.equal(result.status, "succeeded");
  assert.deepEqual(t.counters, [
    "automation_action_attempts_total:notification.send:succeeded",
    "automation_action_audit_failures_total:notification.send"
  ]);
});

void test("outcome records are workspace-scoped and the sink rejects mismatched or forged scope", async () => {
  const t = await setup();
  await t.audited.execute(t.request());

  const other = await scopeFor("workspace-2");
  assert.deepEqual(await t.store.read(other, "run-1"), []);

  const record = (await t.store.read(t.scope, "run-1"))[0];
  assert.ok(record);
  await assert.rejects(t.store.sink.record(other, record), /must match the trusted scope/);
  const forged = { workspaceId: "workspace-1" } as unknown as WorkspaceScope;
  await assert.rejects(t.store.read(forged, "run-1"), /resolver-minted workspace scope/);
  await assert.rejects(t.store.sink.record(forged, record), /resolver-minted workspace scope/);
});