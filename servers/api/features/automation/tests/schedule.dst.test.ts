import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import {
  computeNextOccurrence,
  resolveLocalTime,
  type ScheduleDefinition
} from "../schedule.occurrence.js";
import { createInMemoryScheduleRepository } from "../schedule.repository.js";
import {
  createScheduleService,
  planCatchUp,
  type ScheduleTelemetry
} from "../schedule.scheduler.js";

const resolver = createPrincipalResolver({
  authenticate: (id) => Promise.resolve({ type: "user", id }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: "user", requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("scope required");
  return result.scope;
};

const daily = (time: string): ScheduleDefinition => ({ kind: "daily", time });
const karachi = "Asia/Karachi";
const newYork = "America/New_York";
const HOUR = 3_600_000;

const build = (
  start: string,
  options: Readonly<{ catchUpWindowMs?: number; maxOccurrencesPerTick?: number }> = {}
) => {
  const state = { now: start };
  const repository = createInMemoryScheduleRepository(resolver.ownsScope);
  const lateness: number[] = [];
  const missedCounts: number[] = [];
  const telemetry: ScheduleTelemetry = {
    occurrence: () => undefined,
    lateness: (value) => { lateness.push(value); },
    missed: (count) => { missedCounts.push(count); }
  };
  const service = createScheduleService({
    repository,
    ownsScope: resolver.ownsScope,
    clock: { now: () => state.now },
    telemetry,
    ...options
  });
  return { state, repository, service, lateness, missedCounts };
};

void test("TC-0605 spring-forward gap runs at the first valid instant after the gap (D-23)", () => {
  const gap = resolveLocalTime(newYork, 2026, 3, 8, 2, 30);
  assert.equal(gap.kind, "gap");
  assert.equal(new Date(gap.instant).toISOString(), "2026-03-08T07:00:00.000Z");

  assert.equal(
    computeNextOccurrence(newYork, daily("02:30"), "2026-03-08T00:00:00.000Z"),
    "2026-03-08T07:00:00.000Z"
  );
  // the gap occurrence fires once; the next one is the normal next day
  assert.equal(
    computeNextOccurrence(newYork, daily("02:30"), "2026-03-08T07:00:00.000Z"),
    "2026-03-09T06:30:00.000Z"
  );
  // a normal day before the transition is unaffected
  assert.equal(
    computeNextOccurrence(newYork, daily("02:30"), "2026-03-07T00:00:00.000Z"),
    "2026-03-07T07:30:00.000Z"
  );

  const london = resolveLocalTime("Europe/London", 2026, 3, 29, 1, 30);
  assert.equal(london.kind, "gap");
  assert.equal(new Date(london.instant).toISOString(), "2026-03-29T01:00:00.000Z");
});

void test("TC-0606 fall-back fold runs once at the first occurrence (D-24)", () => {
  const fold = resolveLocalTime(newYork, 2026, 11, 1, 1, 30);
  assert.equal(fold.kind, "fold");
  assert.equal(new Date(fold.instant).toISOString(), "2026-11-01T05:30:00.000Z");

  assert.equal(
    computeNextOccurrence(newYork, daily("01:30"), "2026-11-01T00:00:00.000Z"),
    "2026-11-01T05:30:00.000Z"
  );
  // the repeated 01:30 EST (06:30Z) is NOT a second occurrence
  assert.equal(
    computeNextOccurrence(newYork, daily("01:30"), "2026-11-01T05:30:00.000Z"),
    "2026-11-02T06:30:00.000Z"
  );
});

void test("normal local times and zones without DST resolve unambiguously", () => {
  const normal = resolveLocalTime(karachi, 2026, 10, 19, 9, 0);
  assert.equal(normal.kind, "normal");
  assert.equal(new Date(normal.instant).toISOString(), "2026-10-19T04:00:00.000Z");
  const ny = resolveLocalTime(newYork, 2026, 7, 15, 12, 0);
  assert.equal(ny.kind, "normal");
  assert.equal(new Date(ny.instant).toISOString(), "2026-07-15T16:00:00.000Z");
});

void test("planCatchUp coalesces to the latest due occurrence inside the window", () => {
  const nowMs = Date.parse("2026-10-22T04:30:00.000Z");
  const plan = planCatchUp(karachi, daily("09:00"), "2026-10-19T04:00:00.000Z", nowMs, HOUR, 100);
  assert.ok(plan);
  assert.equal(plan.run, "2026-10-22T04:00:00.000Z");
  assert.deepEqual(plan.missed, [
    "2026-10-19T04:00:00.000Z",
    "2026-10-20T04:00:00.000Z",
    "2026-10-21T04:00:00.000Z"
  ]);
  assert.equal(plan.next, "2026-10-23T04:00:00.000Z");
});

void test("TC-0607 a long outage skips everything outside the window and records MISSED_SKIPPED", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily("09:00") });

  t.state.now = "2026-10-22T10:00:00.000Z"; // latest due (04:00Z) is 6h old
  assert.deepEqual(await t.service.tick(scope), {
    claimed: 1, created: 0, duplicates: 0, stale: 0, failed: 0, missed: 4
  });
  const stored = await t.repository.listOccurrences(scope, "auto-1");
  assert.equal(stored.length, 4);
  assert.ok(stored.every((item) => item.skipReason === "MISSED_SKIPPED"));
  assert.equal((await t.repository.findCursor(scope, "auto-1"))?.nextOccurrenceAt, "2026-10-23T04:00:00.000Z");
  assert.deepEqual(t.missedCounts, [4]);
  assert.deepEqual(t.lateness, []);

  // nothing is left to process on the next tick
  assert.deepEqual(await t.service.tick(scope), { claimed: 0, created: 0, duplicates: 0, stale: 0, failed: 0 });
});

void test("TC-0607 within the window the latest runs once and earlier ones are skipped; boundary is inclusive", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z");
  await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily("09:00") });

  t.state.now = "2026-10-22T04:30:00.000Z";
  assert.deepEqual(await t.service.tick(scope), {
    claimed: 1, created: 1, duplicates: 0, stale: 0, failed: 0, missed: 3
  });
  const stored = await t.repository.listOccurrences(scope, "auto-1");
  assert.deepEqual(
    stored.map((item) => [item.scheduledFor, item.skipReason]),
    [
      ["2026-10-19T04:00:00.000Z", "MISSED_SKIPPED"],
      ["2026-10-20T04:00:00.000Z", "MISSED_SKIPPED"],
      ["2026-10-21T04:00:00.000Z", "MISSED_SKIPPED"],
      ["2026-10-22T04:00:00.000Z", undefined]
    ]
  );
  assert.deepEqual(t.lateness, [1_800_000]);

  // exactly one hour late is still inside the window; one millisecond more is not
  const inside = build("2026-10-19T00:00:00.000Z");
  await inside.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily("09:00") });
  inside.state.now = "2026-10-19T05:00:00.000Z";
  assert.equal((await inside.service.tick(scope)).created, 1);

  const outside = build("2026-10-19T00:00:00.000Z");
  await outside.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily("09:00") });
  outside.state.now = "2026-10-19T05:00:00.001Z";
  assert.deepEqual(await outside.service.tick(scope), {
    claimed: 1, created: 0, duplicates: 0, stale: 0, failed: 0, missed: 1
  });
});

void test("the per-tick cap bounds work and later ticks continue the backlog", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-10-19T00:00:00.000Z", { maxOccurrencesPerTick: 3 });
  await t.service.register(scope, { automationId: "auto-1", timezone: karachi, definition: daily("09:00") });

  t.state.now = "2026-10-22T04:30:00.000Z"; // four due occurrences, cap is 3
  assert.deepEqual(await t.service.tick(scope), {
    claimed: 1, created: 0, duplicates: 0, stale: 0, failed: 0, missed: 3
  });
  assert.equal((await t.repository.findCursor(scope, "auto-1"))?.nextOccurrenceAt, "2026-10-22T04:00:00.000Z");

  assert.deepEqual(await t.service.tick(scope), {
    claimed: 1, created: 1, duplicates: 0, stale: 0, failed: 0
  });
  assert.equal((await t.repository.listOccurrences(scope, "auto-1")).length, 4);
});

void test("TC-0608 occurrences are stored as unambiguous UTC instants, including across DST", async () => {
  const scope = await scopeFor("workspace-a");
  const t = build("2026-03-07T12:00:00.000Z");
  await t.service.register(scope, { automationId: "auto-ny", timezone: newYork, definition: daily("02:30") });

  t.state.now = "2026-03-08T07:00:10.000Z";
  assert.equal((await t.service.tick(scope)).created, 1);
  const stored = await t.repository.listOccurrences(scope, "auto-ny");
  assert.ok(stored.every((item) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.scheduledFor)));
  assert.equal(stored[0]?.scheduledFor, "2026-03-08T07:00:00.000Z");
  assert.equal((await t.repository.findCursor(scope, "auto-ny"))?.nextOccurrenceAt, "2026-03-09T06:30:00.000Z");
});

void test("invalid catch-up configuration fails loudly", () => {
  const repository = createInMemoryScheduleRepository(resolver.ownsScope);
  const base = { repository, ownsScope: resolver.ownsScope, clock: { now: () => "2026-10-19T00:00:00.000Z" } };
  assert.throws(() => createScheduleService({ ...base, catchUpWindowMs: 0 }), /positive integers/);
  assert.throws(() => createScheduleService({ ...base, maxOccurrencesPerTick: 1.5 }), /positive integers/);
});