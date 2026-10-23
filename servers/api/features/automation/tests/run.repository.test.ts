import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver } from "../automation.ports.js";
import { createMongoRunRepository, runCollectionNames } from "../run.repository.js";
import type { StoredRun, WorkspaceScope } from "../index.js";

const resolver = createPrincipalResolver({ authenticate: (id) => Promise.resolve({ type: "user", id }), hasWorkspaceMembership: () => Promise.resolve(true) });
const scopeFor = async (): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: "workspace-run" });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};
const run = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-run", automationId: "automation-1", version: 1, contentHash: "hash-1",
  status: "queued", revision: 0, fencingToken: 0, runAfter: "2026-10-15T12:00:00.000Z", createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z"
});
const mongoUri = process.env.MONGO_URI;

void test("AE-T-030.1 Mongo run persistence and state transitions", { skip: !mongoUri }, async (context) => {
  if (!mongoUri) return;
  const integration = createMongoDbIntegration({ uri: mongoUri, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } satisfies Logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const collectionNames = Object.freeze({ runs: `${runCollectionNames.runs}_${suffix}`, actions: `${runCollectionNames.actions}_${suffix}` });
  try {
    const repository = await createMongoRunRepository({ database, ownsScope: resolver.ownsScope, collectionNames });
    const scope = await scopeFor();
    await context.test("TC-0301 legal transition succeeds", async () => {
      await repository.insert(scope, run("legal"));
      assert.equal(await repository.transition(scope, "legal", 0, "queued", "running", "2026-10-15T12:00:01.000Z"), "updated");
      assert.equal(await repository.transition(scope, "legal", 1, "running", "completed", "2026-10-15T12:00:02.000Z"), "updated");
    });
    await context.test("TC-0302 illegal transition is rejected", async () => {
      await repository.insert(scope, run("illegal"));
      assert.equal(await repository.transition(scope, "illegal", 0, "queued", "completed", "2026-10-15T12:00:01.000Z"), "illegal");
      assert.equal(await repository.transition(scope, "illegal", 0, "queued", "cancelled", "2026-10-15T12:00:01.000Z"), "updated");
    });
    await context.test("TC-0303 concurrent claims yield one owner", async () => {
      await repository.insert(scope, run("race"));
      const claims = await Promise.all([repository.claimNext(scope, "worker-a", "2026-10-15T12:00:01.000Z", 60_000), repository.claimNext(scope, "worker-b", "2026-10-15T12:00:01.000Z", 60_000)]);
      const claimed = claims.filter((item) => item.kind === "claimed");
      assert.equal(claimed.length, 1);
      const winner = claimed[0];
      if (!winner) throw new Error("One worker must claim the queued run.");
      assert.equal(winner.run.fencingToken, 1);
    });
    await context.test("TC-0304 status update with stale version fails", async () => {
      await repository.insert(scope, run("stale"));
      assert.equal(await repository.transition(scope, "stale", 1, "queued", "running", "2026-10-15T12:00:01.000Z"), "stale");
      assert.equal(await repository.transition(scope, "stale", 0, "queued", "cancelled", "2026-10-15T12:00:01.000Z"), "updated");
    });
    await context.test("TC-0305 action index uniqueness prevents duplicate action records", async () => {
      const attempt = { runId: "legal", workspaceId: "workspace-run", actionIndex: 0, attempt: 1, status: "pending" as const, createdAt: "2026-10-15T12:00:00.000Z", updatedAt: "2026-10-15T12:00:00.000Z" };
      assert.equal(await repository.insertActionAttempt(scope, attempt), "created");
      assert.equal(await repository.insertActionAttempt(scope, attempt), "idempotent");
    });
    await context.test("TC-0306 due retry_wait is claimable only after persisted backoff", async () => {
      await repository.insert(scope, run("retry-wait"));
      const first = await repository.claimNext(scope, "worker-a", "2026-10-15T12:00:01.000Z", 60_000);
      assert.equal(first.kind, "claimed");
      assert.equal(await repository.scheduleRetry(scope, "retry-wait", first.run.revision, first.run.fencingToken,
        "2026-10-15T12:00:02.000Z", "2026-10-15T12:00:10.000Z", "2026-10-15T12:00:01.000Z", "ACTION_HANDLER_ERROR"), "updated");
      assert.equal((await repository.claimNext(scope, "worker-b", "2026-10-15T12:00:09.999Z", 60_000)).kind, "none");
      const second = await repository.claimNext(scope, "worker-b", "2026-10-15T12:00:10.000Z", 60_000);
      assert.equal(second.kind, "claimed");
      assert.equal(second.run.fencingToken, 2);
    });
    await context.test("TC-0307 action attempt is persisted before effect and fenced to running", async () => {
      const attempt = { runId: "retry-wait", workspaceId: "workspace-run", actionIndex: 0, attempt: 2,
        status: "running" as const, createdAt: "2026-10-15T12:00:10.000Z", updatedAt: "2026-10-15T12:00:10.000Z", actionType: "notification.send" };
      assert.equal(await repository.insertActionAttempt(scope, attempt), "created");
      assert.equal(await repository.updateActionAttempt(scope, { ...attempt, status: "succeeded", updatedAt: "2026-10-15T12:00:11.000Z" }), "updated");
      assert.equal((await repository.listActionAttempts(scope, "retry-wait")).find((item) => item.actionIndex === 0)?.status, "succeeded");
    });
  } finally {
    await Promise.all([database.collection(collectionNames.runs).drop().catch(() => undefined), database.collection(collectionNames.actions).drop().catch(() => undefined)]);
    await integration.disconnect();
  }
});
