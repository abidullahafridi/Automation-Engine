import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  createMongoRecoveryIdempotencyStore,
  recoveryIdempotencyCollectionName,
  recoveryIdempotencyMethodNames
} from "../run.recovery.idempotency.js";

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

void test("AE-T-052.2 Mongo recovery idempotency store reserves atomically", { skip: !mongoUri }, async () => {
  if (!mongoUri) return;
  assertSafeMongoUri(mongoUri);
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const collectionName = `${recoveryIdempotencyCollectionName}_${randomUUID().replaceAll("-", "")}`;
  try {
    const store = await createMongoRecoveryIdempotencyStore({ database, ownsScope: resolver.ownsScope, collectionName });
    assert.deepEqual(Object.keys(store).sort(), [...recoveryIdempotencyMethodNames].sort());
    const scope = await scopeFor("workspace-idem");
    const otherScope = await scopeFor("workspace-idem-other");
    const now = "2026-10-18T10:00:00.000Z";

    const racers = await Promise.all(Array.from({ length: 10 }, () => store.reserve(scope, "key-1", "hash-1", now)));
    assert.equal(racers.filter((item) => item.kind === "reserved").length, 1);
    assert.equal(racers.filter((item) => item.kind === "in-progress").length, 9);

    assert.equal((await store.reserve(scope, "key-1", "other-hash", now)).kind, "conflict");
    assert.equal((await store.reserve(otherScope, "key-1", "hash-1", now)).kind, "reserved");

    const receipt = { kind: "requeued" as const, runId: "run-1", revision: 5 };
    await store.complete(scope, "key-1", receipt);
    const replay = await store.reserve(scope, "key-1", "hash-1", now);
    assert.ok(replay.kind === "replay");
    assert.deepEqual(replay.receipt, receipt);

    // A pending reservation is released; a completed one is never deleted.
    assert.equal((await store.reserve(scope, "key-2", "hash-2", now)).kind, "reserved");
    await store.release(scope, "key-2");
    assert.equal((await store.reserve(scope, "key-2", "hash-2", now)).kind, "reserved");
    await store.release(scope, "key-1");
    assert.equal((await store.reserve(scope, "key-1", "hash-1", now)).kind, "replay");

    await assert.rejects(
      store.reserve(undefined as unknown as WorkspaceScope, "key", "hash", now),
      { message: "A resolver-minted workspace scope is required." }
    );
  } finally {
    await database.collection(collectionName).drop().catch(() => undefined);
    await integration.disconnect();
  }
});