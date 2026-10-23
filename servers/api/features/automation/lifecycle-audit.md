# Automation lifecycle audit (in-memory contract)

The lifecycle service appends immutable audit events when a pre-authorized lifecycle
transition succeeds or is denied. This is a pure/in-memory contract only: it does not
resolve identity or workspace scope, authorize operations, persist events, or provide
tamper-resistant storage. ADR-0008 and an approved persistence/audit design remain required
before production use.

Durable production audit requires a database role that can append records but cannot edit or
delete prior events. Retention is pending owner approval; approximately 400 days is only a
proposal, not an accepted retention period. No event is purged by this in-memory contract.

## Event shape

| Field | Meaning |
|---|---|
| `workspaceId` | Explicit workspace context supplied by the caller |
| `actor.type`, `actor.id` | Actor type and identifier |
| `action` | `enable`, `pause`, `resume`, `disable`, or `archive` |
| `target.type`, `target.id` | Always `automation` and the automation identifier |
| `occurredAt` | Caller-supplied ISO-8601 instant |
| `outcome` | `succeeded` or `denied` |
| `correlationId` | Explicit request/operation correlation identifier |
| `change.status` | Previous and resulting lifecycle status; denied changes keep the same status |
| `change.version` | Active version number or `null` |

Events intentionally contain no rule, action configuration, recipient, secret, or arbitrary
caller-supplied summary. The service copies only the documented actor fields and constructs
the change summary from lifecycle state.

## Transition rules

| Current status | Action | Next status |
|---|---|---|
| `draft` / `disabled` | `enable` (published version required) | `enabled` |
| `enabled` | `pause` | `paused` |
| `paused` | `resume` (published version required) | `enabled` |
| `enabled` / `paused` | `disable` | `disabled` |
| `disabled` | `archive` | `archived` |

Invalid state transitions do not append a success event. A denied otherwise-valid transition
appends a `denied` event, leaves lifecycle status unchanged, and returns a denied result.
The in-memory revision advances for either appended event; this behavior is provisional and
is not a substitute for a durable atomic append or optimistic-concurrency check.
