import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration } from "../../../integrations/index.js";
import { buildAuditRecord, type AuditOutcome, type AuditRecord } from "../audit.record.js";
import { auditCollectionNames, createMongoAuditLog } from "../audit.repository.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const make = (recordId: string, outcome: AuditOutcome, occurredAt: string): AuditRecord => {
  const built = buildAuditRecord({
    recordId,
    workspaceId: "workspace-audit",
    input: {
      actor: { type: "user", id: "user-1" },
      action: "automation.enable",
      target: { type: "automation", id: "auto-1" },
      outcome,
      correlationId: "corr-1",
      occurredAt,
      details: { version: 1 }
    }
  });
  if (!built.ok) throw new Error(built.code);
  return built.record;
};

const mongoUri = process.env.MONGO_URI;

void test("AE-T-042.2 Mongo append-only audit log", { skip: !mongoUri }, async (context) => {
  if (!mongoUri) return;
  const integration = createMongoDbIntegration({
    uri: mongoUri,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined } satisfies Logger
  });
  await integration.connect();
  const database = integration.database();
  if (!database) throw new Error("database required");
  const collectionNames = Object.freeze({
    records: `${auditCollectionNames.records}_${randomUUID().replaceAll("-", "")}`
  });
  try {
    const log = await createMongoAuditLog({ database, ownsScope: resolver.ownsScope, collectionNames });
    const scope = await scopeFor("workspace-audit");

    await context.test("append, idempotent retry and conflict", async () => {
      const record = make("rec-1", "succeeded", "2026-10-17T10:00:01.000Z");
      assert.equal(await log.append(scope, record), "appended");
      assert.equal(await log.append(scope, record), "idempotent");
      assert.equal(await log.append(scope, make("rec-1", "failed", "2026-10-17T10:00:01.000Z")), "conflict");
      const page = await log.list(scope, { targetId: "auto-1", after: undefined, limit: 10 });
      assert.deepEqual(page.items.map((item) => item.outcome), ["succeeded"]);
    });

    await context.test("concurrent identical appends store exactly one record", async () => {
      const record = make("rec-race", "succeeded", "2026-10-17T10:00:02.000Z");
      const results = await Promise.all(Array.from({ length: 20 }, () => log.append(scope, record)));
      assert.equal(results.filter((item) => item === "appended").length, 1);
      assert.equal(results.filter((item) => item === "idempotent").length, 19);
    });

    await context.test("stable cursor pagination", async () => {
      for (let index = 3; index <= 5; index += 1) {
        await log.append(scope, make(`rec-${String(index)}`, "succeeded", `2026-10-17T10:00:0${String(index)}.000Z`));
      }
      const first = await log.list(scope, { targetId: undefined, after: undefined, limit: 2 });
      assert.equal(first.items.length, 2);
      assert.notEqual(first.next, undefined);
      const second = await log.list(scope, { targetId: undefined, after: first.next, limit: 100 });
      const ids = [...first.items, ...second.items].map((item) => item.recordId);
      assert.equal(new Set(ids).size, ids.length);
    });

    await context.test("forged scope and tampered record are refused before the driver", async () => {
      const forged = { workspaceId: "workspace-audit" } as unknown as WorkspaceScope;
      await assert.rejects(log.list(forged, { targetId: undefined, after: undefined, limit: 10 }));
      const stored = make("rec-tamper", "succeeded", "2026-10-17T10:00:09.000Z");
      await assert.rejects(log.append(scope, { ...stored, outcome: "failed" }));
      const other = await scopeFor("workspace-other");
      assert.equal((await log.list(other, { targetId: undefined, after: undefined, limit: 10 })).items.length, 0);
    });
  } finally {
    await database.collection(collectionNames.records).drop().catch(() => undefined);
    await integration.disconnect();
  }
});