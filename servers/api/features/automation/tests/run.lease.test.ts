import assert from "node:assert/strict";
import test from "node:test";
import { createPrincipalResolver, type WorkspaceScope } from "../automation.ports.js";
import type { StoredRun } from "../run.repository.js";
import { createInMemoryRunRepository } from "./run.repository.in-memory.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});
const scopeFor = async (workspaceId: string): Promise<WorkspaceScope> => {
  const result = await resolver.resolve({ credential: `user-${workspaceId}`, requestedWorkspaceId: workspaceId });
  if (result.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  return result.scope;
};

const T0 = "2026-10-16T10:00:00.000Z";
const TTL = 60_000;
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

const run = (runId: string): StoredRun => Object.freeze({
  runId, eventId: `event-${runId}`, workspaceId: "workspace-lease", automationId: "automation-1", version: 1,
  contentHash: "hash-1", status: "queued" as const, revision: 0, fencingToken: 0, runAfter: T0, createdAt: T0, updatedAt: T0
});

const fixture = async () => {
  const store = createInMemoryRunRepository(resolver.ownsScope);
  const scope = await scopeFor("workspace-lease");
  const claim = async (workerId: string, now: string): Promise<StoredRun> => {
    const result = await store.repository.claimNext(scope, workerId, now, TTL);
    if (result.kind !== "claimed") throw new Error("Expected a claim.");
    return result.run;
  };
  return { store, repository: store.repository, scope, claim };
};

void test("TC-0306 expired lease is recovered to queued, is idempotent, and can be reclaimed", async () => {
  const f = await fixture();
  await f.repository.insert(f.scope, run("r1"));
  await f.claim("worker-a", at(0));

  assert.deepEqual(await f.repository.recoverExpiredLeases(f.scope, at(TTL - 1), 10), []);
  assert.deepEqual(await f.repository.recoverExpiredLeases(f.scope, at(TTL), 10), [{ runId: "r1", previousFencingToken: 1 }]);

  const stored = await f.repository.findById(f.scope, "r1");
  if (!stored) throw new Error("Recovered run must exist.");
  assert.equal(stored.status, "queued");
  assert.equal(stored.leaseOwner, undefined);
  assert.equal(stored.leaseExpiresAt, undefined);
  assert.equal(stored.interruptedReason, "LEASE_EXPIRED");
  assert.equal(stored.revision, 2);
  assert.equal(stored.fencingToken, 1);

  assert.deepEqual(await f.repository.recoverExpiredLeases(f.scope, at(TTL + 1), 10), []);
  assert.equal((await f.claim("worker-b", at(TTL + 2))).fencingToken, 2);
});

void test("lease renewal extends a live lease without bumping revision and refuses everything else", async () => {
  const f = await fixture();
  await f.repository.insert(f.scope, run("r1"));
  await f.claim("worker-a", at(0));

  const renewed = await f.repository.renewLease(f.scope, "r1", "worker-a", 1, at(30_000), TTL);
  assert.ok(renewed.kind === "renewed");
  assert.equal(renewed.run.leaseExpiresAt, at(30_000 + TTL));
  assert.equal(renewed.run.revision, 1);

  assert.equal((await f.repository.renewLease(f.scope, "r1", "worker-b", 1, at(31_000), TTL)).kind, "stale");
  assert.equal((await f.repository.renewLease(f.scope, "r1", "worker-a", 9, at(31_000), TTL)).kind, "stale");
  assert.equal((await f.repository.renewLease(f.scope, "r1", "worker-a", 1, at(30_000 + TTL), TTL)).kind, "stale");
});

void test("TC-0307 a stale worker cannot renew or overwrite a newer lease generation", async () => {
  const f = await fixture();
  await f.repository.insert(f.scope, run("r1"));
  const first = await f.claim("worker-a", at(0));
  await f.repository.recoverExpiredLeases(f.scope, at(TTL), 10);
  const second = await f.claim("worker-b", at(TTL + 1));
  assert.equal(second.fencingToken, first.fencingToken + 1);

  assert.equal((await f.repository.renewLease(f.scope, "r1", "worker-a", first.fencingToken, at(TTL + 2), TTL)).kind, "stale");
  assert.equal(await f.repository.transition(f.scope, "r1", second.revision, "running", "completed", at(TTL + 3), first.fencingToken), "stale");
  assert.equal(await f.repository.interruptRun(f.scope, "r1", first.fencingToken, at(TTL + 3), "WORKER_SHUTDOWN"), "stale");

  const stored = await f.repository.findById(f.scope, "r1");
  if (!stored) throw new Error("Reclaimed run must exist.");
  assert.equal(stored.status, "running");
  assert.equal(stored.leaseOwner, "worker-b");
});

void test("TC-0309 crash mid-action leaves a recoverable, known state (action -> unknown_outcome)", async () => {
  const f = await fixture();
  await f.repository.insert(f.scope, run("r1"));
  await f.claim("worker-a", at(0));
  await f.repository.insertActionAttempt(f.scope, {
    runId: "r1", workspaceId: "workspace-lease", actionIndex: 0, attempt: 1, status: "pending", createdAt: T0, updatedAt: T0
  });
  f.store.startAction("workspace-lease", "r1", 0);
  assert.deepEqual(f.store.actionStatuses("r1"), ["running"]);

  await f.repository.recoverExpiredLeases(f.scope, at(TTL), 10);

  assert.deepEqual(f.store.actionStatuses("r1"), ["unknown_outcome"]);
  const recovered = await f.repository.findById(f.scope, "r1");
  if (!recovered) throw new Error("Recovered run must exist.");
  assert.equal(recovered.status, "queued");
  assert.equal((await f.claim("worker-b", at(TTL + 1))).fencingToken, 2);
});

void test("interruptRun by the owner requeues the run and marks running actions unknown", async () => {
  const f = await fixture();
  await f.repository.insert(f.scope, run("r1"));
  const claimed = await f.claim("worker-a", at(0));
  await f.repository.insertActionAttempt(f.scope, {
    runId: "r1", workspaceId: "workspace-lease", actionIndex: 0, attempt: 1, status: "pending", createdAt: T0, updatedAt: T0
  });
  f.store.startAction("workspace-lease", "r1", 0);

  assert.equal(await f.repository.interruptRun(f.scope, "r1", claimed.fencingToken, at(1_000), "WORKER_SHUTDOWN"), "requeued");
  const stored = await f.repository.findById(f.scope, "r1");
  if (!stored) throw new Error("Interrupted run must exist.");
  assert.equal(stored.status, "queued");
  assert.equal(stored.interruptedReason, "WORKER_SHUTDOWN");
  assert.deepEqual(f.store.actionStatuses("r1"), ["unknown_outcome"]);
});

void test("recovery is workspace-scoped: another workspace cannot recover or see these runs", async () => {
  const f = await fixture();
  const other = await scopeFor("workspace-other");
  await f.repository.insert(f.scope, run("r1"));
  await f.claim("worker-a", at(0));

  assert.deepEqual(await f.repository.recoverExpiredLeases(other, at(TTL), 10), []);
  assert.equal(await f.repository.findById(other, "r1"), undefined);
  assert.equal((await f.repository.findById(f.scope, "r1"))?.status, "running");
});

void test("new repository methods reject a missing or forged scope", async () => {
  const f = await fixture();
  const forged = { workspaceId: "workspace-lease" } as unknown as WorkspaceScope;
  await assert.rejects(f.repository.findById(forged, "r1"), /resolver-minted workspace scope/);
  await assert.rejects(f.repository.renewLease(forged, "r1", "w", 1, T0, TTL), /resolver-minted workspace scope/);
  await assert.rejects(f.repository.interruptRun(forged, "r1", 1, T0, "X"), /resolver-minted workspace scope/);
  await assert.rejects(f.repository.recoverExpiredLeases(forged, T0, 1), /resolver-minted workspace scope/);
});
