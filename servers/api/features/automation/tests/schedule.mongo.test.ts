import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import { occurrenceKey } from "../schedule.occurrence.js";
import {
  createMongoScheduleRepository,
  scheduleCollectionNames
} from "../schedule.repository.js";
import { createScheduleService } from "../schedule.scheduler.js";

const mongoUri = process.env.MONGO_URI;

const assertSafeMongoUri = (uri: string): void => {
  if (process.env.ALLOW_NON_PROD !== "yes") throw new Error("Set ALLOW_NON_PROD=yes before running MongoDB integration tests.");
  const target = new URL(uri);
  if (!["mongodb:", "mongodb+srv:"].includes(target.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)) {
    throw new Error("MongoDB integration tests only run against localhost.");
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (!databaseName.toLowerCase().includes("test")) throw new Error("MongoDB integration tests require a test database name.");
};

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

void test("AE-T-060.1 Mongo schedule cursor, unique occurrence and CAS advance", { skip: !mongoUri }, async () => {
  if (!mongoUri) return;
  assertSafeMongoUri(mongoUri);
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const collectionNames = Object.freeze({
    cursors: `${scheduleCollectionNames.cursors}_${suffix}`,
    occurrences: `${scheduleCollectionNames.occurrences}_${suffix}`
  });
  try {
    const repository = await createMongoScheduleRepository({ database, ownsScope: resolver.ownsScope, collectionNames });
    const scope = await scopeFor("workspace-sched");
    const state = { now: "2026-10-19T00:00:00.000Z" };
    const service = createScheduleService({ repository, ownsScope: resolver.ownsScope, clock: { now: () => state.now } });

    const registered = await service.register(scope, {
      automationId: "auto-1", timezone: "Asia/Karachi", definition: { kind: "daily", time: "09:00" }
    });
    assert.equal(registered.kind, "registered");
    assert.equal((await service.register(scope, {
      automationId: "auto-1", timezone: "Asia/Karachi", definition: { kind: "daily", time: "09:00" }
    })).kind, "exists");

    // concurrent ticks from several scheduler instances: exactly one logical occurrence
    state.now = "2026-10-19T04:00:05.000Z";
    const ticks = await Promise.all(Array.from({ length: 10 }, () => service.tick(scope)));
    assert.equal(ticks.reduce((sum, item) => sum + item.created, 0), 1);
    const stored = await repository.listOccurrences(scope, "auto-1");
    assert.equal(stored.length, 1);
    const [occurrence] = stored;
    assert.ok(occurrence);
    assert.equal(occurrence.occurrenceId, occurrenceKey("workspace-sched", "auto-1", "2026-10-19T04:00:00.000Z"));
    const cursor = await repository.findCursor(scope, "auto-1");
    assert.ok(cursor);
    assert.equal(cursor.nextOccurrenceAt, "2026-10-20T04:00:00.000Z");
    assert.equal(cursor.rev, 1);

    // stale CAS is not success
    assert.equal(await repository.advanceCursor(scope, {
      automationId: "auto-1", expectedRev: 0, expectedNextOccurrenceAt: "2026-10-19T04:00:00.000Z",
      nextOccurrenceAt: "2026-10-20T04:00:00.000Z", now: state.now
    }), "stale");

    // disabled schedule is never due; other workspaces see nothing
    assert.equal(await service.setEnabled(scope, "auto-1", false), "updated");
    state.now = "2026-10-25T00:00:00.000Z";
    assert.equal((await service.tick(scope)).claimed, 0);
    const other = await scopeFor("workspace-sched-other");
    assert.equal(await repository.findCursor(other, "auto-1"), undefined);
    assert.deepEqual(await repository.listOccurrences(other, "auto-1"), []);
    await assert.rejects(repository.findDue(undefined as unknown as WorkspaceScope, state.now, 1), /resolver-minted workspace scope/);

    const indexes = await database.collection(collectionNames.occurrences).listIndexes().toArray();
    assert.ok(indexes.some(({ name }) => name === "schedule_occurrence_unique"));
  } finally {
    await Promise.all([
      database.collection(collectionNames.cursors).drop().catch(() => undefined),
      database.collection(collectionNames.occurrences).drop().catch(() => undefined)
    ]);
    await integration.disconnect();
  }
});