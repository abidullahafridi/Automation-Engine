import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  createMongoRunHistoryRepository,
  runHistoryRepositoryMethodNames
} from "../run.history.repository.js";
import {
  createMongoRunRepository,
  runCollectionNames,
  type StoredRun
} from "../run.repository.js";

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
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const T0 = "2026-10-18T10:00:00.000Z";
const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1_000).toISOString();
const makeRun = (
  runId: string,
  workspaceId: string,
  createdAt: string,
  automationId = "automation-1"
): StoredRun => Object.freeze({
  runId,
  eventId: `event-${runId}`,
  workspaceId,
  automationId,
  version: 1,
  contentHash: "hash-1",
  status: "queued" as const,
  revision: 0,
  fencingToken: 0,
  runAfter: createdAt,
  createdAt,
  updatedAt: createdAt
});

void test("AE-T-052.1 Mongo run history is scoped, ordered, and indexed", { skip: !mongoUri }, async () => {
  if (!mongoUri) return;
  assertSafeMongoUri(mongoUri);
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const collectionNames = Object.freeze({
    runs: `${runCollectionNames.runs}_${suffix}`,
    actions: `${runCollectionNames.actions}_${suffix}`
  });
  try {
    const runs = await createMongoRunRepository({ database, ownsScope: resolver.ownsScope, collectionNames });
    const history = await createMongoRunHistoryRepository({ database, ownsScope: resolver.ownsScope, collectionNames });
    const scope = await scopeFor("workspace-hist");
    const otherScope = await scopeFor("workspace-hist-other");

    assert.deepEqual(Object.keys(history).sort(), [...runHistoryRepositoryMethodNames].sort());

    await runs.insert(scope, makeRun("run-1", "workspace-hist", at(1)));
    await runs.insert(scope, makeRun("run-2", "workspace-hist", at(2)));
    await runs.insert(scope, makeRun("run-3a", "workspace-hist", at(3)));
    await runs.insert(scope, makeRun("run-3b", "workspace-hist", at(3)));
    await runs.insert(scope, makeRun("run-x", "workspace-hist", at(4), "automation-2"));
    await runs.insert(otherScope, makeRun("run-foreign", "workspace-hist-other", at(5)));
    await runs.insertActionAttempt(scope, {
      runId: "run-3a", workspaceId: "workspace-hist", actionIndex: 0, attempt: 1,
      status: "failed", createdAt: T0, updatedAt: T0, actionType: "notification.send"
    });

    const first = await history.listRuns(scope, "automation-1", { after: undefined, limit: 2 });
    assert.deepEqual(first.items.map((run) => run.runId), ["run-3b", "run-3a"]);
    assert.ok(first.next);
    await runs.insert(scope, makeRun("run-new", "workspace-hist", at(9)));
    const second = await history.listRuns(scope, "automation-1", { after: first.next, limit: 2 });
    assert.deepEqual(second.items.map((run) => run.runId), ["run-2", "run-1"]);
    assert.equal(second.next, undefined);

    const found = await history.findRun(scope, "run-3a");
    assert.equal(found?.automationId, "automation-1");
    assert.equal(await history.findRun(scope, "run-foreign"), undefined);
    assert.equal(await history.findRun(otherScope, "run-3a"), undefined);
    assert.deepEqual((await history.listRuns(otherScope, "automation-1", { after: undefined, limit: 10 }))
      .items.map((run) => run.runId), ["run-foreign"]);

    assert.deepEqual((await history.listActionAttempts(scope, "run-3a")).map((attempt) => attempt.actionType), ["notification.send"]);
    assert.deepEqual(await history.listActionAttempts(otherScope, "run-3a"), []);

    const invalidScope = undefined as unknown as WorkspaceScope;
    await assert.rejects(
      history.listRuns(invalidScope, "automation-1", { after: undefined, limit: 1 }),
      { message: "A resolver-minted workspace scope is required." }
    );
    await assert.rejects(history.findRun(invalidScope, "run-1"));
    await assert.rejects(history.listActionAttempts(invalidScope, "run-1"));

    const indexes = await database.collection(collectionNames.runs).listIndexes().toArray();
    assert.ok(indexes.some(({ name }) => name === "run_history_by_automation"));
  } finally {
    await Promise.all([
      database.collection(collectionNames.runs).drop().catch(() => undefined),
      database.collection(collectionNames.actions).drop().catch(() => undefined)
    ]);
    await integration.disconnect();
  }
});