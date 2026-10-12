# Automation Engine --- Production-Oriented Engineering Specification

**Document ID:** AUTO-ARCH-001\
**Version:** 1.0 (Draft baseline)\
**Status:** Proposed --- requires architecture review and validation
against the existing repository\
**Audience:** Product owner, software architects, backend/frontend
engineers, QA, DevOps/SRE, security reviewers\
**Scope:** A reusable automation engine for a ClickUp-like
work-management platform

> This specification is a design baseline, not proof that the
> implementation is production-ready. Validate decisions against the
> actual repository, team capacity, deployment environment, and measured
> workload before treating them as final.

------------------------------------------------------------------------

## 0. Document control

  -----------------------------------------------------------------------
  Field                               Value
  ----------------------------------- -----------------------------------
  Owner                               Engineering team

  Reviewers                           Product, backend, frontend, QA,
                                      security, operations

  Related systems                     Identity/access, workspace,
                                      projects/tasks, notifications,
                                      integrations, audit, reporting

  Change policy                       Material architecture or contract
                                      changes require an ADR

  Release policy                      Version API/event/action contracts;
                                      maintain backward compatibility
                                      where practical
  -----------------------------------------------------------------------

### Required companion documents

1.  Product Requirements Document (PRD)
2.  Functional Requirements and Acceptance Criteria
3.  Domain model and glossary
4.  Architecture Decision Records (ADRs)
5.  C4 context/container/component diagrams
6.  API and event contracts (OpenAPI/AsyncAPI or equivalent)
7.  Database schema and migration strategy
8.  Threat model and security review
9.  Test strategy and acceptance-test catalogue
10. SLOs, dashboards, alert rules, and runbooks
11. Deployment/rollback and disaster-recovery plan
12. Operational readiness review (ORR)
13. User/admin documentation and troubleshooting guide

------------------------------------------------------------------------

## 1. Executive summary

The Automation Engine evaluates configured rules in response to domain
events or scheduled triggers and executes approved actions. A rule is
composed of:

-   **Trigger:** the event or schedule that starts evaluation.
-   **Conditions:** a declarative predicate over a bounded event/context
    snapshot.
-   **Actions:** registered, typed operations such as changing a task
    field or sending a notification.
-   **Execution policy:** retry, timeout, concurrency, rate limits,
    failure behavior, and limits.
-   **Governance:** tenant/workspace scope, permissions, versioning,
    audit, enable/disable, and ownership.

The engine must not be implemented as arbitrary user-supplied
JavaScript. Use a declarative rule format and a controlled registry of
triggers, operators, and actions. This reduces the attack surface and
makes validation, preview, auditing, and compatibility manageable.

### Goals

-   Let authorized users create, validate, test, enable, pause, and
    inspect automations.
-   Execute automation work asynchronously without blocking task APIs.
-   Isolate workspaces/tenants at every read, write, event, and
    execution boundary.
-   Handle duplicate event delivery, transient failures, worker
    restarts, and partial action failure.
-   Provide traceability from source event to automation run and each
    action attempt.
-   Keep the initial deployment simple enough to operate, while allowing
    later horizontal scaling.

### Non-goals for the first release

-   Arbitrary code execution or a general-purpose scripting language.
-   Unlimited loops, recursive automations, or unbounded fan-out.
-   A visual workflow/BPMN engine with long-running human approval
    steps.
-   Exactly-once execution claims for arbitrary external APIs.
-   A microservice for every domain from day one.

------------------------------------------------------------------------

## 2. Product scope and personas

### Primary personas

-   **Workspace owner/admin:** governs permissions, limits, and
    integrations.
-   **Automation author:** builds and tests rules.
-   **Member:** benefits from automated task/project workflows.
-   **Auditor/support operator:** investigates who changed what and why.
-   **Platform operator:** monitors queues, workers, retries, and
    incidents.

### Initial use cases

1.  When a task moves to `Done`, notify its owner or project lead.
2.  When a task is created with priority `Urgent`, assign a triage user.
3.  When a due date is approaching, send a reminder.
4.  When a task is overdue, change a field or notify an authorized
    audience.
5.  When a form/request arrives, create a task using a validated
    template.
6.  When a status changes, append a comment or update a controlled
    field.
7.  Run a scheduled rule against a bounded set of eligible resources.

### Out of scope until explicitly designed

-   Arbitrary database writes from automation actions.
-   Actions that bypass domain services or authorization.
-   Infinite recurrence, recursive trigger chains, or unbounded bulk
    operations.
-   Secrets embedded in rule JSON or logs.
-   User-authored code evaluated in the API/worker process.

------------------------------------------------------------------------

## 3. Requirements

### 3.1 Functional requirements

  -----------------------------------------------------------------------
  ID                                  Requirement
  ----------------------------------- -----------------------------------
  FR-001                              An authorized user can create,
                                      read, update, duplicate, and
                                      archive an automation.

  FR-002                              An automation has a workspace
                                      scope, owner, status, version,
                                      trigger, conditions, actions, and
                                      execution policy.

  FR-003                              The API validates trigger/action
                                      schemas and rejects unknown
                                      operators, fields, versions, or
                                      action types.

  FR-004                              An author can validate and dry-run
                                      a draft against a sample
                                      event/context without mutating
                                      production data.

  FR-005                              Only a valid, authorized version
                                      can be enabled.

  FR-006                              Domain events can initiate eligible
                                      automation runs asynchronously.

  FR-007                              Scheduled triggers can enqueue
                                      bounded evaluation work.

  FR-008                              Every run and action attempt has a
                                      durable status and correlation
                                      identifiers.

  FR-009                              Transient failures can be retried
                                      with bounded exponential backoff
                                      and jitter.

  FR-010                              Permanent failures are recorded and
                                      are not retried indefinitely.

  FR-011                              An authorized user can pause,
                                      resume, disable, or archive an
                                      automation.

  FR-012                              The system exposes run history,
                                      action results, failure reasons
                                      safe for users, and retry/replay
                                      controls subject to policy.

  FR-013                              Workspace boundaries are enforced
                                      for automation definitions, source
                                      events, target resources, runs,
                                      logs, and action execution.

  FR-014                              Automation changes and privileged
                                      operations are audited.

  FR-015                              The system prevents or bounds
                                      self-triggering loops and excessive
                                      fan-out.

  FR-016                              Rule versions used by a run are
                                      immutable and identifiable.
  -----------------------------------------------------------------------

### 3.2 Non-functional requirements (proposed targets)

Targets below are starting hypotheses, not promises. Confirm them with
product expectations and load testing.

  -----------------------------------------------------------------------
  ID                                  Requirement / proposed target
  ----------------------------------- -----------------------------------
  NFR-001 Availability                Automation management APIs target
                                      99.9% monthly availability after
                                      operational maturity.

  NFR-002 Latency                     Event ingestion should enqueue
                                      eligible work without waiting for
                                      action completion; target p95 under
                                      500 ms for the enqueue path under
                                      agreed load.

  NFR-003 Durability                  Accepted events/jobs must be
                                      durable according to the chosen
                                      database/queue guarantees.

  NFR-004 Isolation                   No cross-workspace reads or writes;
                                      missing scope fails closed.

  NFR-005 Scalability                 Queue consumers can scale
                                      horizontally with bounded
                                      per-workspace concurrency.

  NFR-006 Observability               Logs, metrics, and traces correlate
                                      by event, automation, run, action,
                                      workspace, and trace IDs without
                                      leaking secrets.

  NFR-007 Security                    Least privilege, schema validation,
                                      action allowlists, rate limits,
                                      secret redaction, and auditable
                                      access.

  NFR-008 Recoverability              Documented recovery from worker
                                      crashes, queue backlog, database
                                      outage, and bad release.

  NFR-009 Maintainability             Versioned contracts, ADRs, module
                                      boundaries, automated tests, and
                                      reproducible local setup.

  NFR-010 Cost control                Per-workspace quotas and global
                                      concurrency/retention limits
                                      prevent runaway usage.
  -----------------------------------------------------------------------

### 3.3 Business rules

-   Every automation belongs to exactly one workspace/tenant.
-   Every trigger and action type must be registered by the platform.
-   A run binds to a specific immutable automation version.
-   Drafts are not executable until validated and enabled.
-   Every resource lookup and mutation must include verified scope.
-   Every action must re-check authorization at execution time;
    permissions may have changed since authoring.
-   No action may silently widen scope or act on a resource outside the
    automation's workspace.
-   Retry only failures classified as transient; respect idempotency and
    external provider semantics.
-   Disable/pause stops future scheduling and new eligible runs;
    in-flight behavior must be explicitly defined and surfaced.
-   A run has bounded actions, execution time, payload size, and retry
    count.
-   All time comparisons use UTC internally; user-facing schedules use
    an explicit IANA time zone.
-   Rule edits create a new version; an in-progress run continues with
    its pinned version unless an explicit cancellation policy says
    otherwise.

------------------------------------------------------------------------

## 4. Domain-driven design

Use bounded contexts rather than making one microservice per feature.
Start with a modular backend and extract services only when scale,
ownership, or reliability requirements justify the operational cost.

### 4.1 Domain → subdomain → module → entity → feature

  ---------------------------------------------------------------------------------------
  Domain            Subdomain/module      Core entities            Responsibility
  ----------------- --------------------- ------------------------ ----------------------
  Identity & Access Principal, workspace  Principal, Membership,   Resolve actor and
                    membership, policy    PolicyDecision           authorize
                                                                   management/execution

  Work Management   Task/project          Task, Project, Status    Publish business
                    lifecycle                                      events through domain
                                                                   services

  Automation        Authoring and         Automation,              Draft, validate,
  Management        lifecycle             AutomationVersion        enable, pause,
                                                                   version, archive

  Rule Evaluation   Trigger/condition     TriggerDefinition,       Match event and
                    engine                ConditionGroup           evaluate typed
                                                                   conditions

  Execution         Run state machine     AutomationRun,           Schedule, claim,
  Orchestration                           ActionExecution          execute, retry,
                                                                   cancel, reconcile

  Action Registry   Built-in capabilities ActionDefinition,        Validate and execute
                                          ActionResult             approved actions

  Event Ingestion   Event contracts and   DomainEvent, InboxRecord Validate, deduplicate,
                    dedupe                                         route events

  Scheduling        Time-based triggers   ScheduleCursor,          Produce bounded
                                          ScheduledOccurrence      scheduled work

  Governance        Audit, quotas,        AuditRecord,             Trace changes, enforce
                    retention             UsageCounter             quotas, retention

  Integrations      External providers    IntegrationConnection,   Securely call external
                                          SecretRef                systems

  Observability     Logs/metrics/traces   CorrelationContext       Measure and diagnose
                                                                   execution
  ---------------------------------------------------------------------------------------

### 4.2 Key entity definitions

**Automation** - `id`, `workspaceId`, `name`, `description` - `status`:
`draft | enabled | paused | disabled | archived` - `currentVersion`,
`ownerId`, `createdAt`, `updatedAt` - `triggerType`, `lastValidatedAt`
(summary fields only; version is canonical)

**AutomationVersion** (immutable after publication) - `automationId`,
`workspaceId`, `version` - `triggerConfig`, `conditionTree`,
`actions[]`, `executionPolicy` - `schemaVersion`, `createdBy`,
`createdAt`, `validationSummary` - `contentHash` for integrity and audit

**AutomationRun** - `id`, `workspaceId`, `automationId`,
`automationVersion` - `sourceEventId` or `scheduledOccurrenceId`,
`status` - `startedAt`, `finishedAt`, `attemptCount` - `correlationId`,
`traceId`, `failureCode`, safe `failureSummary` - `idempotencyKey`,
`leaseOwner`, `leaseExpiresAt` if using DB-based claiming

**ActionExecution** - `id`, `runId`, `workspaceId`, `actionIndex`,
`actionType` - `status`, `attemptCount`, `startedAt`, `finishedAt` -
`inputSummary` (redacted), `outputSummary` (redacted) -
`idempotencyKey`, `providerRequestId`, `failureCode`

**DomainEvent** - `eventId`, `eventType`, `schemaVersion`,
`workspaceId` - `aggregateType`, `aggregateId`, `aggregateVersion` -
`occurredAt`, `actor`, `correlationId`, `causationId`, `payload` -
payload must be minimal and validated; never trust workspace IDs
supplied by an untrusted client.

**AuditRecord** - actor, workspace, action, target type/id, timestamp,
outcome, correlation ID, redacted change summary. - Audit storage should
be append-oriented and protected from ordinary application mutation.

### 4.3 Glossary

-   **Trigger:** configuration describing which event or schedule
    qualifies.
-   **Condition:** a typed boolean expression over an allowed context.
-   **Action:** a registered operation with input/output schema and
    declared effects.
-   **Run:** one attempt to process an event/occurrence for one
    automation version.
-   **Attempt:** one try to execute a run or action.
-   **Idempotency:** repeating the same logical request does not produce
    an additional logical effect.
-   **Outbox:** durable event record written in the same transaction as
    a domain change.
-   **Inbox/dedupe:** durable record of already accepted event IDs.
-   **Dead-letter queue (DLQ):** isolated storage for exhausted or
    permanently invalid work.
-   **Replay:** controlled reprocessing with explicit duplicate-effect
    protections and audit.

------------------------------------------------------------------------

## 5. Architecture

### 5.1 Logical component view

``` mermaid
flowchart LR
  UI[Automation Builder UI] --> API[Management API]
  API --> AUTH[Principal + Policy]
  API --> DEF[(Automation Definitions)]
  API --> AUD[(Audit Records)]
  DOMAIN[Task / Project Domain Services] --> OUTBOX[(Transactional Outbox)]
  OUTBOX --> RELAY[Outbox Relay]
  RELAY --> BUS[Durable Event Bus / Queue]
  BUS --> INGEST[Event Ingestion + Deduplication]
  INGEST --> MATCH[Trigger Matcher]
  MATCH --> RUNS[(Run Store)]
  MATCH --> WORK[Execution Queue]
  SCHED[Scheduler] --> WORK
  WORK --> ORCH[Run Orchestrator / Workers]
  ORCH --> EVAL[Condition Evaluator]
  ORCH --> REG[Typed Action Registry]
  REG --> DOMAIN
  REG --> EXT[External Integrations]
  ORCH --> RUNS
  ORCH --> AUD
  ORCH --> OBS[Logs / Metrics / Traces]
```

### 5.2 Component responsibilities

1.  **Automation Builder UI:** schema-driven editor; shows validation
    errors; never decides authorization.
2.  **Management API:** authenticates, resolves workspace scope,
    validates input, invokes domain services, writes audit records.
3.  **Automation Definition Repository:** stores drafts and immutable
    published versions.
4.  **Domain Event Publisher:** emits events only after successful
    domain changes, ideally via transactional outbox.
5.  **Outbox Relay:** publishes pending events and marks delivery; safe
    to publish duplicates.
6.  **Event Ingestion:** validates schema, records dedupe state, rejects
    malformed events, applies event-size limits.
7.  **Trigger Matcher:** finds enabled automations in the same workspace
    whose trigger matches the event.
8.  **Condition Evaluator:** evaluates a small declarative language; no
    arbitrary code execution.
9.  **Run Orchestrator:** creates/claims runs, enforces state
    transitions, retries, deadlines, quotas, and cancellation policy.
10. **Action Registry:** maps approved action types to typed handlers
    with schema, permission requirements, timeout, retry classification,
    and idempotency strategy.
11. **Scheduler:** produces time-based occurrences, handling time zones,
    DST, missed schedules, and duplicate ticks.
12. **Observability:** metrics, structured logs, traces, alerts,
    dashboards, and audit.

### 5.3 Deployment topology

**Initial recommendation:** modular monolith for management/domain APIs
plus separately scalable worker process(es), using a durable queue or a
database-backed queue only if its locking/throughput guarantees are
sufficient. Keep modules behind explicit interfaces.

Possible deployment units: - Web application / builder UI - API
application - Worker process - Scheduler process (may initially run as a
singleton/leader-elected worker) - MongoDB replica set or another
supported durable database - Durable queue/event broker if justified -
Redis only for use cases that need it (cache, distributed rate limits,
short-lived coordination); not as the sole source of truth for run
history - External telemetry backend

Do not add Kafka, Kubernetes, or multiple microservices merely to appear
production-grade. Choose infrastructure based on measured throughput,
ordering needs, operational capacity, and recovery requirements.

------------------------------------------------------------------------

## 6. Runtime lifecycle and state machines

### 6.1 Automation lifecycle

``` text
draft -> validated -> enabled -> paused -> enabled
                       |           |
                       v           v
                    disabled <-----+
                       |
                       v
                    archived
```

The exact state set can be simplified in storage, but transitions must
be explicit. A published version is immutable. Re-enabling requires
current authorization and validation of the version being activated.

### 6.2 Run lifecycle

``` text
queued -> claimed -> evaluating -> running -> succeeded
   |         |           |           |
   |         |           |           +-> retry_wait -> queued
   |         |           +-> skipped
   |         +-> queued (lease expired / recoverable crash)
   +-> cancelled

running -> partially_failed | failed | timed_out | cancelled
failed/retry_wait -> dead_letter (retry policy exhausted)
```

Define transitions in one place and reject illegal transitions. Use
compare-and-set/version checks or conditional updates so two workers
cannot own the same run simultaneously.

### 6.3 Action lifecycle

`pending -> running -> succeeded | retry_wait | failed | skipped | timed_out | unknown_outcome`

`unknown_outcome` matters when an external provider may have completed
an operation but the worker timed out before receiving confirmation.
Reconcile using provider idempotency keys or status lookup; do not
blindly repeat a non-idempotent action.

### 6.4 End-to-end event flow

1.  A task domain service validates the user's command and policy.
2.  The domain service commits the task mutation and outbox event
    atomically where the database supports it.
3.  An outbox relay publishes the event. Duplicate publication is
    expected and safe.
4.  Event ingestion validates schema and records the event ID in an
    inbox/deduplication store.
5.  Trigger matching finds enabled automation versions within the
    event's workspace.
6.  The engine creates a durable run record with a stable idempotency
    key and pinned version.
7.  A worker claims the run with an atomic lease/conditional update.
8.  The worker re-checks authorization and evaluates conditions using a
    bounded context.
9.  Each action is validated and executed through its registered
    handler.
10. Action results, run status, audit, metrics, and traces are recorded.
11. Retryable failures are scheduled with backoff; exhausted work enters
    DLQ.
12. Users can inspect the run and follow an audited retry/replay path.

------------------------------------------------------------------------

## 7. Rule definition and validation

### 7.1 Example declarative rule

``` json
{
  "schemaVersion": 1,
  "name": "Notify lead when task is completed",
  "trigger": {
    "type": "task.status_changed",
    "config": {
      "toStatus": "done"
    }
  },
  "conditions": {
    "all": [
      {
        "field": "event.workspaceId",
        "operator": "equals",
        "valueFrom": "trusted_scope.workspaceId"
      },
      {
        "field": "task.isArchived",
        "operator": "equals",
        "value": false
      }
    ]
  },
  "actions": [
    {
      "type": "notification.send",
      "config": {
        "recipient": { "type": "project_lead" },
        "template": "task_completed"
      }
    }
  ],
  "executionPolicy": {
    "timeoutSeconds": 30,
    "maxAttempts": 5,
    "onActionFailure": "stop"
  }
}
```

This is illustrative; actual field names and types must match the real
domain model. `trusted_scope` must be built by the server, not accepted
as an authoritative client field.

### 7.2 Condition language

Support a limited, typed operator set: - Equality/inequality for
compatible scalar types - `in` / `not_in` for bounded lists - `exists` /
`not_exists` - Numeric comparisons for numeric fields - Date comparisons
with explicit UTC semantics - `all` / `any` groups with maximum nesting
depth

Requirements: - Field allowlist per trigger/context; never permit
arbitrary object traversal. - Type-check fields and values at authoring
time. - Bound expression depth, list length, payload size, and
evaluation time. - Define null/missing semantics explicitly. - No eval,
Function constructor, arbitrary expressions, database query fragments,
or user-supplied regex without strict limits. - Version the condition
schema and provide migrations/compatibility rules.

### 7.3 Validation pipeline

1.  Authenticate and resolve workspace principal.
2.  Check create/update permission.
3.  Validate top-level JSON schema and size limits.
4.  Validate trigger type/config against registry.
5.  Validate each condition field/operator/type and depth.
6.  Validate every action type/config and required permission.
7.  Validate cross-field rules and execution limits.
8.  Detect obvious self-trigger loops and risky cycles where feasible.
9.  Return stable error codes and field paths.
10. Store draft; publish a new immutable version only after successful
    validation and explicit enable action.

### 7.4 Dry-run and preview

A dry run must not mutate production resources. It should report: -
Trigger match: yes/no and why - Conditions: per-condition pass/fail with
safe values - Planned actions and required permissions - Estimated
fan-out and quota impact - Warnings for stale references or risky
recursion

Dry-run output must redact secrets and sensitive personal data. Make
clear that preview cannot guarantee an external API will succeed later.

------------------------------------------------------------------------

## 8. Data model and persistence

The following is a logical model; translate it into the actual database
conventions and indexes.

### 8.1 Collections/tables

-   `automations`
-   `automation_versions`
-   `automation_runs`
-   `action_executions`
-   `domain_outbox`
-   `event_inbox` or `processed_events`
-   `scheduled_occurrences`
-   `automation_audit`
-   `integration_connections` / secret references
-   `automation_usage_counters` (or a dedicated quota system)

### 8.2 Indexes to consider

-   `automations`: unique `(workspaceId, normalizedName)` only if
    product rules require unique names; query index
    `(workspaceId, status, triggerType)`.
-   `automation_versions`: unique
    `(workspaceId, automationId, version)`.
-   `automation_runs`: unique idempotency key within the intended scope;
    indexes `(workspaceId, automationId, createdAt)`,
    `(workspaceId, status, createdAt)`, and queue-claim fields.
-   `action_executions`: unique `(workspaceId, runId, actionIndex)`;
    index `(workspaceId, runId)`.
-   `domain_outbox`: index `(publishedAt, createdAt)` and unique event
    ID.
-   `event_inbox`: unique `(workspaceId, eventId)` or globally unique
    event ID if the event contract guarantees it.
-   `scheduled_occurrences`: unique
    `(workspaceId, automationId, scheduledFor, version)` as appropriate.

Indexes must be confirmed with real query plans and workload
measurements. Avoid indexes that are not tied to an access pattern.

### 8.3 Persistence rules

-   Every tenant-owned document includes a trusted `workspaceId`.
-   Every query and mutation includes workspace scope; missing scope
    fails closed.
-   Never accept a client-provided workspace ID as proof of
    authorization.
-   Use optimistic concurrency (`version`/ETag/conditional update) for
    definition edits and state transitions.
-   Use transactions where atomic multi-document guarantees are required
    and supported; otherwise design explicit recovery/reconciliation.
-   Keep run history separate from mutable definitions.
-   Apply retention/TTL only to eligible operational data; never let TTL
    delete required audit or active recovery records.
-   Store secret references, not plaintext credentials, in rule
    definitions.
-   Bound and redact stored input/output snapshots.

### 8.4 Example conditional update

``` ts
await automationRuns.updateOne(
  {
    _id: runId,
    workspaceId: principal.workspaceId,
    status: "queued",
    version: expectedVersion
  },
  {
    $set: {
      status: "claimed",
      leaseOwner: workerId,
      leaseExpiresAt
    },
    $inc: { version: 1 }
  }
);
```

Check the matched count. Zero matches means the claim lost a race or the
run is no longer eligible; it is not success. Exact syntax depends on
the chosen driver and schema.

------------------------------------------------------------------------

## 9. API design

Use versioned, documented contracts. The examples below are a baseline;
align routes and envelopes with existing API conventions.

### 9.1 Management endpoints

  ------------------------------------------------------------------------------------------------------------
  Method                  Endpoint                                                     Purpose
  ----------------------- ------------------------------------------------------------ -----------------------
  POST                    `/api/v1/workspaces/{workspaceId}/automations`               Create draft

  GET                     `/api/v1/workspaces/{workspaceId}/automations`               List with
                                                                                       filters/cursor
                                                                                       pagination

  GET                     `/api/v1/workspaces/{workspaceId}/automations/{id}`          Read definition

  PATCH                   `/api/v1/workspaces/{workspaceId}/automations/{id}`          Update draft with
                                                                                       version/ETag check

  POST                    `.../{id}/validate`                                          Validate draft

  POST                    `.../{id}/dry-run`                                           Preview against
                                                                                       sample/context

  POST                    `.../{id}/enable`                                            Publish/enable
                                                                                       validated version

  POST                    `.../{id}/pause`                                             Pause future work

  POST                    `.../{id}/disable`                                           Disable

  POST                    `.../{id}/archive`                                           Archive

  GET                     `.../{id}/runs`                                              Paginated run history

  GET                     `/api/v1/workspaces/{workspaceId}/automation-runs/{runId}`   Inspect a run

  POST                    `.../automation-runs/{runId}/retry`                          Audited retry under
                                                                                       policy

  POST                    `.../automation-runs/{runId}/replay`                         Controlled replay,
                                                                                       distinct from retry
  ------------------------------------------------------------------------------------------------------------

Avoid putting large arbitrary rule bodies in query parameters. Use
request IDs/idempotency keys for operations that clients may repeat.

### 9.2 API contract requirements

-   Authentication and authorization on every route.
-   Workspace membership and resource-level policy checks.
-   Request schema validation, payload limits, stable error codes.
-   Cursor pagination for large run histories.
-   Rate limits per actor/workspace and endpoint.
-   Idempotency keys for create/enable/retry requests where duplicate
    requests could cause effects.
-   Optimistic concurrency for edits (`If-Match`, ETag, or explicit
    version).
-   Consistent response envelope and safe error details.
-   OpenAPI specification and contract tests.
-   Do not expose stack traces, credentials, provider tokens, or raw
    internal errors.

### 9.3 Example error codes

-   `AUTOMATION_NOT_FOUND`
-   `AUTOMATION_VERSION_CONFLICT`
-   `AUTOMATION_INVALID_TRIGGER`
-   `AUTOMATION_INVALID_CONDITION`
-   `AUTOMATION_INVALID_ACTION`
-   `AUTOMATION_PERMISSION_DENIED`
-   `AUTOMATION_QUOTA_EXCEEDED`
-   `AUTOMATION_RUN_NOT_RETRYABLE`
-   `AUTOMATION_RUN_ALREADY_CLAIMED`
-   `AUTOMATION_PROVIDER_UNAVAILABLE`

------------------------------------------------------------------------

## 10. Event contract and delivery guarantees

### 10.1 Event envelope

``` json
{
  "eventId": "evt_01...",
  "eventType": "task.status_changed",
  "schemaVersion": 1,
  "workspaceId": "ws_...",
  "aggregate": {
    "type": "task",
    "id": "task_...",
    "version": 42
  },
  "occurredAt": "2026-10-12T10:00:00.000Z",
  "actor": {
    "type": "user",
    "id": "user_..."
  },
  "correlationId": "corr_...",
  "causationId": "cmd_...",
  "payload": {
    "previousStatus": "in_progress",
    "currentStatus": "done"
  }
}
```

Do not include fields the rule engine does not need. Sensitive values
should be fetched through authorized domain services rather than copied
into every event.

### 10.2 Delivery model

Design for **at-least-once delivery** unless the selected infrastructure
proves otherwise. Assume duplicate delivery can happen. Do not promise
exactly-once external side effects.

-   Use a transactional outbox for state-change events where possible.
-   Use inbox/deduplication records with unique constraints.
-   Make run creation idempotent.
-   Use provider idempotency keys when supported.
-   For non-idempotent providers, use reconciliation or mark uncertain
    outcomes for operator review.
-   Preserve event ordering only where required, typically per
    aggregate; do not assume global ordering.
-   Include event schema versions and compatibility tests.

### 10.3 Outbox relay recovery

A relay claims pending outbox rows/documents, publishes them, then
records publication. If it crashes after publishing but before recording
success, it may publish again. Consumers must deduplicate. Alert on
oldest pending outbox age and sustained publish failures.

------------------------------------------------------------------------

## 11. Worker, queue, retries, and concurrency

### 11.1 Worker responsibilities

-   Claim work atomically using a lease or queue visibility timeout.
-   Validate the pinned automation version and execution payload.
-   Re-check authorization and current target-resource state.
-   Enforce per-run timeout, per-action timeout, maximum actions, and
    quotas.
-   Record action attempts and structured failure codes.
-   Renew leases for long-running jobs where supported.
-   Release or recover abandoned work after worker crashes.
-   Shut down gracefully: stop claiming new work, finish/cancel safely,
    then exit.
-   Never log secrets or unredacted user-controlled payloads.

### 11.2 Retry policy

Classify errors: - **Transient:** network timeout, provider 429,
selected 5xx, temporary DB outage. - **Permanent:** invalid
configuration, permission denied, missing/deleted target, unsupported
action. - **Ambiguous outcome:** request may have succeeded remotely but
response was lost.

Use bounded exponential backoff with jitter, respect `Retry-After`, and
cap total run age and attempts. Example starting policy: maximum 5
attempts, base delay 1 second, exponential growth with jitter, capped at
5 minutes. Tune from observed provider behavior. Do not retry every
error.

### 11.3 Dead-letter handling

When retries are exhausted: - Mark run/action dead-lettered or failed
according to the state model. - Store safe reason, attempt history, and
provider request ID if available. - Emit a metric and alert based on
rate/age. - Provide an authorized, audited retry/replay workflow. -
Require revalidation or an explicit override if the automation version
or target state changed.

### 11.4 Concurrency and fairness

-   Global worker concurrency cap.
-   Per-workspace concurrency and rate limits.
-   Per-integration/provider rate limits.
-   Bounded queue prefetch and batch size.
-   Fair scheduling so one workspace cannot monopolize all workers.
-   Separate queues or priority classes only when product requirements
    justify them.
-   Use backpressure when queue depth or provider error rate rises.

### 11.5 Ordering and races

If two events for one task arrive close together, actions may observe
newer state than the event snapshot. Define whether an action uses: 1.
immutable event snapshot, 2. current resource state, or 3. both, with an
explicit comparison.

Use aggregate version checks where stale updates would be dangerous. Do
not assume queue order is enough to prevent races.

------------------------------------------------------------------------

## 12. Idempotency, loops, and partial failure

### 12.1 Idempotency key

A key should represent the logical effect, for example:

`workspaceId + automationId + automationVersion + sourceEventId + actionIndex`

Use a stable hash/normalized encoding, not ambiguous raw concatenation.
For scheduled jobs, include the scheduled occurrence identity. Store the
key under a unique constraint.

### 12.2 Loop prevention

-   Attach `causationId`, `correlationId`, and an automation execution
    context to events produced by actions.
-   Configure whether automation-generated events can trigger the same
    or other automations.
-   Track the automation chain/hop count and enforce a hard maximum.
-   Detect simple self-trigger cycles during validation.
-   Enforce per-event and per-workspace execution budgets.
-   Avoid blanket suppression of all automation-generated events; some
    legitimate chained workflows need controlled support.
-   Add a loop circuit breaker and alert when trigger volume spikes.

### 12.3 Action sequencing and partial failure

Default to sequential actions for predictable behavior. Parallel
execution should be opt-in and only allowed for independent actions.

Define `onActionFailure` policy: - `stop`: stop later actions and mark
run failed/partially failed. - `continue`: continue only when later
actions are independent and policy allows. - `compensate`: execute
explicitly designed compensating actions; never assume arbitrary actions
can be rolled back.

There is no universal transaction across a database and external APIs.
Record each action separately and provide reconciliation.

------------------------------------------------------------------------

## 13. Security and threat model

### 13.1 Trust boundaries

-   Browser/client → API
-   API → database
-   Domain service → outbox/event bus
-   Event bus → worker
-   Worker → internal action handlers
-   Worker → external providers
-   Admin/operator → replay and support tooling

### 13.2 Core controls

-   Authenticate all management operations.
-   Resolve principal and workspace from trusted server-side
    identity/session context.
-   Enforce workspace scoping on every read, update, run, log, and
    replay.
-   Re-check authorization at execution time, not only when the rule is
    created.
-   Use action allowlists and typed schemas.
-   Keep integration secrets in a secret manager or encrypted secret
    store; rule documents hold references only.
-   Encrypt traffic and sensitive data at rest where supported.
-   Redact tokens, passwords, email bodies, and personal data from logs.
-   Apply payload, depth, timeout, concurrency, and rate limits.
-   Validate URLs for any future HTTP/webhook action; defend against
    SSRF with destination allowlists, DNS/IP validation,
    private/link-local address blocking, redirect checks, and egress
    controls.
-   Prevent unsafe HTML/script injection in templates and builder
    previews.
-   Use least-privilege database credentials and provider scopes.
-   Audit enable/disable, permission changes, secret changes, replay,
    and manual overrides.
-   Apply CSRF protections where cookie-based authentication requires
    them.
-   Use dependency scanning, secret scanning, code review, and patch
    management.

### 13.3 Threat scenarios to test

-   User forges another workspace ID.
-   Event payload claims a different workspace than the trusted
    aggregate.
-   Stale membership or revoked permission at execution time.
-   Malformed/deep condition tree causes CPU exhaustion.
-   Automation recursively triggers itself.
-   External URL targets internal metadata services.
-   Secret appears in an exception or trace.
-   Replay endpoint is used to repeat a payment/email/create operation.
-   Worker lease expires while the original worker is still active.
-   Malicious event payload exploits unsafe template rendering.
-   One workspace floods the queue to starve other tenants.

### 13.4 Security acceptance criteria

-   Missing/invalid workspace scope results in rejection before any
    data-driver call where applicable.
-   Cross-workspace test fixtures prove no resource leakage.
-   Invalid action types/operators are rejected.
-   Secrets are absent from logs, API responses, audit summaries, and
    error telemetry.
-   Replay and manual override are permission-checked and audited.
-   Security tests run in CI and on high-risk releases.

------------------------------------------------------------------------

## 14. Observability and operations

### 14.1 Structured logging

Use structured JSON logs with: - timestamp, severity, service,
environment, release - workspace ID (where policy permits), automation
ID/version, run ID, action ID - event ID, correlation ID, causation ID,
trace ID - attempt number, duration, error code, retry decision

Do not log credentials, full sensitive payloads, or raw authorization
headers. Treat IDs as potentially sensitive operational metadata.

### 14.2 Metrics

At minimum: - events received, rejected, deduplicated - eligible
automations matched - runs queued/running/succeeded/failed/timed
out/dead-lettered - action success/failure by action type and provider -
queue depth and oldest message age - outbox pending count and oldest
pending age - enqueue latency, queue wait, execution duration
(p50/p95/p99) - retries and retry exhaustion - worker lease expirations
and duplicate claims - provider latency, 429s, 5xx, timeout rate -
per-workspace usage/quota rejections - automation loop/circuit-breaker
activations

Use bounded-cardinality metric labels. Do not label metrics with
arbitrary user IDs, run IDs, or automation names.

### 14.3 Tracing

Trace the path from domain mutation/outbox through event ingestion,
matching, run execution, action handlers, and external provider calls.
Propagate trace context across queue boundaries where supported.

### 14.4 Proposed SLOs and alerts

Set final SLOs after baseline/load testing. Candidate service
indicators: - management API availability and latency - percentage of
accepted events enqueued within target time - queue age under normal
load - successful completion rate excluding expected permanent
business-rule failures - outbox publication delay - worker crash/lease
expiry rate

Alert on sustained breaches, not isolated single errors. Create runbooks
for: 1. Queue backlog growing 2. Outbox relay stalled 3. Provider
outage/rate limiting 4. High retry/DLQ rate 5. Automation loop spike 6.
Cross-tenant/security alert 7. Database unavailable 8. Bad deployment or
migration 9. Scheduler duplicate/missed occurrences

------------------------------------------------------------------------

## 15. Testing strategy

### 15.1 Test pyramid

1.  **Unit tests:** condition operators, schema validators, state
    machine, retry classifier, idempotency key generation.
2.  **Component tests:** action registry, repositories, policy checks,
    event matcher.
3.  **Integration tests:** real database semantics, unique indexes,
    transactions, outbox/inbox, queue and worker interactions.
4.  **Contract tests:** event schema compatibility, action schemas,
    OpenAPI responses, provider adapters.
5.  **End-to-end tests:** create rule → enable → emit event → run action
    → inspect audit/run.
6.  **Load/soak tests:** sustained event rate, bursts, many workspaces,
    long-running provider calls.
7.  **Resilience tests:** kill worker mid-action, disconnect database,
    duplicate event, timeout provider, expire lease.
8.  **Security tests:** tenant isolation, authorization, SSRF if
    relevant, payload abuse, replay authorization.
9.  **Migration tests:** upgrade from prior schema and rollback/forward
    recovery.

### 15.2 Minimum acceptance test catalogue

-   Valid rule validates and enables.
-   Unknown trigger/action/operator is rejected.
-   Missing workspace scope is rejected before persistence access.
-   Workspace A cannot read or execute workspace B automation.
-   Duplicate event creates at most one logical run.
-   Duplicate worker delivery does not duplicate idempotent effects.
-   Concurrent workers cannot both claim one run.
-   Worker crash is recovered after lease/visibility timeout.
-   Temporary provider error retries with backoff.
-   Permanent permission/configuration error does not retry
    indefinitely.
-   Exhausted run enters DLQ and is visible to authorized users.
-   Disabled automation does not receive new scheduled occurrences.
-   In-flight disable behavior follows documented policy.
-   Rule edit creates a new immutable version; existing run remains
    pinned.
-   Automation loop exceeds hop/budget limit and is stopped.
-   DST transition does not duplicate or silently omit a scheduled
    occurrence contrary to policy.
-   Secret redaction is tested against exceptions and provider
    responses.
-   Replay requires permission and produces an audit record.
-   Queue backlog and worker failure metrics/alerts are verified.
-   Retention does not delete active recovery data or required audit
    records.

### 15.3 CI quality gates

-   Formatting/lint, type checking, unit tests, integration tests,
    contract tests.
-   Architecture-boundary tests.
-   Dependency and secret scans.
-   Database migration validation.
-   Build reproducibility and lockfile integrity.
-   High-risk change approval.
-   No security-sensitive test may be silently skipped in release CI.

------------------------------------------------------------------------

## 16. Performance and capacity planning

Estimate: - peak domain events/second - average automations matching an
event - average actions per run - external provider latency and rate
limits - payload size and run-history retention - expected retries and
burst amplification

A rough work estimate:

`action attempts per second ≈ incoming events/sec × average matching automations/event × average actions/run × average attempts/action`

This is a capacity estimate, not a precise throughput guarantee. Retry
bursts and scheduled jobs can multiply the load.

Load-test: - steady state and 5--10x bursts - one very active workspace
alongside many small workspaces - slow provider responses - database
latency spikes - worker scale-out and scale-in - queue recovery after an
outage

Tune based on queue age and completion SLOs, not just CPU. Set quotas
before enabling broad fan-out.

------------------------------------------------------------------------

## 17. Deployment, migration, rollback, and recovery

### 17.1 Environments

-   Local development with deterministic seeded data
-   CI with isolated databases and queue/test doubles as appropriate
-   Staging with production-like configuration and secrets handling
-   Production with least-privilege credentials and monitored rollout

Never copy production secrets into local files or logs. Document
environment variables in `.env.example` without real credentials.

### 17.2 Release strategy

1.  Add schema changes using an expand-and-contract pattern.
2.  Deploy code that can read old and new formats where necessary.
3.  Enable event publishing behind a feature flag.
4.  Run shadow/dry-run evaluation and compare expected matches.
5.  Enable a small internal workspace/canary.
6.  Monitor errors, queue age, retries, and resource usage.
7.  Gradually expand rollout.
8.  Keep a rollback plan that accounts for already executed external
    side effects.

### 17.3 Rollback caveat

Rolling back code does not undo emails, external API calls, or already
committed task changes. Pause new execution, preserve run state, deploy
a compatible fix, reconcile uncertain actions, then resume deliberately.

### 17.4 Disaster recovery

Define and test: - database backup/restore and point-in-time recovery if
available - event/outbox retention and replay policy - queue durability
and broker recovery - recovery point objective (RPO) and recovery time
objective (RTO) - secret manager recovery - run-history reconciliation
after restore - a documented incident commander and escalation path

Do not claim an RPO/RTO until restore drills demonstrate it.

------------------------------------------------------------------------

## 18. Recommended implementation plan

Build in vertical slices. Avoid starting with every trigger, action,
integration, and visual builder at once.

### Phase 0 --- Discovery and repository audit

-   Inspect existing modules, domain events, principal/policy
    interfaces, gateway rules, database patterns, test packs, CI, and
    logging.
-   Write an ADR for queue choice, persistence/transactions, worker
    claiming, event versioning, and module boundaries.
-   Agree on initial SLOs and scope.

**Exit criteria:** architecture review accepted; ownership, interfaces,
threat model, and test plan approved.

### Phase 1 --- Core contracts and persistence

-   Define typed trigger/action registries and JSON schemas.
-   Implement automation draft/version models and workspace-scoped
    repository.
-   Add state-machine transitions and optimistic concurrency.
-   Add tenant-isolation tests and indexes.

**Exit criteria:** CRUD, validation, version pinning, and cross-tenant
rejection tested.

### Phase 2 --- Event reliability

-   Define event envelope and schema registry/version policy.
-   Implement transactional outbox and relay, or document why the
    existing infrastructure provides equivalent durability.
-   Implement event inbox/dedupe and trigger matching.
-   Add duplicate-delivery and crash-recovery integration tests.

**Exit criteria:** a domain event can be safely delivered more than once
without duplicate logical runs.

### Phase 3 --- Execution core

-   Implement run state machine, atomic claims/leases, action records,
    timeouts, retry classifier, and DLQ.
-   Add one low-risk built-in action such as an internal task-field
    update or notification.
-   Add audit and correlated observability.

**Exit criteria:** worker restart, transient failure, duplicate job, and
permanent failure tests pass.

### Phase 4 --- Management experience

-   Build rule editor, validation feedback, dry-run,
    enable/pause/disable, and run history.
-   Enforce server-side authorization; do not rely on UI visibility.
-   Add safe manual retry/replay.

**Exit criteria:** end-to-end workflow is usable by an authorized
workspace admin.

### Phase 5 --- Scheduling and guardrails

-   Add scheduled triggers, time-zone/DST policy, quotas, loop
    protection, per-workspace fairness, and retention.
-   Add load and resilience tests.

**Exit criteria:** capacity and operational targets are measured and
guardrails behave as expected.

### Phase 6 --- Production hardening

-   Threat-model review, penetration/security tests, dependency scans,
    runbooks, alert drills, backup/restore drill, staged rollout.
-   Complete operational readiness review.

**Exit criteria:** every production gate has an owner, evidence, and
sign-off.

------------------------------------------------------------------------

## 19. Architecture Decision Records (ADRs) to create

Use one file per decision, e.g. `docs/adr/0001-queue-and-delivery.md`.

Each ADR should contain: title, status, date, context, decision drivers,
options considered, decision, consequences, security/operational
implications, and follow-up actions.

Required ADRs: 1. Modular monolith versus service extraction. 2.
Queue/broker choice and delivery semantics. 3. Transactional outbox and
event deduplication. 4. Run store and worker claim/lease strategy. 5.
Condition language and action registry (no arbitrary code). 6.
Automation versioning and schema migration. 7. Retry, DLQ, replay, and
unknown external outcomes. 8. Tenant isolation and authorization at
execution time. 9. Scheduled trigger semantics including DST and missed
schedules. 10. Observability, retention, privacy, and audit
immutability. 11. API idempotency and optimistic concurrency. 12.
Rollout, feature flags, and backward compatibility.

------------------------------------------------------------------------

## 20. Suggested repository documentation layout

``` text
docs/
  README.md
  product/
    automation-engine-prd.md
    personas-and-use-cases.md
    functional-requirements.md
    acceptance-criteria.md
    glossary.md
  architecture/
    system-context.md
    container-and-component-design.md
    runtime-sequences.md
    domain-model.md
    data-model-and-indexes.md
    security-and-threat-model.md
    failure-modes.md
    scalability-and-capacity.md
  adr/
    0001-modular-monolith.md
    0002-event-delivery-and-queue.md
    0003-transactional-outbox.md
    0004-worker-claim-and-lease.md
    0005-rule-language-and-action-registry.md
    0006-versioning-and-migrations.md
    0007-retry-dlq-and-replay.md
    0008-tenant-isolation.md
  api/
    openapi.yaml
    event-contracts.md
    action-contracts.md
    error-codes.md
  data/
    schema.md
    indexes.md
    migrations.md
    retention-policy.md
  testing/
    test-strategy.md
    acceptance-test-catalogue.md
    performance-test-plan.md
    resilience-test-plan.md
    security-test-plan.md
  operations/
    deployment.md
    configuration.md
    dashboards-and-alerts.md
    runbooks/
      queue-backlog.md
      provider-outage.md
      dlq-recovery.md
      database-outage.md
      automation-loop.md
      rollback.md
    backup-and-restore.md
    operational-readiness-review.md
  user-guide/
    create-automation.md
    inspect-run-history.md
    troubleshooting.md
```

Do not create empty documents just to match this tree. Create each
document when the decisions and content are real, and link it from
`docs/README.md`.

------------------------------------------------------------------------

## 21. Definition of Done

A feature is not complete merely because its endpoint works locally. For
each automation capability, verify:

-   [ ] Product requirement and acceptance criteria approved.
-   [ ] Domain model and API/event contracts documented.
-   [ ] Workspace isolation and authorization tested.
-   [ ] Input validation and bounded resource use implemented.
-   [ ] Duplicate delivery and idempotency behavior defined.
-   [ ] Failure, timeout, retry, and unknown-outcome behavior tested.
-   [ ] Audit, logs, metrics, and traces added with redaction.
-   [ ] Unit, integration, contract, and relevant E2E tests pass.
-   [ ] Performance impact measured against target workload.
-   [ ] Migration and rollback strategy reviewed.
-   [ ] Security/dependency/secret scans pass or have approved risk
    disposition.
-   [ ] Runbook, alerts, and owner documented.
-   [ ] Code reviewed and CI quality gates pass.

## 22. Operational readiness checklist

Before enabling real users: - \[ \] On-call/ownership is assigned. - \[
\] SLOs and alert thresholds are agreed and dashboards exist. - \[ \]
Queue backlog and outbox lag can be detected. - \[ \] DLQ
inspection/retry process is tested. - \[ \] Cross-tenant isolation tests
run in CI. - \[ \] Secrets and PII redaction have tests. - \[ \] Worker
termination and recovery drill passed. - \[ \] Database backup
restoration drill passed. - \[ \] Rate limits and quotas are enabled. -
\[ \] Feature flags and safe pause/kill switch exist. - \[ \] Rollback
cannot accidentally resume unsafe work. - \[ \] Support team can inspect
a run without privileged database access. - \[ \] Retention, privacy,
and audit policies are approved.

------------------------------------------------------------------------

## 23. Decisions that must be confirmed for this specific repository

This is the most important project-specific follow-up. Before
implementation, inspect the actual `code_base_squid` repository and
record the answer to each question rather than assuming:

1.  Which package owns the automation domain and public types?
2.  Which existing principal/policy contract must all management and
    action execution use?
3.  Does the current MongoDB deployment support the
    transactions/replica-set semantics needed by the proposed outbox
    design?
4.  Is there already a durable queue, scheduler, event bus, or
    job-runner abstraction?
5.  Which repository/gateway rule requires all database access to pass
    through the scoped data gateway?
6.  How are workspace IDs verified, and how do existing tests prove
    missing scope fails before driver calls?
7.  What logging, tracing, error, validation, and API response
    conventions already exist?
8.  Which test pack/CI job should cover automation tenant isolation and
    reliability?
9.  How are secrets/configuration loaded and validated in local, CI,
    staging, and production?
10. What are the expected event volume, run retention, action catalog,
    and external integration requirements?

Given the existing SQUiD work around a workspace-scoped gateway, policy
decisions, principal resolution, and TypeScript/Node services, the
engine should reuse those established boundaries rather than introducing
a second authorization or persistence path. Confirm the exact package
locations and contracts from the repository before writing
implementation code.

------------------------------------------------------------------------

## 24. Senior-engineer principles to keep

1.  **Start with invariants and failure modes, not endpoints.**
2.  **Use a declarative rule model, not arbitrary user code.**
3.  **Make workspace scope impossible to omit from persistence paths.**
4.  **Treat events and queue messages as at-least-once unless proven
    otherwise.**
5.  **Pin every run to an immutable rule version.**
6.  **Assume workers crash and external requests can have ambiguous
    outcomes.**
7.  **Keep actions behind typed, authorized interfaces.**
8.  **Measure queue age, end-to-end latency, retry rates, and cost.**
9.  **Build one complete vertical slice before adding many
    integrations.**
10. **Do not call a system production-ready until operational and
    recovery evidence exists.**

**Recommended first implementation slice:** task status-change event →
durable event intake/deduplication → workspace-scoped trigger match →
one immutable automation version → one internal notification action →
persisted run/action history → tests for duplicate event,
cross-workspace access, worker retry, and audit. This proves the core
architecture before the team invests in a large visual builder or a
broad action catalogue.
