# Run and action state model

`automation_runs` is both durable run history and the queue. A run starts `queued`; `queued → running|cancelled`, `running → retry_wait|completed|failed|cancelled|dead_letter`, and `retry_wait → running|cancelled` are legal. `retry_wait` retains the first attempt instant and becomes claimable only when its persisted `runAfter` is due. Terminal states have no outgoing transition.

Every transition supplies the expected `revision`; MongoDB updates only when the stored revision and source status match. A claim atomically changes an eligible `queued` or due `retry_wait` run to `running`, assigns a lease owner and expiry, increments `revision`, and increments the monotonic `fencingToken`. A subsequent worker generation must supply that token to commit its transition, preventing a stale owner from writing after re-claim.

`automation_action_attempts` records every attempt with a unique `(workspaceId, runId, actionIndex, attempt)` key. The worker writes `running` before invoking the handler and updates the same attempt afterward. On retry, actions with a previously persisted `succeeded` attempt are skipped. A prior `running`/`unknown_outcome` is never blindly executed again: it requires reconciliation or a separately authorized replay.





## Dead-letter state (AE-T-032.2)

`dead_letter` is added to `RunStatus`. It is entered only through `deadLetterRun` (fenced by the fencing token, persists
`deadLetter` with reason and attempts, clears the lease) and is terminal for the generic `transition` table. The only exit is
the audited `requeueDeadLetter` (revision checked, `dead_letter -> queued`, `interruptedReason = DEAD_LETTER_RETRY`). See
`dead-letter-runbook.md`.

## Retry scheduling (AE-T-030.2)

Transient errors use `retry.policy.ts` with injected clock/jitter. The fenced repository transition persists `retry_wait`, `runAfter`, `firstAttemptAt`, and a safe failure code before releasing the lease. The next worker claim is eligible only after `runAfter`; attempt count remains bounded by the global policy and may be lowered by the published rule. Exhausted attempt/age budgets go through `dead_letter`. Production values for backoff and age remain provisional pending ADR/load evidence.



