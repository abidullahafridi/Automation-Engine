# Automation Telemetry (AE-T-042.1)

**Task:** AE-T-042.1, Add structured logs, metrics and trace propagation
**Story:** AE-US-042, Trace a run from event through each action
**Requirements:** FR-011, FR-015, FR-024, NFR-006, NFR-014; spec sections 14.1 to 14.3
**Owner:** Abid Ullah
- **Status (2026-10-17): Implemented for tested-telemetry-sink scope; verification pending.** Structured log fields with redaction, bounded-label metrics catalog, W3C traceparent propagation, and adapters for loop-guard and quota telemetry are covered by TC-0421–TC-0424. Remaining: validation in the target observability stack (`enablers/observability`), `@workspace/logging` composition-root adapter, worker/executor call sites, and persisting `traceparent` on runs and outbox records.
## Structured logs

`createAutomationTelemetry({ logger, metrics })` writes through a `TelemetryLogger` (info/warn/error with a message and a context object). Only these fields are kept; everything else is dropped:
workspaceId, automationId, automationVersion, runId, actionIndex, actionType, eventId, correlationId, causationId, traceId, attempt, durationMs, errorCode, retryDecision, fencingToken.

Every value passes `redactValue`. No full payloads are logged.

## Metrics (catalog in `telemetry.metrics.ts`)

| Metric | Type | Labels |
|---|---|---|
| `automation_events_total` | counter | `event_type`, `result` (accepted/duplicate/rejected/quarantined) |
| `automation_runs_total` | counter | `status`, `trigger_type` |
| `automation_run_duration_seconds` | histogram | `status` |
| `automation_action_attempts_total` | counter | `action_type`, `outcome` (succeeded/failed/timed_out) |
| `automation_action_duration_seconds` | histogram | `action_type` |
| `automation_retries_total` | counter | `action_type`, `reason` |
| `automation_loop_guard_trips_total` | counter | `reason` (loop block code) |
| `automation_quota_rejections_total` | counter | `quota` (workspace/global/unavailable/scope) |

Cardinality rules (checked by the in-memory sink, mirrored by the real exporter):
- Label keys must match the catalog exactly. Extra or missing keys are rejected.
- Enum labels accept only listed values.
- Open labels (`event_type`, `trigger_type`, `action_type`) must match `^[a-z][a-z0-9_.]{0,63}$` and are capped at 50 distinct values per label.
- runId, automationId, workspaceId, userId and eventId are never labels.

## Trace propagation

W3C `traceparent` (`00-<32hex>-<16hex>-<2hex>`). The event carries the root context; the run and each action store a child (`traceFactory.child(parent)`): same `traceId`, new `spanId`. Because the queue boundary is a database row, store `traceparent` on the outbox record and on `StoredRun`. A missing or malformed parent starts a new trace.

## Redaction (`telemetry.redaction.ts`)

- Keys containing authorization, cookie, token, secret, password, apikey, credential or privatekey are replaced. `fencingToken` is explicitly safe.
- Text is scrubbed for Bearer tokens, JWTs, URL passwords and `key=value` secrets.
- Errors are reduced to name, code and scrubbed message. Stacks are never logged.
- Depth, entry count and string length are bounded; circular input is safe.

## Failure behavior

Telemetry methods never throw and never change a decision. A failing logger or metrics sink is swallowed.

## Wiring

- `loopGuardTelemetry` plugs into `createLoopGuard({ telemetry })`.
- `quotaTelemetry` plugs into `createQuotaService({ telemetry })`.

## Tests

TC-0421 correlation, TC-0422 metrics increment, TC-0423 bounded labels, TC-0424 redaction, in `tests/telemetry.test.ts`.

## Not covered (explicit)

- Validation in the real observability stack. `enablers/observability` owns the exporter (Prometheus/OTel), dashboards and alerts; no provider is chosen yet.
- Adapter from `TelemetryLogger` to `@workspace/logging` `Logger` at the composition root (a direct assignment should work; confirm with typecheck).
- Calling `recordRun`, `recordAction` and `recordRetry` from the run worker and action executor, and storing `traceparent` on `StoredRun` and outbox records.
- Alert thresholds (AE-T-071.2).