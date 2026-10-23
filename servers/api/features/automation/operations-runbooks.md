# Operations: dashboards, alerts and runbooks (AE-T-071.2)

**Task:** AE-T-071.2, Create dashboards, alerts and operational runbooks
**Story:** AE-US-071, Release with a safe rollback and kill switch
**Requirements:** NFR-008, NFR-014; spec 14.4, Part B sections 18.4, 21.4, 23
**Operating owner:** Abid Ullah
**Status:** Implemented for application-layer scope; verification pending. Severity levels and response times are NOT approved (Part B section 23); the levels below are provisional.

## How this fits together

| Piece | File |
|---|---|
| Signal collection (queue, outbox, DLQ, tenant scope) | `ops.signals.ts` |
| Alert rules and thresholds | `ops.alerts.ts` |
| Dashboard panels and coverage checks | `ops.dashboard.ts` |
| Fire and resolve notifications with dedupe | `ops.monitor.ts` |
| DLQ runbook as code (locate, diagnose, resolve) | `ops.runbook.ts` |
| Read-only queue health adapter | `createMongoRunQueueHealth` in `run.history.repository.ts` |

Thresholds have no defaults. The owner sets them from the load baseline with `createAlertThresholds` (spec 18.4). Warning means ticket; critical means page (provisional routing). Every alert carries owner, runbook link and dashboard panel.

## Alert catalogue

| Rule | Signal | Level logic | Runbook |
|---|---|---|---|
| `QUEUE_AGE` | oldest eligible queued run age | warning/critical thresholds | Queue backlog |
| `LEASE_STALLED` | running runs with an expired lease | warning/critical thresholds | Lease expiry and stalled reaper |
| `OUTBOX_STALLED` | oldest pending outbox event age | warning/critical thresholds | Outbox stall |
| `DEAD_LETTER_BACKLOG` | DLQ count and oldest age | `evaluateDeadLetterBacklog` | DLQ recovery |
| `TENANT_SCOPE_VIOLATION` | violation count | any value above 0 is critical | Tenant isolation concern |
| `SIGNAL_UNAVAILABLE` | a configured source threw | warning | Signal unavailable |

Signals nobody configured are reported as `unmonitored`, never as green.

## Queue backlog

Alert: `QUEUE_AGE`. Panels: queue-age, runs, run-duration.

1. Check the release kill switch. If engaged (`pause-execution` or `pause-intake`), the backlog is expected; follow its release procedure instead.
2. Check `LEASE_STALLED` and worker health. No workers means start workers; a stalled reaper means follow the lease runbook.
3. Check quota rejections and loop guard trips for a noisy workspace. Fairness caps apply per workspace.
4. Check provider errors (action-attempts panel). A slow provider needs backpressure, not more workers.
5. Do not delete queued runs. If load is the cause, scale workers only after confirming the database is not the bottleneck.

## Lease expiry and stalled reaper

Alert: `LEASE_STALLED`. Panels: lease-stalled, retries.

1. Runs still marked running past their lease mean a worker died or the reaper (`recoverExpired`) is not running.
2. Confirm the reaper job is scheduled and logging "Expired lease recovered".
3. If the reaper is healthy and the count stays up, a worker is crashing mid-run. Inspect run history for the affected runs.
4. Recovery is safe: effects are protected by idempotency keys, and a stale worker's writes are rejected by the fencing token.

## Outbox stall

Alert: `OUTBOX_STALLED`. Panels: outbox-age, outbox-pending.

1. Check that the relay is enabled (outbox flag) and running.
2. Check database health. The relay needs majority writes.
3. A crashed relay is recovered when its lease expires; duplicate delivery is tolerated by the inbox.
4. Never delete unpublished outbox records. Accepted events must end as matched, ignored, rejected or quarantined.

## DLQ recovery

Alert: `DEAD_LETTER_BACKLOG`. Panels: dlq-backlog, retries. Permissions: `automation.run.read`, `automation.run.replay`.

Use `createDlqRunbook` (or the run recovery API):

1. **Locate:** `locate` lists dead-lettered runs, newest first.
2. **Diagnose:** `diagnose` is read-only and returns the next step and the revision.
   - `retry`: fix the cause, then resolve.
   - `confirm-non-idempotent`: verify the effect did not happen, then resolve confirming those action indexes.
   - `reconcile-first`: an action has an unknown outcome. Confirmation cannot override this. Escalate.
   - `escalate`: unknown action type or an action still running. Do not retry.
3. **Resolve:** `resolve` requeues the same run (same effect keys) with a written reason and the diagnosed revision. A stale revision is a conflict; diagnose again.

Every attempt is audited. Unauthorized callers always see "not found".

## Tenant isolation concern

Alert: `TENANT_SCOPE_VIOLATION` (critical, any value above 0). Panel: tenant-scope.

1. Treat as a possible cross-tenant exposure. Engage the kill switch (`pause-intake`) first; history is kept.
2. Preserve evidence: do not delete runs, audit records or logs.
3. Notify the security owner. Follow the incident process; do not hard-code notification deadlines.
4. Release the kill switch only after review (`reviewConfirmed`).

## Signal unavailable

Alert: `SIGNAL_UNAVAILABLE`. Panel: monitoring-health.

1. A configured source threw, so related alerts cannot be trusted. Identify the signal in the alert reasons.
2. Check the database and the relevant repository. Treat as a degraded-monitoring incident until it recovers.

## Support: inspecting a run without database access (TC-0717)

Support uses the run history API (`GET .../automations/{id}/runs` and `GET .../automation-runs/{runId}`) with `automation.run.read`.
Responses are allowlisted views: status, pinned version, timestamps, attempts and safe failure details. Lease owner, fencing token, chain key, trace context and payloads are never exposed.

## Not covered (explicit)

- Rate-based alerts (provider outage, loop spike, quota, retries) need the metrics backend (`enablers/observability`); no provider is chosen. The dashboard documents them with rationale.
- No real alert sink (pager/ticketing adapter) and no scheduled job calling `OpsMonitor.tick`.
- Runbooks for scheduler duplicate/miss (no scheduler exists), database outage and bad deploy are not written yet (AE-T-071.3 and rollback drill).
- `createMongoRunQueueHealth` is not tested against Mongo here.
- Reviewer sign-off by the operating owner and a staging drill are still pending, so the task is not claimed Done.