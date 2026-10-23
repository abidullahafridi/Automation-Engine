import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import { createMongoQuotaStores, quotaCollectionNames } from "../quota.repository.js";
import type { QuotaCounterKey } from "../quota.service.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const key: QuotaCounterKey = Object.freeze({
  name: "runs:workspace",
  windowStart: "2099-01-01T00:00:00.000Z",
  windowEnd: "2099-01-01T00:01:00.000Z"
});
const globalKey: QuotaCounterKey = Object.freeze({ ...key, name: "runs:global" });
const mongoUri = process.env.MONGO_URI;

void test("AE-T-041.2 Mongo quota counters and chain budget", { skip: !mongoUri }, async (context) => {
  if (!mongoUri) return;
  const integration = createMongoDbIntegration({
    uri: mongoUri,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } satisfies Logger
  });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const suffix = randomUUID().replaceAll("-", "");
  const collectionNames = Object.freeze({
    counters: `${quotaCollectionNames.counters}_${suffix}`,
    globalCounters: `${quotaCollectionNames.globalCounters}_${suffix}`,
    chainBudgets: `${quotaCollectionNames.chainBudgets}_${suffix}`
  });
  try {
    const stores = await createMongoQuotaStores({ database, ownsScope: resolver.ownsScope, collectionNames });
    const scope = await scopeFor("workspace-quota");

    await context.test("TC-0418 concurrent workspace consumers never exceed the limit", async () => {
      const results = await Promise.all(Array.from({ length: 50 }, () => stores.counters.consume(scope, key, 10)));
      assert.equal(results.filter((item) => item.allowed).length, 10);
    });

    await context.test("TC-0418 concurrent global consumers never exceed the limit", async () => {
      const results = await Promise.all(Array.from({ length: 40 }, () => stores.counters.consumeGlobal(globalKey, 7)));
      assert.equal(results.filter((item) => item.allowed).length, 7);
    });

    await context.test("refund gives one unit back and denied calls spend nothing", async () => {
      const refundKey: QuotaCounterKey = { ...key, name: "events:workspace" };
      assert.equal((await stores.counters.consume(scope, refundKey, 1)).allowed, true);
      assert.equal((await stores.counters.consume(scope, refundKey, 1)).allowed, false);
      await stores.counters.refund(scope, refundKey);
      assert.equal((await stores.counters.consume(scope, refundKey, 1)).allowed, true);
      assert.equal((await stores.counters.consume(scope, refundKey, 1)).allowed, false);
    });

    await context.test("chain budget is atomic and isolated per chain", async () => {
      const results = await Promise.all(Array.from({ length: 30 }, () => stores.chainBudget.consume(scope, "chain-a", 5)));
      assert.equal(results.filter((item) => item.allowed).length, 5);
      assert.equal((await stores.chainBudget.consume(scope, "chain-b", 5)).allowed, true);
    });

    await context.test("forged scope is rejected before any database call", async () => {
      const forged = { workspaceId: "workspace-quota" } as unknown as WorkspaceScope;
      await assert.rejects(stores.counters.consume(forged, key, 10));
      await assert.rejects(stores.chainBudget.consume(forged, "chain-a", 5));
    });
  } finally {
    await Promise.all([
      database.collection(collectionNames.counters).drop().catch(() => undefined),
      database.collection(collectionNames.globalCounters).drop().catch(() => undefined),
      database.collection(collectionNames.chainBudgets).drop().catch(() => undefined)
    ]);
    await integration.disconnect();
  }
});