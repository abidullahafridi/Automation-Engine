# Quotas, Rate Limits and Fairness (AE-T-041.2) + Run Protection Wiring (AE-T-041.1)

**Task:** AE-T-041.2, Add per-workspace action/event quotas
**Story:** AE-US-041, Stop runaway automation chains
**Requirements:** FR-019, FR-020, BR-010; spec D-28, section 11.4, Part B section 18
**Owner:** Abid Ullah
- **Status (reviewed 2026-10-21):** Loop guard, per-workspace/global quotas, admin-override bounds, worker concurrency gate, matcher wiring, and loop-blocked `skipped` run persistence are implemented in the current code. `RunStatus` includes terminal `skipped`; `StoredRun` includes `chainKey`/`hop`; the matcher persists lineage for admitted runs and records permanent loop blocks as skipped. Evidence: `tests/trigger.protection.test.ts`, `tests/run.repository.test.ts`, and `tests/wiring.mongo.test.ts` (Mongo case requires `MONGO_URI`). The previous “Not covered” entries for skipped status and chain persistence are stale and removed below. Remaining: trusted ingest redelivery after `retryAfterMs`, override-management API with audit, real metrics sink, and measured load/fairness tuning (AE-E06). Limits remain provisional.

## Windows and limits (PROVISIONAL)

Fixed windows. `retryAfterMs = windowEnd - now`, so the result is deterministic under an injected clock.

| Kind | Window | Per-workspace | Global (also override hard cap) |
|---|---|---|---|
| `events` | 60 s | 600 | 6,000 |
| `runs` | 60 s | 300 | 3,000 |

These are starter values, not plan entitlements. They must be tuned by the AE-E06 load test and changed via config/ADR. Limits must be positive integers and `workspaceLimit <= globalLimit`, or the service refuses to start.

## Decision order (`quota.service.ts`)

1. `ownsScope`, otherwise `SCOPE_MISSING` (not retryable).
2. Admin override read (bounded, see below).
3. Workspace counter, otherwise `WORKSPACE_QUOTA_EXCEEDED`. The global counter is not touched.
4. Global counter, otherwise `GLOBAL_QUOTA_EXCEEDED` and the workspace unit is refunded.
5. Storage failure at any step: `QUOTA_UNAVAILABLE` (retryable, fail closed).

Denied calls never consume quota. Map exhaustion to API error `AUTOMATION_QUOTA_EXCEEDED` (429) with `Retry-After`.

## Atomicity

Mongo counters (`quota.repository.ts`) use one `findOneAndUpdate` with `used < limit`, upsert and a unique index on `(workspaceId, name, windowStart)`. A duplicate-key error is resolved by one non-upsert retry, so racing first inserts are counted correctly. TTL index removes expired windows.

## Admin override controls

- `QuotaOverridePort.workspaceLimit` may only change the per-workspace limit.
- Value must be an integer from 1 to the global limit. Anything else is ignored and the configured limit applies.
- A read failure also falls back to the configured limit.
- Writing overrides needs its own permission and audit record. That API is NOT part of this task.

## Operator signals

- `rejected` signal: `{ code, kind, workspaceId, retryAfterMs }`. Metric `automation_quota_rejections_total` uses `code` as its only label.
- `nearLimit` signal fires once per window at 80% of the workspace limit (spec D-28).
- Telemetry failures never change a decision.

## Worker capacity

`workspace.concurrency.ts` caps in-flight runs per workspace and in total, and serves candidate workspaces round-robin. A workspace at its cap is skipped, so a noisy workspace cannot take all capacity. The gate is per process; cross-process capacity still depends on the global quota and lease model.

## Wiring into the trigger matcher

`createTriggerMatcher({ ..., protection })` is optional. Without it nothing changes.

With it:

1. Event quota is checked before any candidate lookup. Denial returns `rejected` with reason `quota-exceeded` and `retryAfterMs`. The caller keeps the accepted event and retries later (nothing is dropped silently).
2. Per candidate: `exists` (redelivery spends nothing), run quota, loop guard, then create the run with `chainKey` (correlationId, else eventId) and `hop`.
3. Results add `blockedRuns`, `quotaRejectedRuns`, `retryAfterMs` only when greater than zero.
4. An origin with `hop: 0` is blocked as `LINEAGE_INVALID` (fail closed).
5. Protection without `MatcherRunRepository.exists` throws at construction.

A concurrent redelivery race can spend one extra unit before the unique index decides. This errs on the conservative side.

## Tests

TC-0415 to TC-0418 in `quota.service.test.ts` (in-memory) and `quota.mongo.test.ts` (real Mongo, needs `MONGO_URI`). Matcher wiring in `trigger.protection.test.ts`.

## Not covered yet

- The ingest path must keep the accepted event and re-deliver after `retryAfterMs`.
- Admin API to set and audit overrides.
- Real metrics sink, and load-test tuning of every limit.
