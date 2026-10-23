import assert from "node:assert/strict";
import test from "node:test";
import {
  createLifecycleAuditPort,
  executionDenialAuditRequest,
  lifecycleAuditRequest
} from "../audit.adapters.js";
import { createInMemoryAuditLog, type AuditCursor, type AuditLog } from "../audit.log.js";
import { verifyAuditRecord, type AuditAction, type AuditRecord } from "../audit.record.js";
import { createAuditRecorder, type AuditRequest } from "../audit.recorder.js";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { LifecycleAuditEvent } from "../version.lifecycle.service.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const only = <T>(items: readonly T[]): T => {
  const [item] = items;
  if (items.length !== 1 || item === undefined) throw new Error("Expected exactly one item.");
  return item;
};

const build = () => {
  const store = createInMemoryAuditLog(resolver.ownsScope);
  let counter = 0;
  const recorder = createAuditRecorder({
    ownsScope: resolver.ownsScope,
    log: store.log,
    clock: { now: (): string => "2026-10-17T10:00:00.000Z" },
    ids: {
      nextId: (): string => {
        counter += 1;
        return `rec-${String(counter)}`;
      }
    }
  });
  return { store, recorder };
};

const lifecycleEvent = (
  overrides: Readonly<{
    action: LifecycleAuditEvent["action"];
    outcome: LifecycleAuditEvent["outcome"];
    correlationId: string;
  }>
): LifecycleAuditEvent => ({
  workspaceId: "workspace-a",
  actor: { type: "user", id: "user-1" },
  action: overrides.action,
  target: { type: "automation", id: "auto-1" },
  occurredAt: "2026-10-17T09:59:00.000Z",
  outcome: overrides.outcome,
  correlationId: overrides.correlationId,
  change: { status: { from: "draft", to: "enabled" }, version: 1 }
});

const baseRequest: AuditRequest = {
  recordId: undefined,
  actor: { type: "user", id: "user-1" },
  action: "run.retry",
  target: { type: "run", id: "run-1" },
  outcome: "succeeded",
  correlationId: "corr-1",
  occurredAt: "2026-10-17T10:00:00.000Z",
  details: {}
};

const everything = { targetId: undefined, after: undefined, limit: 100 } as const;

void test("TC-0425 lifecycle transition writes one expected audit record and retries are idempotent", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  const port = createLifecycleAuditPort({ recorder });
  const event = lifecycleEvent({ action: "enable", outcome: "succeeded", correlationId: "corr-1" });

  await port.append(scope, event);
  await port.append(scope, event);

  const item = only((await store.log.list(scope, { targetId: "auto-1", after: undefined, limit: 10 })).items);
  assert.equal(item.workspaceId, "workspace-a");
  assert.equal(item.action, "automation.enable");
  assert.equal(item.outcome, "succeeded");
  assert.equal(item.actor.id, "user-1");
  assert.equal(item.target.id, "auto-1");
  assert.equal(item.correlationId, "corr-1");
  assert.deepEqual(item.details, { fromStatus: "draft", toStatus: "enabled", version: 1 });
  assert.equal(verifyAuditRecord(item), true);
  assert.equal(item.recordId, lifecycleAuditRequest(event).recordId);
  assert.equal(store.size(), 1);
});

void test("TC-0425 a denied transition is recorded as denied, never as success", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  const port = createLifecycleAuditPort({ recorder });
  await port.append(scope, lifecycleEvent({ action: "disable", outcome: "denied", correlationId: "corr-2" }));

  const item = only((await store.log.list(scope, everything)).items);
  assert.equal(item.action, "automation.disable");
  assert.equal(item.outcome, "denied");
});

void test("TC-0425 lifecycle audit refuses an event for another workspace", async () => {
  const scope = await scopeFor("workspace-b");
  const { store, recorder } = build();
  const port = createLifecycleAuditPort({ recorder });
  await assert.rejects(port.append(
    scope,
    lifecycleEvent({ action: "enable", outcome: "succeeded", correlationId: "corr-3" })
  ));
  assert.equal(store.size(), 0);
});

void test("TC-0426 denied execution records the outcome without leaking secrets", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  const result = await recorder.record(scope, {
    ...baseRequest,
    actor: { type: "automation", id: "automation:auto-1" },
    action: "execution.denied",
    outcome: "denied",
    details: {
      code: "PERMISSION_REVOKED",
      token: "tok-123",
      apiKey: "k-9",
      note: "failed Bearer abc123xyz token=hunter2",
      nested: { secret: "x" },
      fencingToken: 4
    }
  });
  assert.equal(result.kind, "recorded");

  const item = only((await store.log.list(scope, everything)).items);
  const { code, token, apiKey, nested, fencingToken, note } = item.details;
  assert.equal(item.outcome, "denied");
  assert.equal(code, "PERMISSION_REVOKED");
  assert.equal(token, "[REDACTED]");
  assert.equal(apiKey, "[REDACTED]");
  assert.equal(nested, "[UNSUPPORTED]");
  assert.equal(fencingToken, 4);
  assert.equal(typeof note === "string" && note.includes("[REDACTED]"), true);

  const serialized = JSON.stringify(item);
  for (const secret of ["tok-123", "k-9", "abc123xyz", "hunter2"]) {
    assert.equal(serialized.includes(secret), false, `${secret} must not be stored`);
  }
});

void test("TC-0426 execution denial adapter carries codes only", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  const result = await recorder.record(scope, executionDenialAuditRequest({
    automationId: "auto-1",
    runId: "run-1",
    code: "OWNER_ACCESS_LOST",
    pauseAutomation: true,
    retryable: false,
    correlationId: undefined
  }));
  assert.equal(result.kind, "recorded");

  const item = only((await store.log.list(scope, everything)).items);
  assert.equal(item.action, "execution.denied");
  assert.equal(item.outcome, "denied");
  assert.equal(item.actor.id, "automation:auto-1");
  assert.equal(item.target.type, "run");
  assert.deepEqual(item.details, {
    code: "OWNER_ACCESS_LOST",
    automationId: "auto-1",
    pauseAutomation: true,
    retryable: false
  });
});

void test("invalid audit input is rejected with a stable code and stores nothing", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  const tooMany = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${String(index)}`, index]));
  const cases: readonly (readonly [AuditRequest, string])[] = [
    [{ ...baseRequest, occurredAt: "not-a-date" }, "INVALID_TIME"],
    [{ ...baseRequest, action: "bogus" as unknown as AuditAction }, "INVALID_ACTION"],
    [{ ...baseRequest, actor: { type: "user", id: "" } }, "INVALID_ACTOR"],
    [{ ...baseRequest, target: { type: "run", id: "has space" } }, "INVALID_TARGET"],
    [{ ...baseRequest, correlationId: "bad id" }, "INVALID_CORRELATION"],
    [{ ...baseRequest, recordId: "bad id" }, "INVALID_RECORD_ID"],
    [{ ...baseRequest, details: tooMany }, "INVALID_DETAILS"],
    [{ ...baseRequest, details: { "bad key": 1 } }, "INVALID_DETAILS"],
    [{ ...baseRequest, details: { count: Number.NaN } }, "INVALID_DETAILS"]
  ];
  for (const [request, code] of cases) {
    assert.deepEqual(await recorder.record(scope, request), { kind: "rejected", code });
  }
  assert.equal(store.size(), 0);
});

void test("TC-0427 the audit surface exposes no way to change or delete a record", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  assert.deepEqual(Object.keys(store.log).sort(), ["append", "list"]);
  assert.deepEqual(Object.keys(recorder), ["record"]);

  await recorder.record(scope, baseRequest);
  const item = only((await store.log.list(scope, everything)).items);
  assert.equal(Object.isFrozen(item), true);
  assert.equal(Object.isFrozen(item.details), true);
  assert.equal(Reflect.set(item, "outcome", "failed"), false);
  assert.equal(Reflect.set(item.actor, "id", "attacker"), false);
  assert.equal(Reflect.set(item.details, "extra", 1), false);

  const again = only((await store.log.list(scope, everything)).items);
  assert.equal(again.outcome, "succeeded");
  assert.equal(again.actor.id, "user-1");
});

void test("TC-0427 re-appending the same id never overwrites, and tampering is detected", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  const first = await recorder.record(scope, { ...baseRequest, recordId: "fixed-1" });
  assert.equal(first.kind, "recorded");
  assert.equal((await recorder.record(scope, { ...baseRequest, recordId: "fixed-1" })).kind, "idempotent");
  assert.deepEqual(
    await recorder.record(scope, { ...baseRequest, recordId: "fixed-1", outcome: "failed" }),
    { kind: "rejected", code: "RECORD_CONFLICT" }
  );

  const stored = only((await store.log.list(scope, everything)).items);
  assert.equal(stored.outcome, "succeeded");
  assert.equal(store.size(), 1);

  const tampered: AuditRecord = { ...stored, outcome: "failed" };
  assert.equal(verifyAuditRecord(stored), true);
  assert.equal(verifyAuditRecord(tampered), false);
  await assert.rejects(store.log.append(scope, tampered));
  assert.equal(store.size(), 1);
});

void test("TC-0427 records are workspace-isolated and a forged scope is refused", async () => {
  const scopeA = await scopeFor("workspace-a");
  const scopeB = await scopeFor("workspace-b");
  const { store, recorder } = build();
  await recorder.record(scopeA, baseRequest);

  assert.equal((await store.log.list(scopeB, everything)).items.length, 0);

  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  await assert.rejects(store.log.list(forged, everything));
  assert.deepEqual(await recorder.record(forged, baseRequest), { kind: "rejected", code: "SCOPE_MISSING" });
  assert.equal(store.size(), 1);
});

void test("audit listing is stable and cursor-paginated", async () => {
  const scope = await scopeFor("workspace-a");
  const { store, recorder } = build();
  for (let index = 1; index <= 5; index += 1) {
    await recorder.record(scope, {
      ...baseRequest,
      recordId: `r${String(index)}`,
      occurredAt: `2026-10-17T10:00:0${String(index)}.000Z`
    });
  }

  const seen: string[] = [];
  let cursor: AuditCursor | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await store.log.list(scope, { targetId: undefined, after: cursor, limit: 2 });
    seen.push(...page.items.map((item) => item.recordId));
    if (page.next === undefined) break;
    cursor = page.next;
  }
  assert.deepEqual(seen, ["r1", "r2", "r3", "r4", "r5"]);
  await assert.rejects(store.log.list(scope, { targetId: undefined, after: undefined, limit: 0 }));
});

void test("an unavailable audit store is visible to the caller, never silent", async () => {
  const scope = await scopeFor("workspace-a");
  const downLog: AuditLog = {
    append: () => Promise.reject(new Error("db down")),
    list: () => Promise.reject(new Error("db down"))
  };
  const recorder = createAuditRecorder({
    ownsScope: resolver.ownsScope,
    log: downLog,
    clock: { now: (): string => "2026-10-17T10:00:00.000Z" },
    ids: { nextId: (): string => "rec-x" }
  });
  assert.deepEqual(await recorder.record(scope, baseRequest), { kind: "unavailable" });
  await assert.rejects(createLifecycleAuditPort({ recorder }).append(
    scope,
    lifecycleEvent({ action: "enable", outcome: "succeeded", correlationId: "corr-9" })
  ));
});