# Automation lifecycle API (AE-T-050.1)

Endpoints: `POST /api/v1/workspaces/{workspaceId}/automations/{automationId}/{enable|pause|resume|disable|archive}`

## State machine
| Action  | Allowed from        | Result   | Extra guard                  |
|---------|---------------------|----------|------------------------------|
| enable  | draft, disabled     | enabled  | a published version exists   |
| pause   | enabled             | paused   |                              |
| resume  | paused              | enabled  | a published version exists   |
| disable | enabled, paused     | disabled |                              |
| archive | disabled            | archived |                              |

## Concurrency
`If-Match: "<revision>"` is required. The repository applies a compare-and-set on
`(workspaceId, automationId, rev, status)`; a zero-match update is a conflict, never success.

## Idempotency / repeats
There is no silent no-op. Repeating a request returns a documented 409:
- same `If-Match` after success -> `AUTOMATION_REVISION_CONFLICT`
- fresh revision but status already reached -> `AUTOMATION_INVALID_TRANSITION`

## Authorization
Checked before revision/transition validation. Denial returns 404 (non-enumerating)
and records a `denied` audit event. Every success records one `succeeded` audit event.

## In-flight behavior
New trigger matching stops immediately (the matcher selects `enabled` headers only).
Cancelling queued/in-flight runs (spec D-20) belongs to the run worker/repository and is
NOT implemented by this task.