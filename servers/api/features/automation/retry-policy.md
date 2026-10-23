# Retry decision core (AE-T-032.1)

`retry.policy.ts` decides what happens after a failed action attempt. It is pure: no I/O, no
clock and no randomness of its own. The caller injects `now` and `jitter`. `run.execution.ts`
persists the resulting fenced `retry_wait`/`runAfter` transition; the worker claims it only when due.
Dead-letter inspection and authorized recovery remain AE-T-032.2 responsibilities.

## Decisions

| Error class (from the executor) | Decision | Reason code |
|---|---|---|
| `transient` | retry with bounded full-jitter backoff | `TRANSIENT_FAILURE` |
| `permanent` | stop, outcome `failed` | `PERMANENT_FAILURE` |
| `ambiguous` | stop, outcome `unknown_outcome` (reconcile, never repeat blindly) | `AMBIGUOUS_OUTCOME` |
| transient, attempt budget used up | stop, outcome `dead_letter` | `MAX_ATTEMPTS_EXHAUSTED` |
| transient, age budget would be exceeded | stop, outcome `dead_letter` | `MAX_AGE_EXHAUSTED` |
| invalid input (bad timestamp, attempt < 1, now before first attempt, bad rule cap) | stop, outcome `failed` (fail closed) | `INVALID_RETRY_INPUT` |
| successful action | `none` | n/a |

## Rules

- **Attempts count the first attempt** (spec 3.4). The policy cap is 5. A rule's
  `executionPolicy.maxAttempts` can lower the cap, never raise it.
- **Backoff** (spec 11.6): `random(0, min(maxDelayMs, baseDelayMs * 2^(attempt - 1)))`. A faulty or
  non-finite jitter sample is treated as the maximum, so the cap always holds.
- **Retry-After** is honoured: `delay = max(backoff, retryAfter)`. A provider hint never shortens the
  backoff and may exceed `maxDelayMs`. If the resulting delay would exceed `maxAgeMs`, the decision is
  `dead_letter` (we do not retry earlier than the provider asked). `parseRetryAfter` accepts
  delta-seconds and IMF-fixdate and returns `undefined` for anything else.
- **Age budget**: `now + delay - firstAttemptAt` must not exceed `maxAgeMs`.

## Provisional defaults

| Setting | Value | Source |
|---|---|---|
| `maxAttempts` | 5 | spec 3.4 |
| `baseDelayMs` | 1,000 | proposal |
| `maxDelayMs` | 60,000 | proposal |
| `maxAgeMs` | 3,600,000 | proposal |

Only `maxAttempts` comes from the specification. The three delay and age values are proposals and
must be confirmed by ADR-0007 and load tests. `createRetryPolicy` rejects invalid values.

## Per action type

| Action type | Side effect | Transient (retried) | Permanent (not retried) | Ambiguous |
|---|---|---|---|---|
| `notification.send` | `internal-idempotent` | provider transient error, unknown handler error, executor timeout, caller abort | `recipient_not_found`, `recipient_disabled`, `validation`, provider permanent error, invalid input, permission denied | none (the notification service dedupes on the idempotency key, so a retry is safe) |

Registered classes live in `retryClassification` of `notificationSendAction` in
`automation.registry.ts`. A new action must add its row here and its tests before it ships.

## Observability

`observeRetryDecision` emits low-cardinality counters; unregistered action types are labelled `unknown`.

| Metric | Labels | Emitted when |
|---|---|---|
| `automation_retries_total` | `action_type`, `reason` | a retry is scheduled |
| `automation_dead_letter_total` | `action_type`, `reason` | the attempt or age budget is exhausted |
| `automation_retry_stopped_total` | `action_type`, `outcome`, `reason` | a permanent, ambiguous or invalid-input stop (addition to spec 14.2) |

## Remaining scope

- Passing provider `Retry-After` metadata through the action failure contract (the policy supports it, but the executor currently does not expose it).
- The dead-letter inspection and replay API (AE-T-032.2) and per-provider retry budgets and breakers.
- The run worker does not call the executor or this module yet.
