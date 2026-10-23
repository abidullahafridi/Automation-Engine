# Run recovery: retry vs replay (AE-T-052.2)

| | Retry | Replay |
|---|---|---|
| Endpoint | `POST .../automation-runs/{runId}/retry` | `POST .../automation-runs/{runId}/replay` |
| Effect | Same run goes dead_letter -> queued | NEW run, `replayOf = source run`, source untouched |
| Effect keys | Same (effects stay deduplicated) | New (a repeated effect is possible) |
| Source state | dead_letter | dead_letter or failed |
| Concurrency | `If-Match: "<run revision>"` | n/a (new run, deterministic id) |
| Required | `Idempotency-Key`, `reason` (1-500 chars) | same |

## Rules
- Permission `automation.run.replay` on the automation; denial returns 404 and is audited (`denied`).
- Blocked, never overridable by confirmation: an action with `unknown_outcome` needs reconciliation first.
  `confirmedActionIndexes` only confirms non-idempotent actions that are otherwise safe (spec D-15).
- Every attempt is audited (`succeeded`, `denied`, `blocked`) with actor, reason, and correlation ID.
- Idempotency: same key + same payload returns the stored result (`idempotentReplay: true`) and starts nothing new;
  same key + different payload is 422; a concurrent duplicate is 409 `AUTOMATION_REQUEST_IN_PROGRESS`.
  Only successes are stored; any other outcome releases the key. Keys are scoped to workspace and principal.

## Operator procedure
1. Inspect the run (`GET .../automation-runs/{runId}`), note `revision` and action attempts.
2. If an action is `unknown_outcome`, reconcile with the provider first; do not retry blindly.
3. Prefer retry. Use replay only when the original run cannot continue; expect new effects.
4. Send the request with a fresh `Idempotency-Key`; reuse the same key only to repeat the identical request.