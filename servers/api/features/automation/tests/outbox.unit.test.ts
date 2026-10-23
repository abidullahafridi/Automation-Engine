import assert from "node:assert/strict";
import test from "node:test";
import {
  createInMemoryOutboxRepository,
  outboxRepositoryMethodNames
} from "../outbox.repository.js";
import { createOutboxRelay } from "../outbox.relay.js";
import {
  writeWithTransactionalOutbox
} from "../outbox.transactional.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { TransactionRunner } from "../../../integrations/index.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({
    credential: `user-${workspaceId}`,
    requestedWorkspaceId: workspaceId
  });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

void test("tenant matrix covers every outbox repository method and rejects missing/forged scope", async () => {
  const { repository } = createInMemoryOutboxRepository(resolver.ownsScope);
  assert.deepEqual(
    Object.keys(repository).sort(),
    [...outboxRepositoryMethodNames].sort()
  );

  const ownScope = await scopeFor("workspace-a");
  const otherScope = await scopeFor("workspace-b");

  await repository.insertPending(
    ownScope,
    {
      outboxId: "outbox-1",
      workspaceId: "workspace-a",
      eventType: "task.status_changed",
      payload: { status: "done" },
      createdAt: "2026-10-15T12:00:00.000Z"
    },
    undefined
  );

  const missingScopeArgs: Readonly<Record<(typeof outboxRepositoryMethodNames)[number], readonly unknown[]>> = {
    insertPending: [
      {
        outboxId: "outbox-missing",
        workspaceId: "workspace-a",
        eventType: "task.status_changed",
        payload: {},
        createdAt: "2026-10-15T12:00:00.000Z"
      },
      undefined
    ],
    claimNextPending: ["2026-10-15T12:00:00.000Z", 30_000],
    markPublished: ["outbox-1", "2026-10-15T12:01:00.000Z"],
    countByStatus: ["pending"],
    findById: ["outbox-1"],
    getOldestPendingAgeMs: ["2026-10-15T12:01:00.000Z"]
  };

  for (const methodName of outboxRepositoryMethodNames) {
    const invocation: unknown = Reflect.apply(
      repository[methodName],
      repository,
      [undefined, ...missingScopeArgs[methodName]]
    );
    if (!(invocation instanceof Promise)) throw new Error(`${methodName} must return a promise.`);
    await assert.rejects(invocation, /resolver-minted workspace scope is required/);

    const forgedScope = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
    const forgedInvocation: unknown = Reflect.apply(
      repository[methodName],
      repository,
      [forgedScope, ...missingScopeArgs[methodName]]
    );
    if (!(forgedInvocation instanceof Promise)) throw new Error(`${methodName} must return a promise.`);
    await assert.rejects(forgedInvocation, /resolver-minted workspace scope is required/);
  }

  // Cross-tenant isolation verification
  assert.equal(await repository.findById(otherScope, "outbox-1"), undefined);
  assert.equal(await repository.markPublished(otherScope, "outbox-1", "2026-10-15T12:01:00.000Z"), "not-found");
  assert.equal(await repository.countByStatus(otherScope, "pending"), 0);
  assert.equal(await repository.getOldestPendingAgeMs(otherScope, "2026-10-15T12:01:00.000Z"), undefined);

  assert.ok(await repository.findById(ownScope, "outbox-1"));
  assert.equal(await repository.countByStatus(ownScope, "pending"), 1);
  assert.equal(await repository.getOldestPendingAgeMs(ownScope, "2026-10-15T12:01:00.000Z"), 60_000);
});

void test("outbox repository oldest pending age calculation and empty state", async () => {
  const { repository } = createInMemoryOutboxRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-age");

  assert.equal(await repository.getOldestPendingAgeMs(scope, "2026-10-15T12:00:00.000Z"), undefined);

  await repository.insertPending(
    scope,
    {
      outboxId: "oldest",
      workspaceId: "workspace-age",
      eventType: "task.status_changed",
      payload: {},
      createdAt: "2026-10-15T12:00:00.000Z"
    },
    undefined
  );

  await repository.insertPending(
    scope,
    {
      outboxId: "newer",
      workspaceId: "workspace-age",
      eventType: "task.status_changed",
      payload: {},
      createdAt: "2026-10-15T12:00:30.000Z"
    },
    undefined
  );

  const age = await repository.getOldestPendingAgeMs(scope, "2026-10-15T12:01:00.000Z");
  assert.equal(age, 60_000);

  // Once published, oldest pending moves to the newer one
  await repository.markPublished(scope, "oldest", "2026-10-15T12:01:00.000Z");
  const newerAge = await repository.getOldestPendingAgeMs(scope, "2026-10-15T12:01:00.000Z");
  assert.equal(newerAge, 30_000);

  await repository.markPublished(scope, "newer", "2026-10-15T12:01:00.000Z");
  assert.equal(await repository.getOldestPendingAgeMs(scope, "2026-10-15T12:01:00.000Z"), undefined);
});

void test("outbox relay respects feature flag and does not process when disabled", async () => {
  const { repository } = createInMemoryOutboxRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-flag");

  await repository.insertPending(
    scope,
    {
      outboxId: "msg-1",
      workspaceId: "workspace-flag",
      eventType: "task.status_changed",
      payload: {},
      createdAt: "2026-10-15T12:00:00.000Z"
    },
    undefined
  );

  const disabledRelay = createOutboxRelay({ outboxRepository: repository, enabled: false });
  let handlerCalled = false;
  const result = await disabledRelay.processNextBatch(
    scope,
    "2026-10-15T12:00:05.000Z",
    () => {
      handlerCalled = true;
      return Promise.resolve({ ok: true });
    }
  );

  assert.equal(result.processed, 0);
  assert.equal(result.published, 0);
  assert.equal(handlerCalled, false);
  assert.equal(await repository.countByStatus(scope, "pending"), 1);
});

void test("outbox transactional write service wraps operation using TransactionRunner", async () => {
  const { repository } = createInMemoryOutboxRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-tx");

  let executedTransaction = false;
  const mockRunner: TransactionRunner = {
    runTransaction: async (operation) => {
      executedTransaction = true;
      const res = await operation(undefined);
      return { ok: true, value: res };
    }
  };

  const domainCall: string[] = [];
  const result = await writeWithTransactionalOutbox({
    scope,
    outboxEvent: {
      outboxId: "event-tx-1",
      eventType: "task.status_changed",
      payload: { status: "in_progress" },
      createdAt: "2026-10-15T12:00:00.000Z"
    },
    domainMutation: () => {
      domainCall.push("mutation-executed");
      return Promise.resolve({ taskId: "task-1", status: "in_progress" });
    },
    outboxRepository: repository,
    transactionRunner: mockRunner
  });

  assert.equal(executedTransaction, true);
  assert.ok(result.ok);
  assert.deepEqual(result.domainResult, { taskId: "task-1", status: "in_progress" });
  assert.deepEqual(domainCall, ["mutation-executed"]);
  assert.ok(await repository.findById(scope, "event-tx-1"));
});

