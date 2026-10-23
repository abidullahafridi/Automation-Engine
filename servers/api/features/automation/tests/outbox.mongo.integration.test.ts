import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { Logger } from "@workspace/logging";
import {
  createMongoDbIntegration,
  createMongooseTransactionRunner,
  getTransactionAbortCount,
  resetTransactionAbortCount
} from "../../../integrations/index.js";
import {
  createMongoOutboxRepository,
  outboxCollectionNames
} from "../outbox.repository.js";
import { createOutboxRelay } from "../outbox.relay.js";
import { writeWithTransactionalOutbox } from "../outbox.transactional.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";

const mongoUri = process.env.MONGO_URI;

const isReplicaSetUri = (uri: string | undefined): boolean => {
  if (!uri) return false;
  try {
    const parsed = new URL(uri);
    return parsed.searchParams.get("replicaSet") !== null;
  } catch {
    return false;
  }
};

const canRunReplicaSetTests = Boolean(
  mongoUri &&
  process.env.ALLOW_NON_PROD === "yes" &&
  isReplicaSetUri(mongoUri)
);

const skipReason = !mongoUri
  ? "MONGO_URI is not set; integration tests NOT RUN."
  : process.env.ALLOW_NON_PROD !== "yes"
    ? "ALLOW_NON_PROD=yes is required; integration tests NOT RUN."
    : !isReplicaSetUri(mongoUri)
      ? "MONGO_URI does not configure a replicaSet (transactions unsupported); integration tests NOT RUN."
      : undefined;

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

void test("Outbox MongoDB replica set integration suite (TC-0204 through TC-0207)", {
  skip: canRunReplicaSetTests ? false : (skipReason ?? "Integration tests NOT RUN")
}, async (suiteContext) => {
  if (!mongoUri) return;

  const logger: Logger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };

  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("MongoDB integration did not expose its connected database.");

  const suffix = randomUUID().replaceAll("-", "");
  const collectionNames = Object.freeze({
    records: `${outboxCollectionNames.records}_${suffix}`
  });
  const domainCollectionName = `test_domain_tasks_${suffix}`;
  const domainCollection = database.collection<{ taskId: string; workspaceId: string; status: string }>(
    domainCollectionName
  );

  const repository = await createMongoOutboxRepository({
    database,
    collectionNames,
    ownsScope: resolver.ownsScope
  });
  const transactionRunner = createMongooseTransactionRunner();

  const ownScope = await scopeFor("workspace-replica-a");

  suiteContext.after(async () => {
    try {
      await database.collection(collectionNames.records).drop().catch(() => undefined);
      await domainCollection.drop().catch(() => undefined);
    } finally {
      await integration.disconnect();
    }
  });

  await suiteContext.test("TC-0204 mutation and outbox record commit together in transaction", async () => {
    const outboxId = `outbox-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;

    const result = await writeWithTransactionalOutbox({
      scope: ownScope,
      outboxEvent: {
        outboxId,
        eventType: "task.status_changed",
        payload: { taskId, status: "completed" },
        createdAt: new Date().toISOString()
      },
      domainMutation: async (session) => {
        await domainCollection.insertOne(
          { taskId, workspaceId: ownScope.workspaceId, status: "completed" },
          { session: session as never }
        );
        return { taskId, committed: true };
      },
      outboxRepository: repository,
      transactionRunner
    });

    assert.ok(result.ok);
    assert.deepEqual(result.domainResult, { taskId, committed: true });

    // Verify both are persisted
    const storedTask = await domainCollection.findOne({ taskId });
    assert.ok(storedTask, "Domain task must be committed");
    assert.equal(storedTask.status, "completed");

    const storedOutbox = await repository.findById(ownScope, outboxId);
    assert.ok(storedOutbox, "Outbox record must be committed");
    assert.equal(storedOutbox.status, "pending");
  });

  await suiteContext.test("TC-0205 rollback leaves neither successful mutation nor outbox event", async () => {
    resetTransactionAbortCount();
    const outboxId = `outbox-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const result = await writeWithTransactionalOutbox({
      scope: ownScope,
      outboxEvent: {
        outboxId,
        eventType: "task.status_changed",
        payload: { taskId, status: "failed_attempt" },
        createdAt: new Date().toISOString()
      },
      domainMutation: async (session) => {
        await domainCollection.insertOne(
          { taskId, workspaceId: ownScope.workspaceId, status: "failed_attempt" },
          { session: session as never }
        );
        throw new Error("Simulated domain business rule violation after insert");
      },
      outboxRepository: repository,
      transactionRunner
    });

    assert.equal(result.ok, false);
    assert.ok(getTransactionAbortCount() >= 1, "Abort counter must be incremented on rollback");

    // Neither document must be persisted
    const storedTask = await domainCollection.findOne({ taskId });
    assert.equal(storedTask, null, "Domain mutation must be rolled back");

    const storedOutbox = await repository.findById(ownScope, outboxId);
    assert.equal(storedOutbox, undefined, "Outbox record must not be persisted on rollback");
  });



  
  await suiteContext.test("unique index rejects duplicate eventId within same or subsequent transactions", async () => {
    const outboxId = `outbox-dup-${randomUUID()}`;
    const taskId1 = `task-1-${randomUUID()}`;
    const taskId2 = `task-2-${randomUUID()}`;

    const first = await writeWithTransactionalOutbox({
      scope: ownScope,
      outboxEvent: {
        outboxId,
        eventType: "task.status_changed",
        payload: { taskId: taskId1 },
        createdAt: new Date().toISOString()
      },
      domainMutation: async (session) => {
        await domainCollection.insertOne(
          { taskId: taskId1, workspaceId: ownScope.workspaceId, status: "first" },
          { session: session as never }
        );
        return { ok: true };
      },
      outboxRepository: repository,
      transactionRunner
    });
    assert.equal(first.ok, true);

    const second = await writeWithTransactionalOutbox({
      scope: ownScope,
      outboxEvent: {
        outboxId,
        eventType: "task.status_changed",
        payload: { taskId: taskId2 },
        createdAt: new Date().toISOString()
      },
      domainMutation: async (session) => {
        await domainCollection.insertOne(
          { taskId: taskId2, workspaceId: ownScope.workspaceId, status: "second" },
          { session: session as never }
        );
        return { ok: true };
      },
      outboxRepository: repository,
      transactionRunner
    });

        // A duplicate eventId aborts the WHOLE transaction (MongoDB cannot commit after a duplicate-key error).
    assert.equal(second.ok, false, `expected the duplicate to abort, got ${JSON.stringify(second)}`);
    const existing = await repository.findById(ownScope, outboxId);
    assert.ok(existing);
    assert.deepEqual(existing.payload, { taskId: taskId1 });
    assert.equal(await domainCollection.countDocuments({ taskId: taskId2 }), 0, "second domain write must be rolled back");
  });

  await suiteContext.test("TC-0206 relay crash after publish yields tolerated duplicate and TC-0207 stale relay lease is recovered", async () => {
    // Keep relay assertions independent from pending records created by the
    // transactional cases above. The relay deliberately claims the oldest
    // eligible record in a workspace.
    const relayScope = await scopeFor(`workspace-replica-relay-${suffix}`);
    const outboxId = `outbox-relay-${randomUUID()}`;
    const now = new Date("2026-10-15T12:00:00.000Z");

    await repository.insertPending(
      relayScope,
      {
        outboxId,
        workspaceId: relayScope.workspaceId,
        eventType: "task.status_changed",
        payload: { data: "sample" },
        createdAt: now.toISOString()
      },
      undefined
    );

    // Relay 1 claims the record with a short lease (1,000ms)
    const relay = createOutboxRelay({ outboxRepository: repository, enabled: true });
    const publishedEvents: string[] = [];

    // Simulate Relay 1: publishes downstream but crashes before calling markPublished
    await relay.processNextBatch(
      relayScope,
      now.toISOString(),
      (record) => {
        publishedEvents.push(record.outboxId);
        // Crash / abort before marking published:
        return Promise.reject(new Error("Relay crashed after publishing before database ack!"));
      },
      { batchSize: 1, leaseDurationMs: 1_000 }
    );

    assert.equal(publishedEvents.length, 1);
    const recordAfterCrash = await repository.findById(relayScope, outboxId);
    assert.ok(recordAfterCrash);
    assert.equal(recordAfterCrash.status, "pending");
    assert.ok(recordAfterCrash.leaseExpiresAt !== undefined);

    // While lease has not expired (e.g. at now + 500ms), claiming returns none
    const duringLease = new Date(now.getTime() + 500).toISOString();
    const claimDuringLease = await repository.claimNextPending(relayScope, duringLease, 5_000);
    assert.equal(claimDuringLease.kind, "none", "Active lease must prevent concurrent claim");

    // TC-0207: Stale relay lease recovery (at now + 1,500ms, lease has expired)
    const afterLeaseExpiry = new Date(now.getTime() + 1_500).toISOString();
    const secondRelayBatch = await relay.processNextBatch(
      relayScope,
      afterLeaseExpiry,
      (record) => {
        publishedEvents.push(record.outboxId);
        return Promise.resolve({ ok: true });
      },
      { batchSize: 1, leaseDurationMs: 30_000 }
    );

    assert.equal(secondRelayBatch.processed, 1);
    assert.equal(secondRelayBatch.published, 1);
    assert.equal(publishedEvents.length, 2, "Second delivery occurred after relay crash (tolerated duplicate)");

    // After successful recovery, record is marked published
    const finalRecord = await repository.findById(relayScope, outboxId);
    assert.ok(finalRecord);
    assert.equal(finalRecord.status, "published");
    assert.ok(finalRecord.publishedAt !== undefined);

    // Third claim returns none because status is published
    const thirdClaim = await repository.claimNextPending(relayScope, afterLeaseExpiry, 30_000);
    assert.equal(thirdClaim.kind, "none");
  });

  await suiteContext.test("observability: oldest pending age calculation on Mongo repository", async () => {
    // The metric is workspace-scoped, so use a clean workspace to assert the
    // exact age of the two records inserted by this case.
    const observabilityScope = await scopeFor(`workspace-replica-observability-${suffix}`);
    const outboxId1 = `outbox-age-1-${randomUUID()}`;
    const outboxId2 = `outbox-age-2-${randomUUID()}`;

    const t0 = new Date("2026-10-15T12:00:00.000Z");
    const t1 = new Date("2026-10-15T12:00:30.000Z");

    await repository.insertPending(
      observabilityScope,
      {
        outboxId: outboxId1,
        workspaceId: observabilityScope.workspaceId,
        eventType: "task.status_changed",
        payload: {},
        createdAt: t0.toISOString()
      },
      undefined
    );

    await repository.insertPending(
      observabilityScope,
      {
        outboxId: outboxId2,
        workspaceId: observabilityScope.workspaceId,
        eventType: "task.status_changed",
        payload: {},
        createdAt: t1.toISOString()
      },
      undefined
    );

    const nowCheck = new Date("2026-10-15T12:01:00.000Z").toISOString();
    const age = await repository.getOldestPendingAgeMs(observabilityScope, nowCheck);
    assert.equal(age, 60_000);

    // Mark oldest published
    await repository.markPublished(observabilityScope, outboxId1, nowCheck);
    const ageAfterOne = await repository.getOldestPendingAgeMs(observabilityScope, nowCheck);
    assert.equal(ageAfterOne, 30_000);

    // Clean up
    await repository.markPublished(observabilityScope, outboxId2, nowCheck);
  });
});

