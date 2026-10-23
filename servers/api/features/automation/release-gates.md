# Release gates, feature flags and kill switch (AE-T-071.1)

**Task:** AE-T-071.1, Implement release gates, feature flags and kill switch
**Story:** AE-US-071, Release with a safe rollback and kill switch
**Requirements:** NFR-008, NFR-014, FR-023; spec 16.4, 16.5, Part B section 26
**Owner:** Abid Ullah
**Status:** Implemented for application-layer scope; verification pending.

## Flags (all default OFF)

| Flag | Gates | Modes |
|---|---|---|
| `ingest` | Matching accepted events into runs (ADR-0003 gate) | off, shadow, cohort, all |
| `execute` | Claiming and executing runs | off, shadow, cohort, all |

- `cohort` and `shadow` list 1 to 100 workspace ids. Cohorts are workspace-based, never user percentages.
- `shadow` is held (no real work) because a plan-only execution path does not exist yet.
- Every flag has an owner, purpose, default and `reviewBy` date (PROVISIONAL). `findExpiredFlagDefinitions` reports stale flags.

## Kill switch

| Mode | New claims | Intake (matching) | Events | History |
|---|---|---|---|---|
| `pause-execution` | stopped | continues | accepted and stored | kept |
| `pause-intake` | stopped | stopped | accepted and stored | kept |

- The kill switch always wins over a flag.
- Policy for work already running (TC-0712): the current run finishes, no new run is claimed. Completed external effects are never rolled back.
- Release requires permission, a reason and `reviewConfirmed: true`. Releasing does not change rollout flags, so nothing resumes by itself.
- Engaging is applied before it is audited, so a failing audit store cannot block an emergency stop (`audited: false` is returned).

## Permissions ([VERIFY] against the platform policy engine)

`automation.release.flag.write`, `automation.release.killswitch.engage`, `automation.release.killswitch.release`.
Authorization is checked before revision and validation. Denied attempts are audited.

## Concurrency

One snapshot document with a revision covers all flags and the kill switch. Every change takes `expectedRevision`; a mismatch is a conflict, never success.

## Wiring

- `createReleaseGate({ ownsScope, store })` never throws and fails closed on a missing scope or unreadable store.
- Worker: `createRunWorker({ ..., claimGate: gate.claimGateFor(scope) })`; tick returns `paused`.
- Matcher: `createTriggerMatcher({ ..., intakeGate: gate.allowsIntake })`; returns `rejected` with reason `intake-paused`. The caller keeps the accepted event and redelivers later.
- Runtime: `createAutomationRuntime({ ..., releaseGate })`.
- Audit: `createRecorderReleaseAuditPort({ recorder, scope })` writes `flag.change` records to the append-only log using the trusted platform-operations scope.

## Tests

TC-0711 to TC-0714 in `tests/release.control.test.ts` (in-memory).

## Not covered (explicit)

- A durable `ReleaseControlStore`. Platform-level configuration is not workspace-scoped, so it needs an approved non-tenant gateway (ADR-0012) and an update to the TC-0405 architecture guard. Only the in-memory store exists.
- A management API or CLI to change flags; and no composition-root wiring of the gate into `createApp`.
- A controlled staging exercise (the Done-when drill) and the on-call runbook.
- A shadow (plan-only) execution path.
- Action-level flags (`automation.action.<type>.enabled`) and automatic stale-flag CI reporting (AE-T-076.x).