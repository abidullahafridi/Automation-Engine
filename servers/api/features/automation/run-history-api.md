# Run history API (AE-T-052.1)

- `GET /api/v1/workspaces/{workspaceId}/automations/{automationId}/runs?limit&cursor`
- `GET /api/v1/workspaces/{workspaceId}/automation-runs/{runId}`

## Guarantees
- Read-only port (`RunHistoryRepository`): no write method exists. Every query filters by the trusted `workspaceId`.
- Order: `createdAt desc, runId desc`. The cursor is `(createdAt, runId)` of the last item, so runs inserted
  later (newer `createdAt`) never cause skipped or duplicated items on later pages. Page size 1 to 100 (default 20).
- Index: `{workspaceId, automationId, createdAt:-1, runId:-1}` (`run_history_by_automation`).
- Missing, cross-workspace, or unauthorized automation/run always returns a non-enumerating 404.
- Permission: `automation.run.read` evaluated against the automation resource.

## Exposed fields (allowlist)
Run: runId, eventId, automationId, version, contentHash (pinned version), status, createdAt, updatedAt,
runAfter and attemptCount (detail only), interruptedReason, skipReason, failure.
Failure: reason, attempts, firstAttemptAt, deadLetteredAt, failureCode (scrubbed), errorClass, actionIndex.
Action: actionIndex, attempt, status, actionType, createdAt, updatedAt.

Never exposed: leaseOwner, leaseExpiresAt, fencingToken, chainKey, traceparent, event payloads, action
inputs, or any other stored field not listed above.

## Not included
Retry/replay (AE-T-052.2) and a separate `GET .../actions/{index}` endpoint: action detail is returned inline
in the run detail.