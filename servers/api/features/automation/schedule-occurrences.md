# Schedule occurrences and scheduler claim (AE-T-060.1)

**Task:** AE-T-060.1. **Story:** AE-US-060. **Requirements:** FR-018, NFR-003, BR-011.

## Model
- `ScheduleCursor` (per workspace + automation): IANA `timezone`, `definition` (`interval` or `daily HH:mm`),
  `enabled`, durable `nextOccurrenceAt` (UTC), `rev`.
- `ScheduleOccurrence`: `occurrenceId = sha256([workspaceId, automationId, scheduledFor])`, `scheduledFor` (UTC ISO).
- Minimum interval 1 minute (spec 3.4). All stored instants are UTC.

## Claim flow (`tick`)
1. `findDue`: enabled cursors with `nextOccurrenceAt <= now` (disabled schedules are never returned).
2. Insert the occurrence (unique `(workspaceId, automationId, scheduledFor)`); a duplicate is `idempotent`.
3. Advance the cursor by compare-and-set on `(rev, nextOccurrenceAt, enabled)`; zero matches is `stale`, not success.
A crash between 2 and 3 is recovered on restart: the occurrence insert is idempotent and the cursor then advances.

## Lateness
`now - scheduledFor` (clamped at 0) is reported through `ScheduleTelemetry.lateness` for newly created occurrences only.

## DST and missed-run semantics (AE-T-060.2)
- Gap (spring forward, D-23): the first valid instant after the gap (the transition instant).
- Fold (fall back, D-24): once, at the first occurrence.
- Missed runs (D-22): coalesce. Only the latest due occurrence runs, and only if it is within
  `catchUpWindowMs` (default 1 h, inclusive). Earlier ones and an out-of-window latest are stored
  as occurrences with `skipReason = MISSED_SKIPPED`.
- At most `maxOccurrencesPerTick` (default 100) occurrences are examined per cursor per tick; if the
  cap is hit, everything collected is skipped and the next tick continues.
- Re-enable still resumes from the next future occurrence (no catch-up for the disabled period).
- Not covered: product approval of the 1 h window and gap/fold policy; turning an occurrence into a run.