import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver } from "../automation.ports.js";
import { createTriggerMatcher } from "../trigger.matcher.js";
import { createMongoTriggerMatcher, triggerMatcherCollectionNames } from "../trigger.matcher.js";
import type { AutomationRun, TriggerCandidate } from "../trigger.matcher.js";
import type { WorkspaceScope } from "../automation.ports.js";
import type { PublishedAutomationVersion } from "../automation.repository.js";

const resolver = createPrincipalResolver({ authenticate: (id) => Promise.resolve({ type: "user", id }), hasWorkspaceMembership: () => Promise.resolve(true) });
const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const resolved = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (resolved.kind !== "resolved") throw new Error("scope required");
  return resolved.scope;
};
const event = (workspaceId = "workspace-a"): unknown => ({
  eventId: "event-1", eventType: "task.status_changed", schemaVersion: 1, occurredAt: "2026-10-15T12:00:00.000Z", workspaceId,
  actor: { type: "user", id: "user-1" }, aggregate: { type: "task", id: "task-1" },
  payload: { task: { status: "done", previousStatus: "open", priority: "high", isArchived: false } }
});
const candidate = (id: string, workspaceId = "workspace-a", status = "done"): TriggerCandidate => {
  const version: PublishedAutomationVersion = {
    automationId: id, workspaceId, version: 1, schemaVersion: 1, contentHash: `hash-${id}`, publishKey: `key-${id}`, createdAt: "2026-10-15T11:00:00.000Z", rule: {
    schemaVersion: 1, name: id, trigger: { type: "task.status_changed", config: { toStatus: status, allowAutomationOrigin: false } },
    conditions: { field: "task.priority", op: "eq", value: "high" }, actions: [], executionPolicy: { onActionFailure: "stop", maxAttempts: 1 }
  }
  };
  return Object.freeze({ automationId: id, createdBy: "user-1", version: Object.freeze(version) });
};
const harness = (items: readonly TriggerCandidate[]) => {
  const stored = new Map<string, AutomationRun>();
  return Object.freeze({
    matcher: createTriggerMatcher({
      candidates: Object.freeze({ findEligible: (_scope, _type, limit) => Promise.resolve(items.slice(0, limit)) }),
      runs: Object.freeze({ createIdempotently: (_scope, run) => { const exists = stored.has(run.runId); if (!exists) stored.set(run.runId, run); return Promise.resolve(exists ? "idempotent" as const : "created" as const); } })
    }),
    runs: () => [...stored.values()]
  });
};

void test("TC-0215 correct workspace rule matches and creates a pinned run", async () => {
  const subject = harness([candidate("automation-1")]);
  const result = await subject.matcher.match(await scopeFor("workspace-a"), event());
  assert.deepEqual(result, { kind: "matched", candidateCount: 1, createdRuns: 1, idempotentRuns: 0 });
  assert.deepEqual(subject.runs()[0], { runId: "event-1:automation-1:1", eventId: "event-1", workspaceId: "workspace-a", automationId: "automation-1", version: 1, contentHash: "hash-automation-1", status: "queued", createdAt: "2026-10-15T12:00:00.000Z" });
});

void test("TC-0216 a different workspace never matches", async () => {
  const subject = harness([candidate("automation-1", "workspace-b")]);
  const result = await subject.matcher.match(await scopeFor("workspace-a"), event());
  assert.equal(result.createdRuns, 0);
  assert.equal((await subject.matcher.match(await scopeFor("workspace-b"), event("workspace-a"))).reason, "workspace-conflict");
});

void test("TC-0217 paused or disabled versions are absent from eligible candidates", async () => {
  const subject = harness([]);
  assert.deepEqual(await subject.matcher.match(await scopeFor("workspace-a"), event()), { kind: "matched", candidateCount: 0, createdRuns: 0, idempotentRuns: 0 });
});

void test("TC-0218 malformed event is rejected before candidate lookup", async () => {
  const subject = harness([candidate("automation-1")]);
  assert.equal((await subject.matcher.match(await scopeFor("workspace-a"), { eventId: "bad" })).reason, "invalid-event");
});

void test("TC-0219 candidate flood is bounded and duplicate matching is idempotent", async () => {
  const subject = harness(Array.from({ length: 101 }, (_, index) => candidate(`automation-${String(index)}`)));
  assert.equal((await subject.matcher.match(await scopeFor("workspace-a"), event())).reason, "candidate-limit");
  const one = harness([candidate("automation-1")]);
  await one.matcher.match(await scopeFor("workspace-a"), event());
  assert.equal((await one.matcher.match(await scopeFor("workspace-a"), event())).idempotentRuns, 1);
});

const mongoUri = process.env.MONGO_URI;
void test("Mongo matcher uses enabled workspace candidates and persists one pinned run", { skip: !mongoUri }, async () => {
  if (!mongoUri) return;
  const logger: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const integration = createMongoDbIntegration({ uri: mongoUri, logger });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const headers = `${triggerMatcherCollectionNames.headers}_${suffix}`;
  const versions = `${triggerMatcherCollectionNames.versions}_${suffix}`;
  const runs = `${triggerMatcherCollectionNames.runs}_${suffix}`;
  try {
    await database.collection(headers).insertMany([
      { automationId: "enabled", workspaceId: "workspace-a", createdBy: "user-1", status: "enabled", currentVersion: 1 },
      { automationId: "paused", workspaceId: "workspace-a", createdBy: "user-1", status: "paused", currentVersion: 1 },
      { automationId: "foreign", workspaceId: "workspace-b", createdBy: "user-1", status: "enabled", currentVersion: 1 }
    ]);
    await database.collection(versions).insertMany([
      structuredClone(candidate("enabled").version),
      structuredClone(candidate("paused").version),
      structuredClone(candidate("foreign", "workspace-b").version)
    ]);
    const matcher = await createMongoTriggerMatcher({ database, ownsScope: resolver.ownsScope, collectionNames: { headers, versions, runs } });
    const result = await matcher.match(await scopeFor("workspace-a"), event());
    assert.equal(result.createdRuns, 1);
    assert.equal((await database.collection(runs).countDocuments({ eventId: "event-1" })), 1);
  } finally {
    await Promise.all([database.collection(headers).drop(), database.collection(versions).drop(), database.collection(runs).drop()]);
    await integration.disconnect();
  }
});
