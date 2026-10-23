# Automation Engine backlog UI audit

Reviewed from AE-E00 through AE-E07 against the current Next.js routes, feature components,
and API contracts on 2026-10-20. This maps UI needs; it does not mark backend or release gates
complete.

| Epic / task area | UI need in backlog | Current UI coverage | Remaining work / dependency |
|---|---|---|---|
| AE-E00 repository audit and ADRs | Engineering documentation and decisions | No product UI required; evidence belongs in docs | None for user-facing UI |
| AE-E01 automation CRUD, validation, versioning | Create/read/manage drafts and publish versions | Rule builder exists; automation list/detail and lifecycle controls now exist | Editing an existing draft and publishing need supported API routes; platform auth/policy adapter is still a release gate |
| AE-E02 outbox, inbox, trigger matching | Reliable background event delivery | No author-facing screen specified | Operator diagnostics need a supported status/query API before a UI can be accurate |
| AE-E03 runs, actions, retry and dead letter | Inspect execution and recover safely | Run list/detail and redacted failure/action summaries now exist | Retry/replay controls need run revision in the detail response and platform authorization; do not offer an unguarded recovery action |
| AE-E04 authorization, quotas, audit and observability | Operator diagnostics and metrics | No dashboard UI exists | Metrics query/health APIs, permission model and agreed alert definitions are prerequisites |
| AE-E05 lifecycle, dry-run, run history and builder | Authoring and support workflows | Builder, dry-run sample preview, lifecycle controls, paginated history and run detail exist | End-to-end workflow requires real platform auth, published-version API support and an active worker; retry/replay UI remains gated as above |
| AE-E06 scheduling and fairness | Schedule authoring and queue/fairness view | No schedule or fairness UI exists | Schedule CRUD/validation API and measured fairness/queue telemetry endpoints are not present |
| AE-E07 release and operations | Kill switch, dashboards, runbooks, restore evidence | Configuration contract is documented; automation console offers current lifecycle controls | Global intake/worker kill-switch API, operational metrics, alert destinations and restore evidence are not exposed to the web app |

## UI added in this pass

- `/automations`: workspace-scoped automation list, status filtering, pagination, and builder entry.
- `/automations/[automationId]`: lifecycle controls, dry-run preview, and paginated run history.
- `/automation-runs/[runId]`: safe run and action-attempt detail.
- Bearer credential input is held in tab-scoped session storage and sent only as an Authorization
  header. This is a temporary integration surface; production access still requires the real
  platform authentication adapter.

The app currently defaults to `workspace-default`, matching the existing builder route. A real
workspace selector and authenticated workspace context must come from the platform integration;
the UI must not let a user-provided path ID substitute for trusted workspace scope.
