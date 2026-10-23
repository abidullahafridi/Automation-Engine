# Runtime Wiring (AE-E04 closure)

**Scope:** connects AE-T-040.1 (execution context), AE-T-041.1/.2 (loop guard, quotas), AE-T-042.1 (telemetry) and AE-T-042.2 (audit) to the matcher, run worker and action executor.
**Owner:** Abid Ullah
**Status:** Implemented, verification pending.

**Verification note (2026-10-21):** `run.execution.test.ts`, `run.lease.test.ts`,
`concurrency-fairness.test.ts`, and `automation.architecture.test.ts` passed (27/27 total); the API suite
passed 311 tests with 13 Mongo-backed cases skipped. `MONGO_URI` and Docker are unavailable in this
environment, so Mongo persistence/retry scheduling remains unverified. The root `pnpm run validate`
also stops at the repository's audit/managed-scanner checks; see the task status in the backlog.

## Flow

event (with optional `traceparent`) -> quota (events) -> candidates -> per candidate: `exists`, quota (runs), loop guard -> queued run (or `skipped` run for a permanent block) -> worker claim -> `createRunExecutionHandler`:

1. Execution context (scope, enabled automation, creator standing). Denied: audit, optional pause, run `failed`.
2. Pinned version loaded and `contentHash` verified (INV-02).
3. Actions in order via the action executor (scope, schema, permission before every handler).
4. Fenced `running -> completed|failed`. A stale result is logged and not reported as this worker's outcome.

## Decisions

- A permanent loop block is recorded as a `skipped` run with `skipReason`. A retryable infrastructure fault and a quota deferral are NOT recorded, so redelivery can still create the run.
- Retry: transient failures call `retry.policy.ts` with injected jitter/clock and persist a fenced `running -> retry_wait` transition, `firstAttemptAt`, and due `runAfter`. Only due queued/retry-wait runs are claimable; exhausted attempt/age budgets become `dead_letter`. A rule may lower (never raise) the configured attempt cap.
- Ambiguous failure: attempt is `unknown_outcome`, run `failed`, never repeated blindly.
- Telemetry and audit are injected; `automation.runtime.ts` is the only place that assembles them.

## Bug fixed by this wiring

Matcher-created runs had no `runAfter`, `revision`, `fencingToken` or `updatedAt`, so `claimNext` could never claim them. The Mongo adapter now stores a claimable shape. `wiring.mongo.test.ts` proves it.

## Remaining integration gaps (explicit)

- Retry-after header propagation is not available in the action failure contract, so provider Retry-After cannot yet influence persisted scheduling.
- Notification effect deduplication and production provider delivery still depend on the approved Mongo NotificationPort adapter and platform membership contract.
- Run history and attempts are durable locally, but production Mongo topology, indexes/query plans and service startup loops require environment/release verification.
- Conditions are evaluated at match time only (the event snapshot is not stored on the run).
- A real `AutomationPauser` (needs a status update on the automation repository), spec D-12.
- Ingest path: calling `recordEvent`, and re-delivering after `retryAfterMs` on a quota denial.
- Scheduling: listing workspaces with queued work, running workers, and calling `recoverExpired` periodically.
- Adapter from `@workspace/logging` `Logger` to `TelemetryLogger`; wiring `createApp`; the audited executor in `action.outcome.ts` is not used.
