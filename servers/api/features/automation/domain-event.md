# Task status changed event contract

`task.status_changed` schema version 1 is a feature-owned, validated event envelope.
It contains the event identity and time, workspace scope, actor provenance, task
aggregate identity, and only the task fields currently needed by the automation
trigger and its condition allowlist.

| Field | Contract |
|---|---|
| `eventId` | Non-empty identifier used by downstream deduplication |
| `eventType` | `task.status_changed` |
| `schemaVersion` | Integer literal `1` |
| `occurredAt` | ISO-8601 instant |
| `workspaceId` | Non-empty workspace identifier |
| `actor` | `user`, `system`, or `automation` plus a non-empty identifier |
| `aggregate` | `task` plus a non-empty task identifier |
| `aggregateVersion` | Non-negative aggregate revision at emit time; optional for historical v1 readers |
| `correlationId` | Non-empty end-to-end correlation identifier; optional for historical v1 readers |
| `causationId` | Optional identifier of the command/event that caused this event |
| `origin` | For newly emitted automation events, automation ID, run ID, and non-negative chain hop; forbidden for non-automation actors |
| `payload.task` | Current and previous status, priority, and archived flag |

Unknown envelope, actor, aggregate, or payload keys are rejected. Raw task descriptions,
credentials, secrets, and unrelated task data are not part of this contract. Validation
checks shape only; the domain publisher must derive workspace, actor, and aggregate
provenance from trusted domain context.

Compatibility tests retain a representative v1 event without the additive provenance
fields and require current readers to accept it. New producers should populate
`aggregateVersion` and `correlationId`; automation-generated events should also populate
`origin`. Readers keep these additions optional for historical v1 records. Additive
optional fields may be introduced without rejecting historical events; making a new
field mandatory or otherwise rejecting historical v1 events fails the compatibility test.
A breaking contract requires a new schema version and an explicit migration/reader
compatibility plan.

This contract does not publish events, provide durable storage, or implement an outbox.
Those behaviors belong to AE-T-020.2 and depend on the accepted event-delivery and
transaction decisions.
