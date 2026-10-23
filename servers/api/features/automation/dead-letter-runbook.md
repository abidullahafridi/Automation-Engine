# Dead-letter runbook (AE-T-032.2)

A run is dead-lettered when a transient failure has used up its attempt or age budget
(`retry.policy.ts`, reasons `MAX_ATTEMPTS_EXHAUSTED` and `MAX_AGE_EXHAUSTED`). The run keeps its
status `dead_letter` and records `reason`, `attempts`, `firstAttemptAt`, `deadLetteredAt`, and the last
failure code and error class. It is never deleted.

## State rules

- `running -> dead_letter` happens only through `RunRepository.deadLetterRun` (fenced by the fencing
  token), never through the generic `transition` table.
- `dead_letter` is terminal for the generic table. The only way out is the audited retry
  (`requeueDeadLetter`, checked against the revision), which returns the same run to `queued` with
  `interruptedReason = DEAD_LETTER_RETRY`. The idempotency key (`sha256(runId:actionIndex)`) is unchanged,
  so effects already applied stay deduplicated.

## Access

| Operation | Permission | Unauthorized result |
|---|---|---|
| list, inspect | `automation.run.read` | "not found" (no existence leak) |
| retry | `automation.run.replay` | "not found", and a `denied` audit event |

Permission names must be verified against the platform policy engine. Only `user` and `system`
principals may recover; automation principals are rejected.

## Retrying a dead-lettered run

1. Inspect the run and read `deadLetter.reason`, the failing action and its attempts. Note `revision`.
2. Fix the cause first (provider outage, permissions, configuration). Do not retry blindly.
3. Retry with a written reason (1 to 500 characters; never include secrets) and the `revision` you inspected.
   A stale revision is a conflict: inspect again.

Every attempt writes one audit event (`succeeded`, `denied` or `blocked`) with actor, run, correlation id,
reason and the status change.

## When a retry is blocked

| Code | Meaning | What to do |
|---|---|---|
| `RECONCILIATION_REQUIRED` | An action ended `unknown_outcome`: its effect may have happened. It can never be confirmed away. | Check the real outcome in the target system. A reconciliation operation does not exist yet; escalate to the owning engineer. |
| `UNCONFIRMED_NON_IDEMPOTENT` | A failed action is not safe to repeat. | Verify the effect did not happen, then retry again confirming that action index explicitly. |
| `UNKNOWN_ACTION_TYPE` | The action type is missing or no longer registered. | Escalate; the run cannot be judged safe. |
| `RUN_NOT_SETTLED` | An action is still marked running. | Wait or escalate; this should not occur for a dead-lettered run. |
| `NOT_DEAD_LETTER` (audit only) | The run is no longer dead-lettered (already retried). | Re-inspect. |

## Alerting

Backlog data comes from `DeadLetterService.backlog(scope)` (count and oldest age). `evaluateDeadLetterBacklog`
maps it to `ok`, `warning` or `critical` using `DeadLetterAlertThresholds`. There are deliberately no default
numbers: the service owner must choose thresholds from the load baseline (spec 18.4). Wire the result into the
alerting backend and name an owner, severity and escalation before enabling it.

Counters: `automation_dead_letter_total{action_type,reason}` (from the retry decision),
`automation_dead_letter_recovery_total{outcome}` (retry attempts).

## Not part of this task

- Replay as a NEW run (needs the run unique index changed; AE-T-052.2).
- A reconciliation operation for `unknown_outcome` actions.
- HTTP routes, durable audit storage (ADR-0010), and the worker calling `recordDeadLetter`.
