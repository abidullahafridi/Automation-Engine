import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import type { Logger } from "@workspace/logging";
import {
  automationCollectionNames,
  automationRepositoryMethodNames,
  createMongoAutomationRepository
} from "../index.js";
import { createPrincipalResolver } from "../automation.ports.js";
import type { WorkspaceScope } from "../automation.ports.js";
import type { PublishedAutomationVersion } from "../automation.repository.js";
import type { AutomationRepository } from "../automation.repository.js";
import type { RuleDocument } from "../rule.validation.js";
import { publishAutomationVersion } from "../version.repository.service.js";

const mongoUri = process.env.MONGO_URI;

const assertSafeMongoUri = (uri: string): void => {
  if (process.env.ALLOW_NON_PROD !== "yes") {
    throw new Error("Set ALLOW_NON_PROD=yes before running MongoDB integration tests.");
  }

  const target = new URL(uri);
  if (
    !["mongodb:", "mongodb+srv:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  ) {
    throw new Error("MongoDB integration tests only run against localhost.");
  }

  const sourceDatabase = decodeURIComponent(target.pathname.replace(/^\/+/, "").split("/")[0] ?? "");
  if (!sourceDatabase.toLowerCase().includes("test")) {
    throw new Error("MongoDB integration tests require a test database name.");
  }

};

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

const rule: RuleDocument = {
  schemaVersion: 1,
  name: "Test rule",
  trigger: {
    type: "task.status_changed",
    config: { toStatus: "done", allowAutomationOrigin: false }
  },
  conditions: { field: "task.isArchived", op: "eq", value: false },
  actions: [{
    type: "notification.send",
    config: { recipient: { type: "project_lead" }, template: "task_completed" },
    onStale: "skip"
  }],
  executionPolicy: { onActionFailure: "stop", maxAttempts: 5 }
};

const createDraftInput = (automationId: string, idempotencyKey: string, requestHash: string) => ({
  automationId,
  name: automationId,
  createdBy: "author-1",
  draft: { schemaVersion: 1, incomplete: true },
  idempotencyKey,
  requestHash,
  now: "2026-10-14T12:00:00.000Z"
});

const createVersion = (
  workspaceId: string,
  automationId: string,
  version: number,
  publishKey: string,
  contentHash: string
): PublishedAutomationVersion => ({
  automationId,
  workspaceId,
  version,
  schemaVersion: 1,
  contentHash,
  publishKey,
  rule,
  createdAt: "2026-10-14T12:01:00.000Z"
});

void test("Mongo repository contract against an isolated localhost database", {
  skip: !mongoUri
}, async (context) => {
  if (!mongoUri) return;

  assertSafeMongoUri(mongoUri);
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
    headers: `${automationCollectionNames.headers}_${suffix}`,
    versions: `${automationCollectionNames.versions}_${suffix}`
  });
  const client = database.client;
  let commandCount = 0;
  const onCommandStarted = (): void => { commandCount += 1; };
  client.on("commandStarted", onCommandStarted);

  try {
    const repository = await createMongoAutomationRepository({
      database,
      collectionNames,
      ownsScope: resolver.ownsScope
    });
    const ownScope = await scopeFor("workspace-a");
    const otherScope = await scopeFor("workspace-b");

    await context.test("TC-0101 create/read succeeds in the owning workspace with draft-only defaults", async () => {
      const created = await repository.createDraft(
        ownScope,
        createDraftInput("automation-a", "create-a", "request-a")
      );
      assert.equal(created.kind, "created");

      assert.equal(created.automation.status, "draft");
      assert.equal(created.automation.currentVersion, null);
      assert.equal(created.automation.hasDraft, true);
      assert.deepEqual(
        await repository.findById(ownScope, "automation-a"),
        created.automation
      );
    });

    await context.test("TC-0102 other-workspace reads and updates are non-enumerating", async () => {
      assert.equal(await repository.findById(otherScope, "automation-a"), undefined);
      assert.equal(
        await repository.updateDraft(otherScope, "automation-a", 0, { altered: true }, "2026-10-14T12:02:00Z"),
        "not-found"
      );
      assert.equal((await repository.findById(ownScope, "automation-a"))?.rev, 0);
      assert.equal(
        await repository.updateDraft(ownScope, "automation-a", 0, { schemaVersion: 1, changed: true }, "2026-10-14T12:03:00Z"),
        "updated"
      );
      assert.equal(
        await repository.updateDraft(ownScope, "automation-a", 0, { stale: true }, "2026-10-14T12:04:00Z"),
        "conflict"
      );
      assert.equal((await repository.findById(ownScope, "automation-a"))?.rev, 1);
    });

    await context.test("TC-0103 every repository method rejects missing scope before driver access", async () => {
      const commandsBefore = commandCount;
      const invalidScope = undefined as unknown as WorkspaceScope;
      const input = createDraftInput("missing-scope", "missing", "request");
      const version = createVersion("workspace-a", "automation-a", 1, "publish-a", "hash-a");
            const calls: readonly [string, () => Promise<unknown>][] = [
        ["createDraft", () => repository.createDraft(invalidScope, input)],
        ["findById", () => repository.findById(invalidScope, "automation-a")],
        ["list", () => repository.list(invalidScope, { after: undefined, limit: 10 })],
        ["updateDraft", () => repository.updateDraft(invalidScope, "automation-a", 0, {}, "2026-10-14T12:02:00Z")],
        ["insertVersion", () => repository.insertVersion(invalidScope, version)],
        ["findVersionByPublishKey", () => repository.findVersionByPublishKey(invalidScope, "automation-a", "publish-a")],
        ["listVersions", () => repository.listVersions(invalidScope, "automation-a")],
        ["compareAndSetCurrentVersion", () => repository.compareAndSetCurrentVersion(invalidScope, "automation-a", 0, 1)],
        ["transitionStatus", () => repository.transitionStatus(invalidScope, "automation-a", { revision: 0, status: "draft" }, "enabled", "2026-10-14T12:02:00Z")]
      ];
      assert.deepEqual(calls.map(([name]) => name).sort(), [...automationRepositoryMethodNames].sort());

      for (const [name, call] of calls) {
        await assert.rejects(call(), {
          message: "A resolver-minted workspace scope is required."
        }, name);
      }
      assert.equal(commandCount, commandsBefore);
    });

    await context.test("TC-0104 compound uniqueness, idempotency, version keys, and indexes match the contract", async () => {
      const workspaceScope = await scopeFor("workspace-indexes");
      const crossWorkspaceScope = await scopeFor("workspace-other-indexes");

      assert.equal(
        (await repository.createDraft(
          workspaceScope,
          createDraftInput("same-id", "first-key", "first-request")
        )).kind,
        "created"
      );
      const replay = await repository.createDraft(
        workspaceScope,
        createDraftInput("new-id", "first-key", "first-request")
      );
      assert.equal(replay.kind, "idempotent");
      assert.equal(replay.automation.automationId, "same-id");
      assert.equal(
        (await repository.createDraft(
          workspaceScope,
          createDraftInput("same-id", "different-key", "different-request")
        )).kind,
        "idempotency-conflict"
      );
      assert.equal(
        (await repository.createDraft(
          crossWorkspaceScope,
          createDraftInput("same-id", "first-key", "first-request")
        )).kind,
        "created"
      );

      const firstVersion = createVersion("workspace-indexes", "same-id", 1, "publish-once", "hash-a");
      assert.equal((await repository.insertVersion(workspaceScope, firstVersion)).kind, "inserted");
      assert.equal((await repository.insertVersion(workspaceScope, firstVersion)).kind, "idempotent");
      assert.equal(
        (await repository.insertVersion(
          workspaceScope,
          createVersion("workspace-indexes", "same-id", 1, "publish-other", "hash-b")
        )).kind,
        "conflict"
      );
      assert.equal(
        (await repository.insertVersion(
          workspaceScope,
          createVersion("workspace-indexes", "same-id", 2, "publish-once", "hash-c")
        )).kind,
        "conflict"
      );

      const headerIndexes = await database
        .collection(collectionNames.headers)
        .listIndexes()
        .toArray();
      const versionIndexes = await database
        .collection(collectionNames.versions)
        .listIndexes()
        .toArray();
      assert.ok(headerIndexes.some(({ name }) => name === "automation_workspace_id_unique"));
      assert.ok(headerIndexes.some(({ name }) => name === "automation_workspace_idempotency_unique"));
      assert.ok(headerIndexes.some(({ name }) => name === "automation_workspace_created_cursor"));
      assert.ok(versionIndexes.some(({ name }) => name === "automation_version_workspace_unique"));
      assert.ok(versionIndexes.some(({ name }) => name === "automation_publish_key_workspace_unique"));
    });

    await context.test("TC-0122 Mongo publish validates, hashes, persists, and activates a version", async () => {
      const versionScope = await scopeFor("workspace-version-publish");
      const created = await repository.createDraft(versionScope, {
        ...createDraftInput("automation-publish", "create-publish", "request-publish"),
        draft: rule
      });
      assert.equal(created.kind, "created");

      const published = await publishAutomationVersion(
        repository,
        versionScope,
        "automation-publish",
        0,
        "publish-first",
        "2026-10-14T12:01:00.000Z"
      );
      assert.ok(published.ok);
      assert.equal(published.version.automationId, "automation-publish");
      assert.equal(published.version.version, 1);
      assert.match(published.version.contentHash, /^[a-f0-9]{64}$/);
      assert.equal(published.version.schemaVersion, 1);
      assert.equal(published.revision, 1);
      assert.equal((await repository.findById(versionScope, "automation-publish"))?.currentVersion, 1);
      assert.deepEqual(await repository.listVersions(versionScope, "automation-publish"), [published.version]);

      const invalidCreated = await repository.createDraft(versionScope, {
        ...createDraftInput("automation-invalid", "create-invalid", "request-invalid"),
        draft: { ...rule, schemaVersion: 2 }
      });
      assert.equal(invalidCreated.kind, "created");
      const invalidPublish = await publishAutomationVersion(
        repository,
        versionScope,
        "automation-invalid",
        0,
        "publish-invalid",
        "2026-10-14T12:02:00.000Z"
      );
      assert.deepEqual(invalidPublish, {
        ok: false,
        kind: "invalid",
        code: "AUTOMATION_INVALID_RULE"
      });
      assert.equal((await repository.listVersions(versionScope, "automation-invalid")).length, 0);
      assert.equal((await repository.findById(versionScope, "automation-invalid"))?.currentVersion, null);
    });

    await context.test("TC-0123 Mongo revision CAS rejects a competing draft update", async () => {
      const raceScope = await scopeFor("workspace-version-race");
      const automationId = "automation-race";
      const created = await repository.createDraft(raceScope, {
        ...createDraftInput(automationId, "create-race", "request-race"),
        draft: rule
      });
      assert.equal(created.kind, "created");

      let injectedCompetingUpdate = false;
      const racingRepository: AutomationRepository = Object.freeze({
        ...repository,
        compareAndSetCurrentVersion: async (scope, id, expectedRevision, version) => {
          if (!injectedCompetingUpdate) {
            injectedCompetingUpdate = true;
            assert.equal(await repository.updateDraft(
              scope,
              id,
              expectedRevision,
              rule,
              "2026-10-14T12:00:30.000Z"
            ), "updated");
          }
          return repository.compareAndSetCurrentVersion(scope, id, expectedRevision, version);
        }
      });

      const racedPublish = await publishAutomationVersion(
        racingRepository,
        raceScope,
        automationId,
        0,
        "publish-race",
        "2026-10-14T12:01:00.000Z"
      );
      assert.deepEqual(racedPublish, {
        ok: false,
        kind: "conflict",
        code: "AUTOMATION_REVISION_CONFLICT"
      });
      assert.equal((await repository.findById(raceScope, automationId))?.currentVersion, null);

      const retriedPublish = await publishAutomationVersion(
        repository,
        raceScope,
        automationId,
        1,
        "publish-race",
        "2026-10-14T12:02:00.000Z"
      );
      assert.ok(retriedPublish.ok);
      assert.equal(retriedPublish.version.version, 1);
      assert.equal(retriedPublish.revision, 2);
      assert.equal(retriedPublish.idempotent, true);
    });

    await context.test("TC-0124 and TC-0125 Mongo versions remain immutable and addressable after republish", async () => {
      const versionScope = await scopeFor("workspace-version-history");
      const automationId = "automation-history";
      const created = await repository.createDraft(versionScope, {
        ...createDraftInput(automationId, "create-history", "request-history"),
        draft: rule
      });
      assert.equal(created.kind, "created");

      const first = await publishAutomationVersion(
        repository,
        versionScope,
        automationId,
        0,
        "publish-history-1",
        "2026-10-14T12:01:00.000Z"
      );
      assert.ok(first.ok);
      const pinnedVersion = Object.freeze({
        automationId,
        version: first.version.version,
        contentHash: first.version.contentHash
      });

      const revisedRule: RuleDocument = { ...rule, name: "Updated historical rule" };
      assert.equal(await repository.updateDraft(
        versionScope,
        automationId,
        first.revision,
        revisedRule,
        "2026-10-14T12:02:00.000Z"
      ), "updated");
      const second = await publishAutomationVersion(
        repository,
        versionScope,
        automationId,
        first.revision + 1,
        "publish-history-2",
        "2026-10-14T12:03:00.000Z"
      );
      assert.ok(second.ok);
      assert.equal(second.version.version, 2);

      const storedVersions = await repository.listVersions(versionScope, automationId);
      const pinned = storedVersions.find((version) =>
        version.version === pinnedVersion.version && version.contentHash === pinnedVersion.contentHash);
      assert.ok(pinned);
      assert.equal(Object.isFrozen(pinned), true);
      assert.equal(Object.isFrozen(pinned.rule), true);
      assert.equal(Reflect.set(pinned.rule, "name", "Tampered persisted rule"), false);
      assert.equal(pinned.rule.name, rule.name);
      assert.equal(storedVersions[1]?.rule.name, revisedRule.name);
      assert.equal((await repository.findById(versionScope, automationId))?.currentVersion, 2);
    });

    
    await context.test("concurrent Mongo publication retries converge on one immutable version", async () => {
      const concurrentScope = await scopeFor("workspace-version-concurrent");
      const automationId = "automation-concurrent";
      const created = await repository.createDraft(concurrentScope, {
        ...createDraftInput(automationId, "create-concurrent", "request-concurrent"),
        draft: rule
      });
      assert.equal(created.kind, "created");

      const outcomes = await Promise.all([
        publishAutomationVersion(
          repository,
          concurrentScope,
          automationId,
          0,
          "publish-concurrent",
          "2026-10-14T12:01:00.000Z"
        ),
        publishAutomationVersion(
          repository,
          concurrentScope,
          automationId,
          0,
          "publish-concurrent",
          "2026-10-14T12:01:00.000Z"
        )
      ]);
      assert.ok(outcomes.every((outcome) => outcome.ok));
      assert.equal((await repository.listVersions(concurrentScope, automationId)).length, 1);
      assert.equal((await repository.findById(concurrentScope, automationId))?.currentVersion, 1);
      assert.equal((await repository.findById(concurrentScope, automationId))?.rev, 1);
    });

    await context.test("transitionStatus applies a status+revision CAS and stays workspace-scoped", async () => {
      const transitionScope = await scopeFor("workspace-transition");
      const otherTransitionScope = await scopeFor("workspace-transition-other");
      const automationId = "automation-transition";
      const created = await repository.createDraft(transitionScope, {
        ...createDraftInput(automationId, "create-transition", "request-transition"),
        draft: rule
      });
      assert.equal(created.kind, "created");
      const now = "2026-10-14T12:05:00.000Z";
      assert.equal(await repository.transitionStatus(
        transitionScope, automationId, { revision: 5, status: "draft" }, "enabled", now
      ), "conflict");
      assert.equal(await repository.transitionStatus(
        transitionScope, automationId, { revision: 0, status: "paused" }, "enabled", now
      ), "conflict");
      assert.equal(await repository.transitionStatus(
        otherTransitionScope, automationId, { revision: 0, status: "draft" }, "enabled", now
      ), "not-found");
      assert.equal(await repository.transitionStatus(
        transitionScope, "missing-automation", { revision: 0, status: "draft" }, "enabled", now
      ), "not-found");
      assert.equal((await repository.findById(transitionScope, automationId))?.status, "draft");
      assert.equal(await repository.transitionStatus(
        transitionScope, automationId, { revision: 0, status: "draft" }, "enabled", now
      ), "updated");
      const updated = await repository.findById(transitionScope, automationId);
      assert.ok(updated);
      assert.equal(updated.status, "enabled");
      assert.equal(updated.rev, 1);
      assert.equal(updated.updatedAt, now);
      assert.equal(await repository.transitionStatus(
        transitionScope, automationId, { revision: 0, status: "draft" }, "enabled", now
      ), "conflict");
    });
  } finally {
    client.off("commandStarted", onCommandStarted);
    try {
      await Promise.all([
        database.collection(collectionNames.headers).drop(),
        database.collection(collectionNames.versions).drop()
      ]);
    } finally {
      await integration.disconnect();
    }
  }
});