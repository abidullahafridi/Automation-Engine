import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import {
  createInMemoryInboxRepository,
  createMongoInboxRepository,
  inboxCollectionNames,
  inboxRetentionPolicy
} from "../inbox.repository.js";
import { createPrincipalResolver } from "../automation.ports.js";
import type { InboxMetrics } from "../inbox.repository.js";
import type { WorkspaceScope } from "../automation.ports.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: `user-${workspaceId}`, requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const metricsSpy = (): Readonly<{ metrics: InboxMetrics; duplicateCount: () => number; rejectedCount: () => number }> => {
  let duplicates = 0;
  let rejected = 0;
  return Object.freeze({
    metrics: Object.freeze({
      duplicate: () => { duplicates += 1; },
      rejected: () => { rejected += 1; }
    }),
    duplicateCount: () => duplicates,
    rejectedCount: () => rejected
  });
};

void test("TC-0211 duplicate event follows the unique-event path", async () => {
  const spy = metricsSpy();
  const repository = createInMemoryInboxRepository({ ownsScope: resolver.ownsScope, metrics: spy.metrics });
  const scope = await scopeFor("workspace-inbox");
  const event = { eventId: "event-0211", receivedAt: "2026-10-15T12:00:00.000Z" };

  assert.equal((await repository.record(scope, event)).kind, "accepted");
  const duplicate = await repository.record(scope, event);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(spy.duplicateCount(), 1);
});

void test("TC-0213 duplicate and rejected responses are safe and observable", async () => {
  const spy = metricsSpy();
  const repository = createInMemoryInboxRepository({ ownsScope: resolver.ownsScope, metrics: spy.metrics });
  const firstScope = await scopeFor("workspace-first");
  const secondScope = await scopeFor("workspace-second");
  const event = { eventId: "event-0213", receivedAt: "2026-10-15T12:00:00.000Z" };

  assert.equal((await repository.record(firstScope, event)).kind, "accepted");
  assert.equal((await repository.record(firstScope, event)).kind, "duplicate");
  assert.deepEqual(await repository.record(secondScope, event), {
    kind: "rejected",
    reason: "event-id-conflicts-with-workspace"
  });
  assert.equal(await repository.findByEventId(secondScope, event.eventId), undefined);
  assert.equal(spy.duplicateCount(), 1);
  assert.equal(spy.rejectedCount(), 1);
});

void test("TC-0214 inbox retention exceeds the supported replay window", async () => {
  const repository = createInMemoryInboxRepository({ ownsScope: resolver.ownsScope });
  const scope = await scopeFor("workspace-retention");
  const result = await repository.record(scope, {
    eventId: "event-0214",
    receivedAt: "2026-10-15T00:00:00.000Z"
  });
  assert.ok(result.kind === "accepted");
  const expectedExpiry = new Date(
    new Date("2026-10-15T00:00:00.000Z").getTime() + inboxRetentionPolicy.retentionDays * 86_400_000
  ).toISOString();
  assert.equal(result.event.expiresAt, expectedExpiry);
});

const mongoUri = process.env.MONGO_URI;

const assertSafeMongoUri = (uri: string): void => {
  if (process.env.ALLOW_NON_PROD !== "yes") throw new Error("Set ALLOW_NON_PROD=yes before running MongoDB integration tests.");
  const target = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new Error("MongoDB integration tests only run against localhost.");
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (!databaseName.toLowerCase().includes("test")) throw new Error("MongoDB integration tests require a test database name.");
};

void test("TC-0212 concurrent Mongo ingestion accepts exactly one logical event", { skip: !mongoUri }, async () => {
  if (!mongoUri) return;
  assertSafeMongoUri(mongoUri);
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("MongoDB integration did not expose its connected database.");
  const collectionNames = Object.freeze({ records: `${inboxCollectionNames.records}_${randomUUID().replaceAll("-", "")}` });
  try {
    const repository = await createMongoInboxRepository({
      database,
      ownsScope: resolver.ownsScope,
      collectionNames
    });
    const scope = await scopeFor("workspace-race");
    const results = await Promise.all(Array.from({ length: 20 }, () => repository.record(scope, {
      eventId: "event-0212-race",
      receivedAt: "2026-10-15T12:00:00.000Z"
    })));
    assert.equal(results.filter((result) => result.kind === "accepted").length, 1);
    assert.equal(results.filter((result) => result.kind === "duplicate").length, 19);
    assert.equal(await database.collection(collectionNames.records).countDocuments({ eventId: "event-0212-race" }), 1);
    const indexes = await database.collection(collectionNames.records).listIndexes().toArray();
    assert.ok(indexes.some(({ name }) => name === "inbox_event_id_unique"));
    assert.ok(indexes.some(({ name }) => name === "inbox_retention_ttl"));
  } finally {
    await database.collection(collectionNames.records).drop().catch(() => undefined);
    await integration.disconnect();
  }
});
