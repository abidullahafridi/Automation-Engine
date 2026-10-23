import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  computeNextOccurrence,
  occurrenceKey,
  validateSchedule,
  type ScheduleDefinition
} from "../schedule.occurrence.js";
import {
  createInMemoryScheduleRepository,
  scheduleRepositoryMethodNames
} from "../schedule.repository.js";
import { createScheduleService, type ScheduleTelemetry } from "../schedule.scheduler.js";

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

const daily: ScheduleDefinition = { kind: "daily", time: "09:00" };
const karachi = "Asia/Karachi"; // UTC+5, no DST

const build = (start: string) => {
  const state = { now: start };
  const repository = createInMemoryScheduleRepository(resolver.ownsScope);
  const lateness: number[] = [];
  const results: string[] = [];
  const telemetry: ScheduleTelemetry = {
    occurrence: (result) => { results.push(result); },
    lateness: (value) => { lateness.push(value); }
  };
  const service = createScheduleService({
    repository,
    ownsScope: resolver.ownsScope,
    clock: { now: () => state.now },
    telemetry
  });
  return { state, repository, service, lateness, results };
};

void test("computeNextOccurrence resolves daily local time to the expected UTC instant", () => {
  assert.equal(computeNextOccurrence(karachi, daily, "2026-10-19T00:00:00.000Z"), "2026-10-19T04:00:00.000Z");
  // strictly after: an exact hit moves to the next day
  assert.equal(computeNextOccurrence(karachi, daily, "2026-10-19T04:00:00.000Z"), "2026-10-20T04:00:00.000Z");
  assert.equal(computeNextOccurrence("America/New_York", daily, "2026-10-19T00:00:00.000Z"), "2026-10-19T13:00:00.000Z");
  assert.equal(computeNextOccurrence("America/New_York", daily, "2027-01-15T00:00:00.000Z"), "2027-01-15T14:00:00.000Z");
  assert.equal(computeNextOccurrence("UTC", { kind: "daily", time: "23:59" }, "2026-10-19T23:59:00.000Z"), "2026-10-20T23:59:00.000Z");
});

void test("computeNextOccurrence handles interval schedules and invalid input", () => {
  const interval: ScheduleDefinition = { kind: "interval", everyMs: 300_000, anchorAt: "2026-10-19T00:00:00.000Z" };
  assert.equal(computeNextOccurrence("UTC", interval, "2026-10-18T00:00:00.000Z"), "2026-10-19T00:00:00.000Z");
  assert.equal(computeNextOccurrence("UTC", interval, "2026-10-19T00:07:00.000Z"), "2026-10-19T00:10:00.000Z");
  assert.equal(computeNextOccurrence("UTC", interval, "2026-10-19T00:10:00.000Z"), "2026-10-19T00:15:00.000Z");
  assert.equal(computeNextOccurrence("UTC", interval, "not-a-date"), undefined);
  assert.equal(computeNextOccurrence("Not/AZone", interval, "2026-10-19T00:00:00.000Z"), undefined);
  assert.equal(computeNextOccurrence("UTC", { kind: "interval", everyMs: 1_000, anchorAt: "2026-10-19T00:00:00.000Z" }, "2026-10-19T00:00:00.000Z"), undefined);
});

void test("schedule validation rejects bad zone, short interval, bad anchor and bad time", () => {
  assert.deepEqual(validateSchedule(karachi, daily), []);
  assert.deepEqual(validateSchedule("EST", daily).map((item) => item.code), ["INVALID_TIMEZONE"]);
  assert.deepEqual(validateSchedule("Not/AZone", daily).map((item) => item.code), ["INVALID_TIMEZONE"]);
  assert.deepEqual(
    validateSchedule("UTC", { kind: "interval", everyMs: 59_999, anchorAt: "2026-10-19T00:00:00Z" }).map((item) => item.code),
    ["INTERVAL_TOO_SHORT"]
  );
  assert.deepEqual(
    validateSchedule("UTC", { kind: "interval", everyMs: 60_000, anchorAt: "nope" }).map((item) => item.code),
    ["INVALID_ANCHOR"]
  );
  assert.deepEqual(validateSchedule("UTC", { kind: "daily", time: "24:00" }).map((item) => item.code), ["INVALID_TIME"]);
});

void test("occurrence key is deterministic and unique per workspace, automation and instant", () => {
  const key = occurrenceKey("w1", "a1", "2026-10-19T04:00:00.000Z");
  assert.equal(key, occurrenceKey("w1", "a1", "2026-10-19T04:00:00.000Z"));
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.notEqual(key, occurrenceKey("w2", "a1", "2026-10-19T04:00:00.000Z"));
  assert.notEqual(key, occurrenceKey("w1", "a2", "2026-10-19T04:00:00.000Z"));
  assert.notEqual(key, occurrenceKey("w1", "a1", "2026-10-20T04:00:00.000Z"));
});

void test("TC-0601 normal schedule produces the expected occurrence and advances the cursor", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  const registered = await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });
  assert.ok(registered.kind === "registered");
  assert.equal(registered.cursor.nextOccurrenceAt, "2026-10-19T04:00:00.000Z");

  t.state.now = "2026-10-19T03:59:59.000Z";
  assert.deepEqual(await t.service.tick(scope), { claimed: 0, created: 0, duplicates: 0, stale: 0, failed: 0 });

  t.state.now = "2026-10-19T04:00:30.000Z";
  assert.deepEqual(await t.service.tick(scope), { claimed: 1, created: 1, duplicates: 0, stale: 0, failed: 0 });

  const occurrence = only(await t.repository.listOccurrences(scope, "auto-1"));
  assert.equal(occurrence.scheduledFor, "2026-10-19T04:00:00.000Z");
  assert.equal(occurrence.timezone, karachi);
  assert.equal(occurrence.occurrenceId, occurrenceKey("workspace-a", "auto-1", "2026-10-19T04:00:00.000Z"));

  const cursor = await t.repository.findCursor(scope, "auto-1");
  assert.ok(cursor);
  assert.equal(cursor.nextOccurrenceAt, "2026-10-20T04:00:00.000Z");
  assert.equal(cursor.rev, 1);
  assert.deepEqual(t.lateness, [30_000]);
  assert.deepEqual(t.results, ["created"]);
});

void test("TC-0602 duplicate scheduler ticks are deduplicated", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });
  t.state.now = "2026-10-19T04:00:05.000Z";

  const [first, second] = await Promise.all([t.service.tick(scope), t.service.tick(scope)]);
  assert.equal(first.created + second.created, 1);
  assert.equal(only(await t.repository.listOccurrences(scope, "auto-1")).scheduledFor, "2026-10-19T04:00:00.000Z");
  assert.equal((await t.repository.findCursor(scope, "auto-1"))?.rev, 1);

  // a further tick at the same instant has nothing to claim
  assert.deepEqual(await t.service.tick(scope), { claimed: 0, created: 0, duplicates: 0, stale: 0, failed: 0 });
});

void test("TC-0603 process restart resumes from the durable cursor without duplicating", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });

  // Simulated crash: the occurrence was stored, the cursor was never advanced.
  const firstInstant = "2026-10-19T04:00:00.000Z";
  await t.repository.insertOccurrence(scope, {
    occurrenceId: occurrenceKey("workspace-a", "auto-1", firstInstant),
    workspaceId: "workspace-a",
    automationId: "auto-1",
    scheduledFor: firstInstant,
    timezone: karachi,
    createdAt: "2026-10-19T04:00:01.000Z"
  });

  // "Restart": a brand new service instance over the same durable repository.
  const restarted = createScheduleService({
    repository: t.repository,
    ownsScope: resolver.ownsScope,
    clock: { now: () => "2026-10-19T04:01:00.000Z" }
  });
  assert.deepEqual(await restarted.tick(scope), { claimed: 1, created: 0, duplicates: 1, stale: 0, failed: 0 });
  assert.equal(only(await t.repository.listOccurrences(scope, "auto-1")).scheduledFor, firstInstant);
  assert.equal((await t.repository.findCursor(scope, "auto-1"))?.nextOccurrenceAt, "2026-10-20T04:00:00.000Z");
});

void test("TC-0604 a disabled schedule creates no new occurrence and re-enable does not burst", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });
  assert.equal(await t.service.setEnabled(scope, "auto-1", false), "updated");

  t.state.now = "2026-10-22T10:00:00.000Z";
  assert.deepEqual(await t.service.tick(scope), { claimed: 0, created: 0, duplicates: 0, stale: 0, failed: 0 });
  assert.deepEqual(await t.repository.listOccurrences(scope, "auto-1"), []);

  assert.equal(await t.service.setEnabled(scope, "auto-1", true), "updated");
  assert.equal((await t.repository.findCursor(scope, "auto-1"))?.nextOccurrenceAt, "2026-10-23T04:00:00.000Z");
  assert.deepEqual(await t.service.tick(scope), { claimed: 0, created: 0, duplicates: 0, stale: 0, failed: 0 });

  assert.equal(await t.service.setEnabled(scope, "missing", true), "not-found");
});

void test("registration is idempotent and invalid schedules are refused without storage", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  const first = await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });
  const again = await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });
  assert.equal(first.kind, "registered");
  assert.equal(again.kind, "exists");

  const invalid = await t.service.register(scope, { automationId: "auto-2", timezone: "Nope", definition: daily });
  assert.equal(invalid.kind, "invalid");
  assert.equal(await t.repository.findCursor(scope, "auto-2"), undefined);
});

void test("schedules are workspace-scoped and a forged or missing scope fails before storage", async () => {
  const scopeA = await scopeFor("workspace-a");
  const scopeB = await scopeFor("workspace-b");
  const t = build("2026-10-19T00:00:00.000Z");
  await t.service.register(scopeA, { automationId: "auto-1", timezone: karachi, definition: daily });
  t.state.now = "2026-10-19T04:00:05.000Z";

  assert.deepEqual(await t.service.tick(scopeB), { claimed: 0, created: 0, duplicates: 0, stale: 0, failed: 0 });
  assert.equal(await t.repository.findCursor(scopeB, "auto-1"), undefined);
  assert.deepEqual(await t.repository.listOccurrences(scopeB, "auto-1"), []);

  const forged = { workspaceId: "workspace-a" } as unknown as WorkspaceScope;
  const missing = undefined as unknown as WorkspaceScope;
  assert.deepEqual(Object.keys(t.repository).sort(), [...scheduleRepositoryMethodNames].sort());
  await assert.rejects(t.service.tick(forged), /resolver-minted workspace scope/);
  await assert.rejects(t.service.register(missing, { automationId: "x", timezone: karachi, definition: daily }), /resolver-minted workspace scope/);
  await assert.rejects(t.repository.findCursor(forged, "auto-1"), /resolver-minted workspace scope/);
  await assert.rejects(t.repository.findDue(forged, t.state.now, 1), /resolver-minted workspace scope/);
  await assert.rejects(
    t.repository.advanceCursor(forged, {
      automationId: "auto-1", expectedRev: 0, expectedNextOccurrenceAt: "x", nextOccurrenceAt: "y", now: t.state.now
    }),
    /resolver-minted workspace scope/
  );
});

void test("a failing telemetry sink never affects scheduling", async () => {
  const scope = await scopeFor("workspace-a");
  const repository = createInMemoryScheduleRepository(resolver.ownsScope);
  const state = { now: "2026-10-19T00:00:00.000Z" };
  const service = createScheduleService({
    repository,
    ownsScope: resolver.ownsScope,
    clock: { now: () => state.now },
    telemetry: {
      occurrence: () => { throw new Error("sink down"); },
      lateness: () => { throw new Error("sink down"); }
    }
  });
  await service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily });
  state.now = "2026-10-19T04:00:01.000Z";
  assert.equal((await service.tick(scope)).created, 1);
});