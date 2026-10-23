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

const T0 = "2026-10-17T10:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();
const run = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-dl-mongo", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});

void test("AE-T-032.2 Mongo dead-letter persistence, listing, requeue and backlog", { skip: !mongoUri }, async () => {
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
    const resolved = await resolver.resolve({ credential: "user", requestedWorkspaceId: "workspace-dl-mongo" });
    if (resolved.kind !== "resolved") throw new Error("scope required");
    const scope: WorkspaceScope = resolved.scope;
    const otherResolved = await resolver.resolve({ credential: "user", requestedWorkspaceId: "workspace-dl-other" });
    if (otherResolved.kind !== "resolved") throw new Error("scope required");
    const detail = { reason: "MAX_ATTEMPTS_EXHAUSTED" as const, attempts: 5, firstAttemptAt: T0 };

    await repository.insert(scope, run("dl1"));
    const claim = await repository.claimNext(scope, "worker-a", T0, 60_000);
    assert.ok(claim.kind === "claimed");

    // fenced: a wrong token is refused and the run stays running
    assert.equal(await repository.deadLetterRun(scope, "dl1", claim.run.fencingToken + 1, at(1_000), detail), "stale");
    assert.equal((await repository.findById(scope, "dl1"))?.status, "running");
    assert.equal(await repository.deadLetterRun(scope, "dl1", claim.run.fencingToken, at(1_000), detail), "dead_lettered");
    assert.equal(await repository.deadLetterRun(scope, "dl1", claim.run.fencingToken, at(2_000), detail), "stale");

    const stored = await repository.findById(scope, "dl1");
    assert.ok(stored);
    assert.equal(stored.status, "dead_letter");
    assert.equal(stored.leaseOwner, undefined);
    assert.deepEqual(stored.deadLetter, { ...detail, deadLetteredAt: at(1_000) });

    await repository.insertActionAttempt(scope, {
      runId: "dl1", workspaceId: scope.workspaceId, actionIndex: 0, attempt: 5, status: "failed",
      createdAt: T0, updatedAt: T0, actionType: "notification.send"
    });
    const attempts = await repository.listActionAttempts(scope, "dl1");
    assert.deepEqual(attempts.map((item) => item.actionType), ["notification.send"]);

    const page = await repository.listDeadLetters(scope, { after: undefined, limit: 10 });
    assert.deepEqual(page.items.map((item) => item.runId), ["dl1"]);
    assert.equal(page.next, undefined);
    assert.deepEqual(await repository.deadLetterBacklog(scope, at(5_000)), { count: 1, oldestAgeMs: 4_000 });

    // other workspaces see nothing and cannot requeue
    assert.deepEqual((await repository.listDeadLetters(otherResolved.scope, { after: undefined, limit: 10 })).items, []);
    assert.equal(await repository.requeueDeadLetter(otherResolved.scope, "dl1", stored.revision, at(6_000)), "not-found");

    // controlled requeue: revision checked, then claimable with a newer fencing generation
    assert.equal(await repository.requeueDeadLetter(scope, "dl1", stored.revision - 1, at(6_000)), "stale");
    assert.equal(await repository.requeueDeadLetter(scope, "dl1", stored.revision, at(6_000)), "requeued");
    const requeued = await repository.findById(scope, "dl1");
    if (!requeued) throw new Error("Expected the requeued run to exist.");
    assert.equal(requeued.status, "queued");
    assert.equal(requeued.interruptedReason, "DEAD_LETTER_RETRY");
    assert.equal(requeued.deadLetter, undefined);
    const again = await repository.claimNext(scope, "worker-b", at(6_000), 60_000);
    assert.ok(again.kind === "claimed");
    assert.equal(again.run.fencingToken, 2);
    assert.deepEqual(await repository.deadLetterBacklog(scope, at(7_000)), { count: 0, oldestAgeMs: undefined });
  } finally {
    await Promise.all([
      database.collection(collectionNames.runs).drop().catch(() => undefined),
      database.collection(collectionNames.actions).drop().catch(() => undefined)
    ]);
    await integration.disconnect();
  }
});
