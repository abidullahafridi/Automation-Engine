# ADR-0009: Schedules, timers, and daylight-saving behavior

- **Status:** Deferred; proposed product behavior only
- **Date:** 2026-10-14
- **Decision owner:** Product and engineering owners (not identified in repository)
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Review:** No independent reviewer or product approval recorded
- **Next review:** Before AE-T-060.1 or AE-T-060.2 is marked Ready

## Context

The repository has no scheduler, timer service, durable occurrence store, or time-trigger
implementation. The specification proposes IANA time zones, durable unique occurrence
identity, coalescing recent missed schedules, and defined spring-forward/fall-back behavior.
These are user-visible product semantics as well as reliability requirements.

## Drivers

- Duplicate scheduler polls must not create duplicate logical occurrences.
- Persisted schedule instants must be unambiguous UTC values while preserving the configured
  IANA zone.
- Restart, downtime, pause, and schedule edits must have explicit semantics.
- DST and month/calendar boundaries must be deterministic and testable.

## Options

1. **Proposed: durable occurrence records with unique keys and an explicit IANA zone.**
   Scheduler calculates UTC instants and idempotently creates occurrences/runs.
2. **In-memory timers only.** Rejected for durable automation because restart can lose or
   duplicate scheduled work.
3. **Run every missed occurrence after downtime.** Rejected as the default due to unbounded
   catch-up/fan-out risk; a bounded policy needs product ratification.
4. **Coalesce or skip missed occurrences and choose deterministic DST rules.** Proposed
   behavior is coalesce once within a one-hour window, shift a nonexistent time to the first
   valid instant, and run an ambiguous time once at its first occurrence.

## Decision

**Deferred pending product approval.** Durable idempotent occurrence identity is the proposed
technical direction. The catch-up window, DST gap/fold behavior, minimum interval, pause/
disable behavior, and relative-timer stale checks are user-visible semantics and are not
accepted without product review.

## Consequences

- Time-trigger stories remain blocked.
- Do not implement a scheduler that silently chooses a host-local timezone or drops missed
  work.
- If accepted, use fake-clock and IANA-zone tests for DST, restart, duplicate ticks, edits,
  month-end, and leap-day behavior.

## Security and operations

Bound occurrence fan-out and catch-up, persist unique occurrence identity, expose lateness
and skipped/missed outcomes, and avoid relying on a single in-memory leader. Scheduler
ownership/failover and fairness need an operational design.

## Follow-ups and blocked work

- Product owner: ratify D-22–D-24 and pause/disable semantics.
- Engineering owner: choose durable cursor/claim mechanism after ADR-0002–0004 and topology
  are settled.
- **Blocked:** AE-US-060, AE-T-060.1/.2, AE-US-061 capacity work dependent on scheduled load,
  and AE-US-085 / AE-T-085.1/.2/.3 relative timers.

## Deferral record

Deferred on 2026-10-14 because no scheduling infrastructure exists and catch-up/DST behavior
requires product approval. `@adeelchainz` owns routing this decision; product and engineering
decision owners must be identified before scheduled-trigger stories become Ready.

## Evidence

- [Automation Engine specification, D-22–D-24 and §12](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-060 and AE-US-085](../../automation-engine-backlog.md)
- [Repository audit, queue/scheduler absence](../architecture/repository-audit.md)
