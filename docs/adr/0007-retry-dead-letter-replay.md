# ADR-0007: Retry, dead-letter, and replay semantics

- **Status:** Deferred; proposed direction only
- **Date:** 2026-10-14
- **Decision owner:** Product and engineering owners (not identified in repository)
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Review:** No independent reviewer or product approval recorded
- **Next review:** Before AE-T-032.1 or AE-T-032.2 is marked Ready

## Context

Workers and external providers can fail transiently, permanently, or after an ambiguous
side-effect outcome. The specification proposes bounded full-jitter backoff, honoring
`Retry-After`, retry budgets, a queryable dead-letter state, same-run retry with stable
idempotency keys, and a distinct replay that creates a new run and new effect keys. No
automation action/provider or retry infrastructure exists yet.

## Drivers

- Never retry indefinitely or create retry storms.
- Do not blindly repeat an ambiguous non-idempotent effect.
- Make retry versus replay behavior visible, authorized, and auditable.
- Preserve effect idempotency across worker retries.

## Options

1. **Proposed: bounded classified retries and a durable dead-letter state.** Handler classifies
   transient/permanent/ambiguous; exponential full jitter is capped and provider
   `Retry-After` is honored within policy.
2. **Retry every failure uniformly.** Rejected because permanent and ambiguous failures can
   repeat unsafe effects or amplify load.
3. **Treat replay as retrying the same run.** Rejected because operators need an explicit
   distinction between same-key recovery and a new logical execution.

## Decision

**Deferred pending action-specific behavior and product authorization review.** The proposed
baseline is bounded retries, terminal dead-letter visibility, same-run retry with stable
effect keys, and replay as a new linked run with new keys. Attempt/age/budget limits,
permissions, reason capture, and non-idempotent confirmation are not approved yet.

## Consequences

- No retry endpoint or automatic retry policy is authorized by this draft.
- Ambiguous outcomes must stop for reconciliation unless a handler has a verified
  idempotency/reconciliation strategy.
- Replay must not be implemented as an unreviewed alias for retry.

## Security and operations

Require distinct permission for retry/replay, audit actor/reason/outcome, redact provider
responses, cap attempts and total age, and alert on DLQ age and retry-budget exhaustion.
Active and unknown-outcome work must not be removed by retention cleanup.

## Follow-ups and blocked work

- Define error classes and retry profile for each first-release action/provider.
- Set retry budgets, attempt/age caps, circuit-breaker policy, and recovery permissions.
- **Blocked:** AE-US-032, AE-T-032.1/.2, replay management work, and any handler that can
  repeat external side effects.

## Deferral record

Deferred on 2026-10-14 because action/provider semantics, operational limits, and product
permissions are not established. `@adeelchainz` owns routing this decision; product and
engineering owners must approve policies before retry/replay stories become Ready.

## Evidence

- [Automation Engine specification, D-15 and §11.5–11.6](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-032 / AE-T-032.1 / AE-T-032.2](../../automation-engine-backlog.md)
- [Repository audit, queue and worker absence](../architecture/repository-audit.md)
