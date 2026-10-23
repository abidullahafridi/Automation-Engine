import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import { createMongoRunRepository, runCollectionNames, type StoredRun } from "../run.repository.js";

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

const T0 = "2026-10-16T10:00:00.000Z";
const TTL = 60_000;
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const run = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-lease-mongo", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});

void test("AE-T-030.2 Mongo lease renewal, recovery and fencing", { skip: !mongoUri }, async (context) => {
  if (!mongoUri) return;
  assertSafeMongoUri(mongoUri);
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const collectionNames = Object.freeze({ runs: `${runCollectionNames.runs}_${suffix}`, actions: `${runCollectionNames.actions}_${suffix}` });
  try {
    const repository = await createMongoRunRepository({ database, ownsScope: resolver.ownsScope, collectionNames });
    const resolved = await resolver.resolve({ credential: "user", requestedWorkspaceId: "workspace-lease-mongo" });
    if (resolved.kind !== "resolved") throw new Error("scope required");
    const scope: WorkspaceScope = resolved.scope;

    await context.test("TC-0306 expired lease is recovered to queued and can be reclaimed", async () => {
      await repository.insert(scope, run("recover"));
      const first = await repository.claimNext(scope, "worker-a", at(0), TTL);
      assert.equal(first.kind, "claimed");
      assert.deepEqual(await repository.recoverExpiredLeases(scope, at(TTL - 1), 10), []);
      assert.deepEqual(await repository.recoverExpiredLeases(scope, at(TTL), 10), [{ runId: "recover", previousFencingToken: 1 }]);
      const stored = await repository.findById(scope, "recover");
      if (!stored) throw new Error("Recovered run must exist.");
      assert.equal(stored.status, "queued");
      assert.equal(stored.leaseOwner, undefined);
      assert.equal(stored.interruptedReason, "LEASE_EXPIRED");
      const second = await repository.claimNext(scope, "worker-b", at(TTL + 1), TTL);
      assert.ok(second.kind === "claimed");
      assert.equal(second.run.fencingToken, 2);
    });

    await context.test("TC-0307 stale worker cannot renew, transition or interrupt a newer generation", async () => {
      await repository.insert(scope, run("fence"));
      const first = await repository.claimNext(scope, "worker-a", at(0), TTL);
      assert.ok(first.kind === "claimed");
      // the earlier "recover" run is queued/claimed; fence run is the only one that matters below
      await repository.recoverExpiredLeases(scope, at(TTL), 10);
      const staleToken = first.run.fencingToken;
      const stillOld = await repository.findById(scope, "fence");
      assert.equal(stillOld?.status, "queued");
      const second = await repository.claimNext(scope, "worker-b", at(TTL + 1), TTL);
      assert.ok(second.kind === "claimed");
      assert.equal((await repository.renewLease(scope, second.run.runId, "worker-a", staleToken, at(TTL + 2), TTL)).kind, "stale");
      assert.equal(await repository.transition(scope, second.run.runId, second.run.revision, "running", "completed", at(TTL + 3), staleToken), "stale");
      assert.equal(await repository.interruptRun(scope, second.run.runId, staleToken, at(TTL + 3), "WORKER_SHUTDOWN"), "stale");
    });

    await context.test("TC-0309 crash mid-action marks the running action unknown_outcome", async () => {
      await repository.insert(scope, run("crash"));
      const claimed = await repository.claimNext(scope, "worker-a", at(10 * TTL), TTL);
      assert.ok(claimed.kind === "claimed");
      await repository.insertActionAttempt(scope, {
        runId: claimed.run.runId, workspaceId: scope.workspaceId, actionIndex: 0, attempt: 1, status: "pending", createdAt: T0, updatedAt: T0
      });
      await database.collection(collectionNames.actions).updateOne(
        { workspaceId: scope.workspaceId, runId: claimed.run.runId, actionIndex: 0 },
        { $set: { status: "running" } }
      );
      await repository.recoverExpiredLeases(scope, at(11 * TTL), 10);
      const action = await database.collection(collectionNames.actions).findOne({ workspaceId: scope.workspaceId, runId: claimed.run.runId });
      assert.equal(action?.status, "unknown_outcome");
      assert.equal((await repository.findById(scope, claimed.run.runId))?.status, "queued");
    });
  } finally {
    await Promise.all([
      database.collection(collectionNames.runs).drop().catch(() => undefined),
      database.collection(collectionNames.actions).drop().catch(() => undefined)
    ]);
    await integration.disconnect();
  }
});
