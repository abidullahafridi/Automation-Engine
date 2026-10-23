import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import { createMongoRunRepository, runCollectionNames } from "../run.repository.js";
import { createMongoTriggerMatcher, triggerMatcherCollectionNames } from "../trigger.matcher.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
const mongoUri = process.env.MONGO_URI;

void test("AE-E04 wiring: a matcher-created run is claimable by the run repository", { skip: !mongoUri }, async () => {
  if (!mongoUri) return;
  const integration = createMongoDbIntegration({
    uri: mongoUri,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } satisfies Logger
  });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const matcherNames = Object.freeze({
    headers: `${triggerMatcherCollectionNames.headers}_${suffix}`,
    versions: `${triggerMatcherCollectionNames.versions}_${suffix}`,
    runs: `${triggerMatcherCollectionNames.runs}_${suffix}`
  });
  const runNames = Object.freeze({
    runs: matcherNames.runs,
    actions: `${runCollectionNames.actions}_${suffix}`
  });
  try {
    const scope = await scopeFor("workspace-wiring");
    await database.collection(matcherNames.headers).insertOne({
      automationId: "auto-1",
      workspaceId: "workspace-wiring",
      createdBy: "creator-1",
      status: "enabled",
      currentVersion: 1
    });
    await database.collection(matcherNames.versions).insertOne({
      automationId: "auto-1",
      workspaceId: "workspace-wiring",
      version: 1,
      schemaVersion: 1,
      contentHash: "hash-1",
      publishKey: "publish-1",
      rule: {
        schemaVersion: 1,
        name: "Notify",
        trigger: { type: "task.status_changed", config: { toStatus: "done", allowAutomationOrigin: false } },
        conditions: { all: [{ field: "task.isArchived", op: "eq", value: false }] },
        actions: [],
        executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
      },
      createdAt: "2026-10-15T12:00:00.000Z"
    });

    const matcher = await createMongoTriggerMatcher({
      database,
      ownsScope: resolver.ownsScope,
      collectionNames: matcherNames
    });
    const runs = await createMongoRunRepository({
      database,
      ownsScope: resolver.ownsScope,
      collectionNames: runNames
    });

    const result = await matcher.match(scope, {
      eventId: "evt-1",
      eventType: "task.status_changed",
      schemaVersion: 1,
      occurredAt: "2026-10-15T12:00:00.000Z",
      workspaceId: "workspace-wiring",
      traceparent,
      actor: { type: "user", id: "user-1" },
      aggregate: { type: "task", id: "task-1" },
      payload: { task: { status: "done", previousStatus: "open", priority: "high", isArchived: false } }
    });
    assert.equal(result.createdRuns, 1);

    const claim = await runs.claimNext(scope, "worker-1", "2026-10-15T12:00:01.000Z", 60_000);
    if (claim.kind !== "claimed") throw new Error("The matcher-created run must be claimable.");
    assert.equal(claim.run.status, "running");
    assert.equal(claim.run.fencingToken, 1);
    assert.equal(claim.run.traceparent, traceparent);

    const second = await runs.claimNext(scope, "worker-2", "2026-10-15T12:00:02.000Z", 60_000);
    assert.equal(second.kind, "none");
  } finally {
    await Promise.all([
      database.collection(matcherNames.headers).drop().catch(() => undefined),
      database.collection(matcherNames.versions).drop().catch(() => undefined),
      database.collection(matcherNames.runs).drop().catch(() => undefined),
      database.collection(runNames.actions).drop().catch(() => undefined)
    ]);
    await integration.disconnect();
  }
});