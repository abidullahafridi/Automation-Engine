# ADR-0004: Run queue, worker claims, leases, and fencing

- **Status:** Deferred; proposed direction only
- **Date:** 2026-10-14
- **Decision owner:** Product and engineering owners (not identified in repository)
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Review:** No independent reviewer or product approval recorded
- **Next review:** Before AE-T-030.1 or AE-T-084.1 is marked Ready

## Context

The specification proposes storing runs durably in MongoDB and using them as the execution
queue. Workers would claim runs atomically with expiring leases and monotonically increasing
fencing tokens. The repository has no run store, worker, queue, transaction API, or verified
MongoDB topology. Claim contention, throughput, and workload are unmeasured.

## Drivers

- At most one current worker owns a run generation.
- A worker whose lease expired cannot commit stale state.
- External side effects need idempotency independently of lease ownership.
- Keep durable run history and work ownership consistent.

## Options

1. **Proposed: run store as queue, atomic claim, lease, and fencing token.** Fits the
   proposed Mongo system of record; requires database-supported conditional atomic updates
   and integration/concurrency tests.
2. **Separate broker and run store.** Separates dispatch from history but adds cross-system
   consistency and duplicate/reconciliation requirements.
3. **Unfenced in-memory or lease-only claims.** Rejected for durable workers because a
   paused worker could write after ownership changes.

## Decision

**Deferred.** The proposed run-store/lease/fencing design is a candidate, not an accepted
implementation contract. Accept it only after ADR-0002/0003 settle delivery and persistence
prerequisites and concurrency tests can run against the supported database. Do not implement
claims without fencing and action idempotency.

## Consequences

- No worker-claim strategy is authorized yet.
- If accepted, every state mutation after claim must condition on the fencing token and
  expected state; a zero-match stale write must stop the worker.
- Leases cannot undo external effects; action idempotency/reconciliation remains required.

## Security and operations

Use trusted server/database time for lease expiry where supported, bound lease renewal and
reaping, record claim/recovery transitions, and alert on lease expiry and stale-write
rejection. Never treat a lease as authorization to widen workspace scope.

## Follow-ups and blocked work

- Confirm Mongo atomic-update and time semantics in the supported topology.
- Define worker count, lease TTL/renewal, shutdown behavior, and recovery budgets from
  workload evidence.
- **Blocked:** AE-US-030, AE-T-030.1/.2, AE-US-084, AE-T-084.1/.2/.3, and execution stories
  that require durable claims or recovery.

## Deferral record

Deferred on 2026-10-14 because the durable store/topology and workload are unverified and no
worker or database integration-test infrastructure exists. `@adeelchainz` owns routing this
decision for review; product and engineering owners must approve the claim/recovery contract
before the blocked stories become Ready.

## Evidence

- [Automation Engine specification, D-05–D-06 and §11.3](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-030 and AE-US-084](../../automation-engine-backlog.md)
- [Repository audit, AE-T-000.2](../architecture/repository-audit.md)
- [API MongoDB integration contract](../../servers/api/integrations/mongodb/types.ts)
