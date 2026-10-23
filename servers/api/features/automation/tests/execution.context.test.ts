import assert from "node:assert/strict";
import test from "node:test";
import { createActionExecutor } from "../action.executor.js";
import { createActionHandlerRegistry } from "../action.handler.js";
import {
  authorizeAutomationExecution,
  createPrincipalResolver,
  type PolicyPort,
  type WorkspaceScope
} from "../automation.ports.js";
import {
  createInMemoryAutomationRepository,
  type AutomationHeader,
  type AutomationRepository
} from "../automation.repository.js";
import {
  createDenyAllCreatorStandingPort,
  createExecutionContextResolver,
  toActionExecutionRequest,
  type CreatorStanding,
  type CreatorStandingPort,
  type ExecutionContextResult
} from "../execution.context.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const header = (
  workspaceId: string,
  automationId: string,
  status: AutomationHeader["status"] = "enabled"
): AutomationHeader => Object.freeze({
  automationId,
  workspaceId,
  name: "Automation",
  createdBy: "creator-1",
  rev: 0,
  status,
  draft: {},
  hasDraft: true,
  currentVersion: 1,
  createdAt: "2026-10-15T12:00:00.000Z",
  updatedAt: "2026-10-15T12:00:00.000Z"
});

const fakeAutomations = (
  items: readonly AutomationHeader[],
  calls: { count: number }
): Pick<AutomationRepository, "findById"> => Object.freeze({
  findById: (scope, automationId) => {
    calls.count += 1;
    return Promise.resolve(items.find((item) =>
      item.workspaceId === scope.workspaceId && item.automationId === automationId));
  }
});

const standing = (value: CreatorStanding, calls: { count: number }): CreatorStandingPort =>
  Object.freeze({
    lookup: () => {
      calls.count += 1;
      return Promise.resolve(value);
    }
  });

const deniedOf = (result: ExecutionContextResult) => {
  if (result.kind !== "denied") throw new Error("Expected a denial.");
  return result;
};

const run = (workspaceId: string, automationId = "auto-1") =>
  Object.freeze({ runId: "run-1", workspaceId, automationId });

void test("TC-0401 missing or forged scope prevents any data access", async () => {
  const automationCalls = { count: 0 };
  const standingCalls = { count: 0 };
  const context = createExecutionContextResolver({
    ownsScope: resolver.ownsScope,
    automations: fakeAutomations([header("workspace-a", "auto-1")], automationCalls),
    creators: standing("member", standingCalls)
  });
  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  const missing = undefined as unknown as WorkspaceScope;

  assert.equal(deniedOf(await context.resolve(forged, run("workspace-a"))).code, "SCOPE_MISSING");
  assert.equal(deniedOf(await context.resolve(missing, run("workspace-a"))).code, "SCOPE_MISSING");
  assert.equal(automationCalls.count, 0);
  assert.equal(standingCalls.count, 0);

  const store = createInMemoryAutomationRepository(resolver.ownsScope);
  await assert.rejects(store.repository.findById(forged, "auto-1"));
  await assert.rejects(store.repository.list(missing, { after: undefined, limit: 10 }));
  assert.equal(store.driverCallCount(), 0);
});

void test("TC-0402 workspace A cannot execute or mutate workspace B work", async () => {
  const scopeA = await scopeFor("workspace-a");
  const automationCalls = { count: 0 };
  const standingCalls = { count: 0 };
  const context = createExecutionContextResolver({
    ownsScope: resolver.ownsScope,
    automations: fakeAutomations([header("workspace-b", "auto-b")], automationCalls),
    creators: standing("member", standingCalls)
  });

  // Run claims workspace B while the trusted scope is A.
  assert.equal(deniedOf(await context.resolve(scopeA, run("workspace-b", "auto-b"))).code, "SCOPE_MISMATCH");
  assert.equal(automationCalls.count, 0);

  // Run in A pointing at an automation that only exists in B: not found, no standing lookup.
  assert.equal(deniedOf(await context.resolve(scopeA, run("workspace-a", "auto-b"))).code, "AUTOMATION_NOT_FOUND");
  assert.equal(standingCalls.count, 0);

  // The executor itself refuses a mismatched run before registry, policy or handler.
  let policyCalls = 0;
  const executor = createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => { policyCalls += 1; return Promise.resolve(true); } },
    handlers: createActionHandlerRegistry([])
  });
  const result = await executor.execute({
    scope: scopeA,
    run: run("workspace-b", "auto-b"),
    creatorId: "creator-1",
    actionIndex: 0,
    action: { type: "notification.send", config: {} }
  });
  if (result.status !== "failed") throw new Error("Expected a failed result.");
  assert.equal(result.failure.code, "ACTION_SCOPE_MISMATCH");
  assert.equal(result.handlerInvoked, false);
  assert.equal(policyCalls, 0);
});

void test("TC-0403 revoked access blocks execution", async () => {
  const scopeA = await scopeFor("workspace-a");
  const calls = { count: 0 };
  const build = (value: CreatorStanding, status: AutomationHeader["status"] = "enabled") =>
    createExecutionContextResolver({
      ownsScope: resolver.ownsScope,
      automations: fakeAutomations([header("workspace-a", "auto-1", status)], calls),
      creators: standing(value, calls)
    });

  const lost = deniedOf(await build("removed").resolve(scopeA, run("workspace-a")));
  assert.equal(lost.code, "OWNER_ACCESS_LOST");
  assert.equal(lost.retryable, false);
  assert.equal(lost.pauseAutomation, true);

  for (const status of ["paused", "disabled", "archived", "draft"] as const) {
    assert.equal(deniedOf(await build("member", status).resolve(scopeA, run("workspace-a"))).code, "AUTOMATION_NOT_ENABLED");
  }

  // Action-level: creator permission revoked after authoring => denied, even if the delegate is allowed.
  const revokedCreator: PolicyPort = {
    authorize: (principal) => Promise.resolve(principal.type === "automation")
  };
  assert.equal(await authorizeAutomationExecution(
    revokedCreator, "auto-1", "creator-1", "task.update", { type: "task", id: "task-1" }
  ), false);
});

void test("TC-0404 guest, API-key and unknown creators follow the explicit policy", async () => {
  const scopeA = await scopeFor("workspace-a");
  const calls = { count: 0 };
  const build = (creators: CreatorStandingPort) => createExecutionContextResolver({
    ownsScope: resolver.ownsScope,
    automations: fakeAutomations([header("workspace-a", "auto-1")], calls),
    creators
  });

  assert.equal(deniedOf(await build(standing("guest", calls)).resolve(scopeA, run("workspace-a"))).code, "OWNER_ROLE_NOT_ALLOWED");
  assert.equal(deniedOf(await build(standing("api-key", calls)).resolve(scopeA, run("workspace-a"))).code, "OWNER_ROLE_NOT_ALLOWED");
  assert.equal(deniedOf(await build(createDenyAllCreatorStandingPort()).resolve(scopeA, run("workspace-a"))).code, "OWNER_ACCESS_LOST");

  const unavailable = deniedOf(await build({
    lookup: () => Promise.reject(new Error("platform down"))
  }).resolve(scopeA, run("workspace-a")));
  assert.equal(unavailable.code, "STANDING_UNAVAILABLE");
  assert.equal(unavailable.retryable, true);

  const ready = await build(standing("member", calls)).resolve(scopeA, run("workspace-a"));
  if (ready.kind !== "ready") throw new Error("Member creator must be allowed.");
  assert.equal(ready.context.principal.id, "automation:auto-1");
  assert.equal(ready.context.principal.creatorId, "creator-1");

  const request = toActionExecutionRequest(ready.context, {
    actionIndex: 0,
    action: { type: "notification.send", config: {} }
  });
  assert.equal(request.scope, ready.context.scope);
  assert.equal(request.run.workspaceId, "workspace-a");
  assert.equal("signal" in request, false);
});