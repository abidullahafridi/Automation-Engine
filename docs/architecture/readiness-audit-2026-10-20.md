# Automation Engine readiness audit — 2026-10-21 update

This is a source-and-test review of backlog epics AE-E00 through AE-E07. “Code complete” means
the scoped module exists; “test verified” means the named local test actually ran; neither means
the production integration was exercised. Historical statuses in `automation-engine-backlog.md`
remain dated evidence, not a claim that the full epic is production-ready.

## Epic disposition

| Epic | Status | Evidence reviewed | Acceptance criteria still open |
|---|---|---|---|
| AE-E00 — Repository discovery and decisions | Partial | ADRs, repository audit and dated transaction-probe evidence exist. The old audit inventory predates the current implementation; it is now labelled historical. | Current target topology/transaction verification and approval are absent. Deferred architecture/product decisions and workload assumptions still need owner ratification. |
| AE-E01 — Definitions, validation and versioning | Partial | Scoped Mongo repository, API contracts, validators, version lifecycle, UI builder, and focused adapter/API/component tests exist. API routes require injected resolver, policy, and repositories. | No real platform auth/session, workspace membership, or shared policy adapter. Production API runtime does not inject automation dependencies; live Mongo and end-to-end authoring are unverified. |
| AE-E02 — Event ingestion and matching | Partial | Versioned event schema, inbox/outbox repositories, matcher, transaction-runner contract, and isolated component/Mongo tests exist. | No trusted platform publisher/event source or composed relay/ingest runtime. Transactional behavior must be re-run against an approved replica set; event/outbox production delivery is unverified. |
| AE-E03 — Runs, actions and recovery | Partial | Run state/repository/worker/executor/recovery modules and fake-backed tests cover fencing, retries, ambiguous outcomes, idempotency, and authorization boundaries. | No process startup creates workers or reapers; no production action-provider adapters are registered; recovery routes are not mounted by the production server. Mongo persistence and external-effect behavior are unverified. |
| AE-E04 — Governance and observability | Partial | Policy ports, execution-time checks, audit, quota/loop guards, telemetry, and injectable operations signal collection have component tests. Runtime now passes the required release gate into matcher intake and worker claim checks. | Platform policy and creator-standing providers are absent. Durable audit permissions/retention, production metrics sources, runtime composition, and live tenant/security matrix remain unverified. |
| AE-E05 — Management and diagnosis | Partial | API routes and web authoring, run history, schedule, operations, and recovery views exist. Workspace selection is explicit across the screens; builder requests include the tab-scoped bearer token and no longer report local fallback as an API save. New focused save-request tests and existing route/component tests pass. | UI → production API → Mongo → worker → history has not run end-to-end. Production auth is absent; the API feature flag remains OFF; `TC-0537` stays skipped pending the authenticated runtime and active worker. |
| AE-E06 — Scheduling and scale | Partial | Schedule validation/CRUD routes, UI, timezone/DST/catch-up logic, durable Mongo cursor/occurrence repository, and controlled-clock tests exist. | No trusted workspace enumerator or running scheduler lifecycle. Occurrences are not durably converted into queued runs; no approved scheduled-event semantics exist. Mongo schedule tests and measured load/fairness acceptance remain open. |
| AE-E07 — Production readiness and operations | Blocked | CI/check workflows, environment validation, runbooks, alert evaluation and in-memory release-control logic exist. Local test/check results are recorded below when run. | Real auth/policy, target Mongo verification, worker/scheduler composition, durable release store and HTTP/UI kill-switch path, alert sources/monitor/sink, restore drill, approved SLOs/on-call ownership, and production release approval are absent. |

## Verified integration boundaries and required external contracts

- Authentication: no platform auth/session provider was found. Required adapter must accept a
  credential only through the trusted platform verifier and return a verified principal or
  unauthenticated/unavailable result. Required membership lookup must confirm that principal's
  access to the requested workspace before the API mints `WorkspaceScope`. The platform owner
  must provide the verifier contract, token validation/revocation semantics, membership API,
  and a live conformance/tenant-matrix environment. Do not trust client-supplied principal or
  workspace claims.
- Authorization: provide the platform's permission evaluator implementing
  `authorize(principal, permission, resource): Promise<boolean>`, including the automation
  permission vocabulary and resource semantics used by the routes/executor. Verify denied and
  provider-outage behavior against the live service.
- Event source and schedules: a trusted workspace enumerator is needed to drive workspace
  scheduler/worker loops. Schedule execution additionally needs an owner-approved event/run
  envelope, actor/causation semantics, idempotency key, and durable enqueue contract. The current
  domain-event contract only defines `task.status_changed`; do not coerce schedule ticks into it.
- Actions: registry and `notification.send` handler contract exist, but production implementations
  for `RecipientDirectoryPort`, `TemplateVariablesPort`, and `NotificationPort` are not present.
  The product/platform owners must provide those services and idempotency, cancellation, timeout,
  and error-classification guarantees.
- Operations: `OpsSignalSources` and `AlertSink` are injectable contracts, not configured
  production sources/delivery. Supply scoped queue/outbox/DLQ/tenant telemetry, approved alert
  thresholds, a trusted workspace enumeration strategy for a monitor loop, and the actual
  paging/ticket sink plus delivery/retry policy.
- Release controls: release gate now guards matcher intake and worker claims in runtime
  composition. Only an in-memory `ReleaseControlStore` exists. A platform-approved global
  (non-workspace) durable CAS store, control API/UI, policy permissions, audit scope, and staging
  pause/resume drill are still required. Do not persist a global control document using a
  tenant-scoped repository without an approved boundary.
- Mongo: the integration exposes a transaction runner and the outbox delegates to it. This is
  code-level capability only. A historical local `rs0` probe artifact passed five checks on
  2026-10-15; it is not current target verification, and CI's Mongo job remains approval-gated.
  Current audit environment has no `MONGO_URI`, Docker command, or local listener on 27017.

## Mongo-backed test invocation

The API Mongo tests read `MONGO_URI`; some also require `ALLOW_NON_PROD=yes`. The outbox transaction
test requires `MONGO_URI` to include `replicaSet`. With Docker/Compose installed and approved for
local use, from the repository root in PowerShell:

```powershell
docker compose up -d --wait mongodb
$env:MONGO_URI = 'mongodb://127.0.0.1:27017/nutshyll_test?replicaSet=rs0'
$env:ALLOW_NON_PROD = 'yes'
pnpm --filter @workspace/api test
node scripts/verify-mongo-transactions.mjs
docker compose down
```

Do not use a production URI. The transaction probe also requires explicit `ALLOW_NON_PROD=yes`;
its evidence verifies the target it contacted only. Passing against this disposable local fixture
does not verify staging or production. CI's `mongo-replica-set-probe` currently runs only when
repository variable `MONGO_REPLICA_SET_CI_APPROVED` is set to `true` by an authorized owner.

## Runtime composition review

`servers/api/server.ts` creates the app with only `{ config, logger }`. It does not construct or
inject automation API services, real identity/policy adapters, repositories, operations sources,
or release control. `createApp` refuses to enable automation without explicit dependencies and
`AUTOMATION_API_ENABLED` defaults to false. `createAutomationRuntime` is a worker-side factory,
not an application process loop: it needs externally supplied trusted scope, creators, policy,
handlers, clock, IDs, telemetry, and now a `ReleaseGate`; it does not enumerate workspaces, start
workers, schedule reaping, start the schedule scheduler, or mount API routes.

## Checks run for this audit

Commands were run after the release-gate runtime wiring and documentation update:

| Command | Result |
|---|---|
| `pnpm --filter @workspace/api test` | PASS — fresh run: 322 tests, 309 passed, 13 skipped, 0 failed. The 13 skips are Mongo-backed tests because `MONGO_URI` is unset. |
| `pnpm --filter @workspace/web test` | PASS — fresh run after UI connection changes: 15 tests, 14 passed, 1 skipped, 0 failed. `TC-0537` live API/worker journey is skipped because the platform auth adapter, mounted automation runtime, and active worker are unavailable. |
| `pnpm --filter @workspace/api run typecheck` | PASS |
| `pnpm --filter @workspace/web run typecheck` | PASS |
| `pnpm --filter @workspace/api run lint` | PASS |
| `pnpm --filter @workspace/web run lint` | PASS |
| `pnpm run check` | PASS — repository control-plane check reported “No issues found.” |
| `pnpm --filter @workspace/api run build` | PASS after adding explicit Express `Router` return types to schedule and operations route factories. The first declaration build exposed TS2742 in both factories; the focused fix resolved it. |
| `pnpm run build` | PASS — API and web builds passed; other workspace builds were cached. |
| `pnpm --filter @workspace/web run build` | PASS — production build and page generation passed after adding explicit workspace selection and authenticated builder saves. |
| `pnpm run check` | PASS — repository control-plane check reported “No issues found.” |
| `pnpm --filter @workspace/api exec tsx --test features/automation/tests/trigger.protection.test.ts features/automation/tests/run.repository.test.ts` | PASS — 11 tests, 10 passed, 1 Mongo persistence test skipped because `MONGO_URI` is unset. This confirms in-memory matcher lineage and permanent loop-block behavior, not Mongo persistence. |
| `git diff --check` | PASS — whitespace check clean; Git emitted only CRLF-to-LF informational warnings. |

## Backlog code-fact correction (2026-10-21)

Review of the current sources found that two older “Not covered yet” notes in the quota/loop
protection documents were stale: `RunStatus` already has terminal `skipped`, matcher-created
permanent loop blocks are persisted as skipped runs, and `StoredRun` carries `chainKey`/`hop`.
The documents now cite the matcher, repository, protection, and Mongo wiring tests. This closes
those code-level gaps only; ingest redelivery after `retryAfterMs`, durable production metrics,
override API/audit, and measured load/fairness remain open. The target Mongo tests still require
`MONGO_URI`, so their presence in the suite is not a claim they ran in the latest web check.

The user also supplied a Mongo-backed API-suite result of 353 passed, 0 failed, 0 skipped. It is
not reproduced by this audit: no result transcript matching that count is present, and this
environment has no configured Mongo URI or local database. Treat that count as user-reported
evidence, separate from the fresh 309/13/0 run above.

Environment checks confirmed `MONGO_URI` and `ALLOW_NON_PROD` are unset, Docker is unavailable,
and no process listens on localhost port 27017. No Mongo connection attempt was made in this audit.
The previous `uv_os_get_passwd returned ENOMEM` error did not recur during the executed API test
run; this does not substitute for separately skipped live integrations.

