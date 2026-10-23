# Loop Protection and Causation Lineage (AE-T-041.1)

**Task:** AE-T-041.1, Add causation lineage and loop circuit breaker
**Story:** AE-US-041, Stop runaway automation chains
**Requirements:** FR-019, BR-010, INV-10; spec D-13, section 11.7
**Owner:** Abid Ullah
**Status:** Done

## Model

- `origin = { automationId, runId, hop }` is present only on automation-generated events. Human/system events have hop 0.
- By default automation-generated events do not trigger automations (D-13). A trigger must opt in with `allowAutomationOrigin: true`.
- `chainKey` identifies a whole chain (the root event's `correlationId`).

## Runtime decision order (`loop.guard.ts`)

1. Trusted scope (`ownsScope` and workspace match), otherwise `SCOPE_MISSING`.
2. Lineage well formed, otherwise `LINEAGE_INVALID`.
3. Origin automation equals target automation, then `SELF_TRIGGER`.
4. `hop > maxHops`, then `HOP_LIMIT_EXCEEDED`.
5. Atomic per-chain budget, then `CHAIN_BUDGET_EXCEEDED` (denied runs do not consume budget).
6. Budget port failure, then `BUDGET_UNAVAILABLE` (retryable, fail closed).

## Limits (provisional, spec section 3.4)

| Limit | Value |
|---|---|
| `maxHops` | 5 (hop 5 allowed, hop 6 blocked) |
| `maxRunsPerChain` | 25 (provisional, to be tuned by load test) |

Limits must be positive safe integers or the guard refuses to start.

## Operator signal

Each block calls `LoopGuardTelemetry.tripped` with `{ code, workspaceId, automationId, eventId, hop, message }`. No event payload is included. The metric `automation_loop_guard_trips_total` must use `code` as its only label. A telemetry failure never turns a block into an allow.

## Authoring analysis

- Direct self-cycle (action emits the trigger's own event type, with opt-in): error `SELF_CYCLE`.
- Indirect cycle across automations: warning `INDIRECT_CYCLE` (graph limited to 1,000 nodes).
- Automations without `allowsAutomationOrigin` create no edges.

## Tests

TC-0411 self-loop, TC-0412 legitimate chain, TC-0413 hop and budget caps, TC-0414 actionable signal, in `tests/loop.guard.test.ts`. They also cover fail-closed paths and atomic budget behavior.

## Remaining verification / production work

- Current code wires a Mongo-backed chain budget through `createMongoQuotaStores`, applies it in `createTriggerMatcher`, persists `chainKey`/`hop` on queued runs, and records permanent loop blocks as terminal `skipped` runs. Evidence is in `tests/trigger.protection.test.ts`, `tests/quota.mongo.test.ts`, and `tests/wiring.mongo.test.ts` (Mongo tests require `MONGO_URI`).
- Publishing the metric to the real observability stack remains open; only injected/test telemetry is configured in this repository.
- Re-run the Mongo race/TTL tests against the approved target and include them in the release evidence before marking the production acceptance criteria complete.
