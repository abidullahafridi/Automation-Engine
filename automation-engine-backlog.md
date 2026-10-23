# Automation Engine — Delivery Backlog (companion to spec v2.0)

**Companion to:** `automation-engine-spec-v2.md`
**Source:** v1.2 delivery sections, carried forward with the corrections below, plus new stories required by the v2.0 design.

**Latest evidence-based epic readiness review:** [2026-10-20 audit](docs/architecture/readiness-audit-2026-10-20.md).
Task status notes below are dated implementation/verification snapshots; consult that audit for
current runtime composition, production evidence, and open acceptance criteria.

## How to read this file

- Section numbers **25, 27–35 and 53 are preserved from v1.2** so existing links and traceability keep working. v1.2 §26 (requirement catalogue: FR / NFR / BR / CON) now lives in **spec v2.0 §5** — it was the canonical list; the older, conflicting FR list from v1.1 §3.1 was removed.
- v1.2 §36 (gap-review disposition) → spec **Appendix B**. v1.2 §54 (release gates) → spec **Appendix C**. v1.2 §37–52 → spec **Part B (§18–§33)**.
- Story IDs `AE-US-083` to `AE-US-087` (Section 56 below) are **new in v2.0**.
- Priorities (P0/P1/P2) and any estimate remain **proposals** until the repository audit (AE-E00) and product/engineering review confirm them.
- Where a story says "Requirements: FR-…", look the ID up in spec §5.

### Corrections applied relative to v1.2 text
1. Requirement IDs resolve to **one** catalogue (spec §5).
2. "Section 23 decisions" referenced in v1.2 are now answered as *proposed defaults* in spec §3 (D-01…D-28); AE-E00 confirms or replaces them via ADR.
3. Lease-expiry recovery path is explicit: `claimed → queued`; `evaluating/running → retry_wait (LEASE_EXPIRED) → queued`.
4. Maximum attempts always means **total attempts including the first**.

---

# 25. Delivery planning and work hierarchy (Epic → Feature → Story → Task → Subtask)

This section converts the architecture specification into an implementable, reviewable backlog. Use this hierarchy in ClickUp/Jira or the project's existing work-management conventions. The hierarchy below is a **recommended baseline backlog**, not a claim that repository inspection has confirmed these modules already exist.

## 25.1 Work-item hierarchy and rules

| Level | Purpose | Required fields | Example |
|---|---|---|---|
| Epic | A large outcome that may span multiple releases | ID, outcome, scope, owner, success measure, child features/stories, dependencies, risks | `AE-E01 — Secure automation definitions` |
| Feature | A user-visible or platform capability supporting an epic | ID, outcome, in/out of scope, requirement links, dependencies | `AE-F01 — Create and validate automation rules` |
| User Story | A testable value slice for a persona | ID, story statement, context, requirements, acceptance criteria, priority, dependencies | `AE-US-010 — Save a draft automation` |
| Task | A specific engineering/QA/UX/DevOps deliverable needed to complete a story | ID, owner role, inputs, expected output, test cases, “Done when”, dependencies | `AE-T-010.1 — Add scoped automation repository methods` |
| Subtask | A small, verifiable piece of a task | ID, action, expected evidence, estimate if used | `AE-ST-010.1a — Add workspaceId to repository query` |

**Important:** Scrum does not prescribe one universal issue hierarchy. Teams often represent tasks/subtasks directly under a story; some tools add Feature between Epic and Story. Keep the logical relationship above even if the selected tool has different native nesting.

### Work-item conventions

- Stable IDs: `AE-E##`, `AE-F##`, `AE-US-###`, `AE-T-###.#`, `AE-ST-###.#a`, requirement IDs `FR-###`, `NFR-###`, test IDs `TC-###`.
- Each Story links to at least one requirement or an explicit technical enabler/ADR.
- Each Story has testable acceptance criteria before implementation starts.
- Each Task has a single primary owner, output/evidence, dependencies, test cases, and an explicit **Done when** statement.
- Subtasks are independently checkable. Do not split work into micro-subtasks that create administration without reducing risk.
- Story points/estimates are team-owned. Do not guess estimates before repository audit and capacity calibration.
- Status meanings must be explicit. Recommended: `Backlog → Ready → In Progress → In Review → QA/Verification → Done`; use `Blocked` as a flag or status according to team policy.
- A task is not `Done` simply because code was written. Its stated tests, review, docs, security, and observability evidence must be present.

## 25.2 Standard user-story template

```markdown
## [AE-US-###] Story title

**Epic:** AE-E##
**Feature:** AE-F##
**Story:** As a [persona], I want [capability], so that [outcome].
**Priority:** P0 / P1 / P2
**Status:** Backlog / Ready / In Progress / In Review / Verification / Done
**Owner:** role or named owner
**Requirements:** FR-###, NFR-###, BR-###
**Dependencies:** story/task/ADR IDs or None
**Constraints:** security, compatibility, performance, data, product limits
**Assumptions:** explicitly list unverified assumptions

### Acceptance criteria
Given [known starting state]
When [action/event]
Then [observable result]
And [security/reliability behavior]

### Tasks
- [ ] AE-T-###.# — [deliverable]
  - [ ] AE-ST-###.#a — [implementation step]
  - [ ] AE-ST-###.#b — [verification step]

### Story-level test cases
- TC-###: setup / action / expected result

### Definition of Done
- [ ] All acceptance criteria pass
- [ ] All task-level “Done when” checks pass
- [ ] Required tests pass in CI
- [ ] Review/security/observability/docs checks pass where relevant
- [ ] Evidence linked in the issue
```

## 25.3 Standard Task template

```markdown
## [AE-T-###.#] Task title

**Parent story:** AE-US-###
**Owner role:** Backend / Frontend / QA / DevOps / Security
**Goal:** one concrete engineering result
**Requirements:** FR-### / NFR-### / BR-###
**Preconditions/dependencies:** ...
**Inputs:** contracts, schemas, ADR, existing module/interface
**Output/evidence:** code, migration, test report, diagram, dashboard, runbook, etc.
**Constraints:** workspace scope, API compatibility, timeout, size/quotas, etc.

### Subtasks
- [ ] AE-ST-###.#a — implementation item
- [ ] AE-ST-###.#b — automated verification item
- [ ] AE-ST-###.#c — documentation/review item when applicable

### Task test cases
| Test ID | Type | Setup and action | Expected result |
|---|---|---|---|
| TC-### | Unit/Integration/Security | Concrete test steps | Observable assertion |

### Done when
- [ ] Exact output is implemented and reviewed
- [ ] Named test cases pass and evidence is linked
- [ ] Error/edge cases and security scope are checked
- [ ] Relevant metrics/logs/docs/migrations are included
- [ ] No known blocker remains; remaining risks are recorded and accepted
```

---


---

# 27. Epic map and release sequencing

The recommended delivery order is dependency-driven. Priorities: **P0 = required for the first secure vertical slice**, **P1 = required before general availability for the relevant capability**, **P2 = later enhancement**. The product owner and engineering lead should ratify these priorities after the repository audit.

| Epic | Outcome | Main features | Priority | Depends on |
|---|---|---|---|---|
| AE-E00 | Repository facts and design decisions are known | Codebase audit, ADRs, contracts, threat model | P0 | None |
| AE-E01 | Automation definitions are secure, validated and versioned | Scoped CRUD, schema validation, version lifecycle | P0 | AE-E00 |
| AE-E02 | Domain events can be delivered and matched reliably | Event contracts, outbox, inbox/dedupe, trigger matcher | P0 | AE-E00, AE-E01 |
| AE-E03 | Runs/actions execute safely and recover from failure | State machine, worker claiming, actions, retry, DLQ | P0 | AE-E01, AE-E02 |
| AE-E04 | Execution is governed and observable | Policy recheck, loop protection, audit, logs/metrics/traces, quotas | P0/P1 | AE-E01, AE-E03 |
| AE-E05 | Users can manage and diagnose automations | Management API, builder, dry-run, run history, replay | P0/P1 | AE-E01, AE-E03, AE-E04 |
| AE-E06 | Time triggers and broader scale are supported | Scheduler, timezone/DST, fairness, performance | P1 | AE-E02, AE-E03, AE-E04 |
| AE-E07 | The service is operationally ready for production | CI/CD, load/resilience/security tests, backup/restore, runbooks | P0 release gate | AE-E01 through AE-E05; AE-E06 before scheduled triggers GA |

---

# 28. Detailed backlog: epics, features, stories, tasks, subtasks and tests

## AE-E00 — Repository discovery and architecture decisions

**Outcome:** implementation decisions align with the actual SQUiD codebase, existing contracts, and operating constraints.

### AE-F00.1 — Codebase and dependency audit

**Feature outcome:** known modules, interfaces, conventions, gaps and constraints are documented.

#### AE-US-000 — Map the existing architecture

**Story:** As an engineering lead, I want an evidence-based repository map so that the engine reuses existing boundaries and does not introduce duplicate infrastructure.

**Requirements:** CON-001, CON-002; technical enabler for FR/NFR implementation.

**Acceptance criteria**
- Given the repository is available, when the audit is complete, then relevant packages, entry points, database access, policy/principal interfaces, tests, CI jobs and configuration paths are linked in the document.
- Given an interface is not found or cannot be verified, then it is marked unknown rather than assumed to exist.
- Given a proposed architecture dependency, then the audit records whether an existing reusable implementation already exists.

**Tasks and task test cases**

**AE-T-000.1 — Inventory relevant modules and contracts**
- Subtasks: inspect package/workspace structure; find gateway/repository patterns; find principal/policy types; find event/queue/scheduler abstractions; record references and unknowns.
- Test cases: `TC-0001` verify every proposed integration point has a file/path or is explicitly marked missing; `TC-0002` second reviewer can follow links and reproduce findings.
- **Done when:** `docs/architecture/repository-audit.md` lists verified facts, source paths, unknowns and proposed reuse points; reviewer signs off.
- **Status (2026-10-15): Done.** Repository inventory documented in `docs/architecture/repository-audit.md`, reviewed and signed off by Abid Ullah.

**AE-T-000.2 — Validate runtime and persistence assumptions**
- Subtasks: inspect MongoDB connection/configuration; verify transaction prerequisites; inspect current test infrastructure; identify existing logging/error/config conventions.
- Test cases: `TC-0003` local/CI topology is recorded accurately; `TC-0004` unsupported transaction/queue assumption is listed as a blocker or an ADR decision, not presented as fact.
- **Done when:** infrastructure facts are confirmed through configuration/runtime evidence, and unresolved choices are explicit.
- **Status (2026-10-15): Done.** Runtime, tests, and configuration conventions documented with real evidence in repository-audit.md; reviewer/operating owner Abid Ullah signed off.

**AE-T-000.3a — Verify transactions on an approved replica-set environment**
- Subtasks: run transaction verifier probe against an approved replica-set environment using supported driver/configuration; record sanitized evidence JSON with topology, environment name, owner, and date; record environment as the approved repeatable LOCAL environment (CI job stays "proposed, infra approval pending").
- Test cases: `TC-0009` multi-document commit persists documents; `TC-0010` abort leaves zero staged documents; duplicate key aborts; concurrent updates prevent lost updates.
- **Done when:** a real probe PASS on ALL checks against a replica-set environment (evidence JSON with topology, environment name, owner, date) + that environment recorded as the approved repeatable LOCAL environment.
- **Status (2026-10-15): Done.** Verification owner Abid Ullah recorded local replica set `rs0` on MongoDB 8.3.9 (`mongodb://localhost:27017/automation_test?replicaSet=rs0`). Verification run passed 5/5 checks (`topology`, `atomicCommit`, `abortRollback`, `duplicateKeyAbort`, `concurrentNoLostUpdate`). Evidence is recorded in [ae-t-000-3-mongodb-transactions-2026-10-15T10-07-18-790Z.json](docs/architecture/evidence/ae-t-000-3-mongodb-transactions-2026-10-15T10-07-18-790Z.json). CI replica set job remains proposed pending infra owner approval.

**AE-T-000.3b — Convert the production target to a replica set and verify it**
- Note: Moved to **AE-E07** as a **P0 RELEASE GATE** (see AE-F07.2 / AE-US-071).
- **Owner:** Abid Ullah | **ETA:** TBD (blank)
- **Status:** Pending / Open release gate. Blocks production enablement of outbox/ingest feature flag per ADR-0003 gate.

### AE-F00.2 — Architecture and risk decisions

#### AE-US-001 — Approve core architecture decisions

**Story:** As the engineering team, we want reviewed ADRs for choices that affect reliability and security so that implementation work has a stable basis.

**Acceptance criteria**
- Given a major unresolved choice, when an ADR is accepted, then it contains context, options, decision, consequences and follow-up work.
- Given the queue, outbox, claim strategy, rule language or versioning choice is unapproved, then dependent implementation stories remain `Blocked/Not Ready`.

**Tasks and task test cases**

**AE-T-001.1 — Write and review required ADRs**
- Subtasks: draft queue/delivery ADR; outbox/transactions ADR; worker claim/lease ADR; rule DSL/action registry ADR; version/migration ADR; retry/replay ADR; tenant-scope ADR; scheduling/DST ADR.
- Test cases: `TC-0005` every accepted ADR has at least one reviewer; `TC-0006` decision conflicts and operational consequences are captured.
- **Done when:** required ADRs are accepted or explicitly deferred with an owner, date/reason and blocked stories listed.
- **Status (2026-10-15): Done.** Reviewer owner Abid Ullah approved ADRs under the single-reviewer exception (recorded as an accepted risk, as done for ADR-0005). ADR-0003, ADR-0005, ADR-0006, and ADR-0008 are Accepted (decision) with production gates; ADR-0001, ADR-0002, ADR-0004, ADR-0007, and ADR-0009 remain deferred with owner, date, and reasons recorded. Per owner rule: "Accepted (decision)" does not block development; missing verification blocks only production enablement.

**AE-T-001.2 — Establish initial service objectives and workload assumptions**
- Subtasks: estimate expected event rate and fan-out; agree queue age/latency metrics; define run-history retention; identify operating owner.
- Test cases: `TC-0007` each proposed SLO has a measurable indicator and data source; `TC-0008` unmeasured targets are labelled provisional.
- **Done when:** baseline NFR/SLO document has owners, measurement method, load assumptions and review date.
- **Evidence:** [Workload and SLO baseline worksheet](docs/architecture/workload-and-slo-baseline-worksheet.md) and [service objectives baseline](docs/architecture/automation-service-objectives.md). Operating owner: Abid Ullah. Review date: TBD (blank, owner sets). Peak 50 events/sec, 2 automations/event, 2 actions/run, 100 workspaces (all provisional guesses); retention 30 days run-history, ~400 days audit (owner proposal, privacy review pending).
- **Status (2026-10-15): Done as a PROVISIONAL baseline; to be re-validated after the AE-E06 load test.** No number is presented as measured.

---

## AE-E01 — Automation definitions, validation and versioning

**Outcome:** the platform stores only well-formed, scoped, controlled automation definitions and immutable executable versions.

### AE-F01.1 — Workspace-scoped automation management

#### AE-US-010 — Create and retrieve a draft automation

**Story:** As an authorized workspace automation author, I want to create and view a draft so that I can define a workflow without it executing prematurely.

**Requirements:** FR-001, FR-002, FR-003, BR-001, BR-004.

**Acceptance criteria**
- Given a principal with permission and valid workspace scope, when a valid draft is created, then the record is persisted under that workspace and starts non-executable.
- Given missing scope, invalid membership, or another workspace's ID, when create/read is attempted, then access is rejected without leaking resource existence.
- Given the request contains unsupported or oversized fields, then it is rejected with stable validation errors.

**Tasks and task test cases**

**AE-T-010.1 — Implement scoped automation repository and data model**
- Subtasks: define schema/types; add workspace-scoped insert/find/update methods; add required indexes; add repository contract tests.
- Test cases: `TC-0101` create/read succeeds within same workspace; `TC-0102` cross-workspace read returns not found/denied per API policy; `TC-0103` missing scope fails closed; `TC-0104` uniqueness and index behavior match documented rules.
- **Done when:** repository methods require trusted scope by interface, index migration is covered, and all four tests pass against the supported database semantics.
- **Status (2026-10-14): Done for repository/data-model scope.** Added a MongoDB-backed adapter behind the server Mongo integration boundary, with resolver-minted scope validation before database commands, workspace-filtered reads/writes, optimistic draft revisions, idempotent create/version insert, and explicit idempotent index creation. TC-0101–TC-0104 pass against an isolated localhost MongoDB 8.3.9 database (standalone): create/read and draft-only defaults, cross-workspace non-enumeration, missing-scope rejection with command monitoring, and compound uniqueness/index behavior. This verifies repository CRUD/index semantics only; it does not establish the target deployment topology, transaction support (AE-T-000.3 remains blocked), real platform authentication, or production enablement.

**AE-T-010.2a — Implement create/list/read API contracts and ports**
- Subtasks: request/response schema; cursor pagination; auth/policy ports; deny-everything default adapter (503); adapter-agnostic conformance suite; tenant matrix; OpenAPI update and validation; feature flag default OFF.
- Test cases: `TC-0105` invalid body gets 4xx plus field path; `TC-0106` unauthenticated request rejected (401); `TC-0107` unauthorized role rejected (404 non-enumerating); `TC-0108` pagination cursor does not skip/duplicate records under stable ordering; default deny adapter returns 503.
- **Done when:** API contracts and OpenAPI agree, OpenAPI lint clean with real validator, permission tests pass, deny-everything default adapter (503) tested, and no internal stack trace or sensitive data is exposed.
- **Status (2026-10-15): Done.** Implemented in `automation.routes.ts` with injected `PrincipalResolver` and `PolicyPort`. Deny-everything default adapters (`createDenyAllPrincipalResolver`, `createDenyAllPolicyPort`) return HTTP 503 `AUTOMATION_SERVICE_UNAVAILABLE` when platform auth is unconfigured. Full adapter-agnostic test suite in `automation.api.test.ts` passes (68/68 API tests pass). Redocly CLI lint passed clean (0 errors, 0 warnings). Feature flag `automationApiEnabled` is default OFF in API config.

**AE-T-010.2b — Implement real platform PrincipalResolver/PolicyPort adapter**
- Note: Moved to **AE-E07** as a **P0 RELEASE GATE** (see AE-F07.2 / AE-US-071).
- **Owner:** Abid Ullah | **ETA:** TBD (blank)
- **Status:** Pending / Open release gate. Done only when the conformance suite and tenant matrix pass against the REAL platform. The automation API feature flag stays OFF until then. Platform auth location is currently `NONE`; specified in [docs/architecture/platform-auth-contract.md](docs/architecture/platform-auth-contract.md).

### AE-F01.2 — Rule schema and validation

#### AE-US-011 — Validate triggers, conditions and actions

**Story:** As an automation author, I want actionable validation errors so that invalid or unsafe rules cannot be enabled.

**Requirements:** FR-003, FR-004, FR-005, FR-009, FR-010, CON-003.

**Acceptance criteria**
- Given a registered trigger/action and a correctly typed config, when validated, then it passes schema and semantic validation.
- Given an unknown action/operator/field or invalid type, when validated, then it is rejected with a stable code and precise field path.
- Given excessive nesting, list size, payload size or unsupported expression syntax, then validation terminates within its configured resource budget.

**Tasks and task test cases**

**AE-T-011.1 — Build typed trigger/action/operator registries**
- Subtasks: define registry interfaces; register first trigger; register first internal action; define condition operators; declare per-item input/output schemas and permissions.
- Test cases: `TC-0111` registered config validates; `TC-0112` unregistered type is rejected; `TC-0113` schema mismatch rejected; `TC-0114` registry collision at startup fails loudly rather than overriding silently.
- **Done when:** registry is typed, deterministic, documented, duplicate registrations fail tests, and no dynamic code evaluation exists.
- **Status (2026-10-15): Done for registry-contract scope.** Typed trigger/action registries, condition operator metadata, duplicate-registration failure, registered-schema validation, and declarative per-action permission/result/timeout/retry/redaction metadata are covered by tests. Permission enforcement and recipient resolution belong to action execution work (AE-T-031.1/.2) and remain deferred; this task only requires those permissions and contracts to be declared.

**AE-T-011.2 — Implement bounded condition parser/evaluator**
- Subtasks: field allowlist by trigger; type checks; null/missing semantics; recursion/list limits; deterministic evaluator.
- Test cases: `TC-0115` all supported operators cover true/false boundary cases; `TC-0116` null and missing fields produce documented outcomes; `TC-0117` invalid traversal cannot access internal object properties; `TC-0118` deep/large input is rejected before expensive evaluation.
- **Done when:** operator table and semantics are documented, unit/property tests pass, and evaluation has enforceable bounds.
- **Status (2026-10-15): Done for bounded parser/evaluator scope.** Implemented and API-tested using the registry-owned field allowlist. Missing-field `ne`/`not_in` return non-match. Limits and operator semantics are documented in `servers/api/features/automation/condition-language.md`; API/production enablement remains gated separately.

**AE-T-011.3 — Implement full draft validation endpoint/service**
- Subtasks: compose schema checks; cross-field checks; stable error mapping; validation-result tests.
- Test cases: `TC-0119` multiple field errors are returned deterministically; `TC-0120` invalid rule cannot be enabled; `TC-0121` safe error response contains no stack trace/secrets.
- **Done when:** one service validates all supported components and API responses are contract-tested.
- **Status (2026-10-15): Done for validation service/API contract scope.** `POST /api/v1/workspaces/{workspaceId}/automations/validate` applies payload bounds and registered trigger/condition/action validation behind the injected resolver/policy ports. It returns deterministic stable codes and JSON-pointer paths without echoing submitted values; OpenAPI and route tests cover valid/invalid drafts, multiple errors, authentication, denial, and malformed requests. Invalid publication remains blocked by the version service and is covered by publication tests. The route still requires a real platform auth/policy adapter before production use.

### AE-F01.3 — Immutable version lifecycle

#### AE-US-012 — Publish and pin a rule version

**Story:** As an automation author, I want a validated rule published as an immutable version so that a running execution cannot change underneath a worker.

**Requirements:** FR-006, FR-021, BR-002, BR-003.

**Acceptance criteria**
- Given an invalid draft, when enable is attempted, then no executable version is activated.
- Given a valid draft, when enable/publish succeeds, then a new immutable version and content hash are recorded.
- Given a run has started, when a newer version is published, then the existing run continues with its pinned version unless a documented cancellation rule applies.

**Tasks and task test cases**

**AE-T-012.1 — Implement version creation and activation transitions**
- Subtasks: define version fields; validate-then-publish transaction/consistency; optimistic concurrency; lifecycle transition guard.
- Test cases: `TC-0122` publish creates expected version; `TC-0123` concurrent edit gives version conflict; `TC-0124` published version cannot be modified; `TC-0125` run retains old version after update.
- **Done when:** immutable/version semantics are enforced at repository and service layer with race-condition tests.
- **Status (2026-10-15): Done for repository/service scope.** The durable Mongo adapter enforces unique `(workspaceId, automationId, version)` and publish-key indexes, immutable insert-only versions, idempotent retries, and optimistic header revision CAS. The isolated localhost Mongo integration test now covers TC-0122–TC-0125 plus a competing header update between version insert and CAS and concurrent same-key publication; it passed 9/9 nested checks. The focused in-memory version lifecycle/service tests passed 11/11, and API lint/typecheck passed. This satisfies this task's repository/service Done criterion. Migration recovery, independent review, run persistence/retention, and production enablement remain separate ADR-0006/ADR-0008 gates; this status does not claim those gates are complete.

**AE-T-012.2 — Add lifecycle audit events**
- Subtasks: record actor and version; audit enable/pause/disable/archive; redact configuration secrets.
- Test cases: `TC-0126` successful transition records one audit item; `TC-0127` denied transition does not falsely record success; `TC-0128` audit payload contains no secret values.
- **Done when:** lifecycle audit tests pass and audit schema is documented.
- **Status (2026-10-15): Done for task contract scope using the in-memory AuditPort.** Lifecycle events append through the append-only port; tests cover successful/denied transitions and secret-extra omission, and `lifecycle-audit.md` documents the schema. Durable append-only database permissions, retention (pending owner approval; ~400 days is only a proposal), independent security review, and production integration remain separate operational gates; this is not a production audit system.

---

## AE-E02 — Reliable event ingestion and trigger matching

**Outcome:** domain changes become durable, validated, deduplicated event work.

### AE-F02.1 — Event contracts and publication

#### AE-US-020 — Publish a domain event after a successful task mutation

**Story:** As a platform, I want task lifecycle events to represent committed domain changes so that automations do not act on changes that rolled back.

**Requirements:** FR-007, FR-008, BR-001; CON-004, CON-005.

**Acceptance criteria**
- Given task mutation succeeds, when its transaction commits, then the corresponding event is durably available for publication.
- Given task mutation fails/rolls back, then no event indicating successful mutation is published.
- Given the relay publishes then crashes before recording publication, duplicate delivery is tolerated by downstream deduplication.

**Tasks and task test cases**

**AE-T-020.1 — Define versioned domain event envelope**
- Subtasks: define required fields; specify actor/aggregate/scope provenance; document payload minimization; add schema compatibility checks.
- Test cases: `TC-0201` valid event passes; `TC-0202` missing event ID/workspace/schema version rejected; `TC-0203` incompatible schema change fails contract CI.
- **Done when:** event contract is versioned, validated, documented and covered by compatibility tests.
- **Status (2026-10-15): Done for event contract scope.** The strict `task.status_changed` v1 envelope validates event identity/type/version/time, workspace, actor, aggregate, bounded task snapshot fields, and spec-defined aggregate revision/correlation/causation/origin metadata. The snapshot excludes descriptions and unrelated sensitive fields; workspace/actor/aggregate provenance must come from trusted publisher context. Compatibility tests retain a frozen pre-addition v1 event, verify current producers' additive metadata, reject malformed provenance and required-field breaking changes, and are documented in `domain-event.md`. Focused contract tests pass. Event publication and durable outbox behavior remain AE-T-020.2 and are not included in this task.

**AE-T-020.2 — Implement transactional outbox or approved equivalent**
- Subtasks: write event with domain mutation; create relay claim/publish flow; add retry/backoff; add pending-age metrics.
- Test cases: `TC-0204` mutation and outbox record commit together when transaction support is chosen; `TC-0205` rollback leaves neither successful mutation nor outbox event; `TC-0206` relay crash after publish yields tolerated duplicate; `TC-0207` stale relay lease is recovered.
- **Done when:** Failure scenarios are verified, ADR is documented, and pending records are recoverable and observable.
- **Status (2026-10-15):** Partly complete; local integration tests PASS (6/6).
- **ADR-0003:** Accepted; outbox transaction design documented.
- **Test coverage:** TC-0204–TC-0207, rollback, duplicate protection, and observability PASS.
- **Production gate:** Pending actual target-environment verification via `scripts/verify-mongo-transactions.mjs`; feature flag remains OFF.
- **Completion:** Not Done until production verification passes and evidence is recorded.

### AE-F02.2 — Event ingestion, dedupe and trigger matching

#### AE-US-021 — Match one event to eligible automations once

**Story:** As the engine, I want to validate and deduplicate domain events before matching rules so that duplicate deliveries do not create duplicate logical work.

**Requirements:** FR-007, FR-008, FR-019, BR-001, BR-010.

**Acceptance criteria**
- Given a valid unseen event, when ingested, then it is recorded and eligible enabled automation versions in the same workspace are matched.
- Given the same event is received repeatedly, then at most one logical run per intended idempotency scope is created.
- Given event scope conflicts with trusted aggregate/scope information, the event is rejected and an auditable/observable security signal is emitted.

**Tasks and task test cases**

**AE-T-021.1 — Implement inbox/deduplication repository**
- Subtasks: unique event key; atomic insert/duplicate detection; retention rule; metrics for duplicate/rejected messages.
- Test cases: `TC-0211` duplicate event hits uniqueness path; `TC-0212` concurrent ingestion creates one logical accepted event; `TC-0213` duplicate response is safe and observable; `TC-0214` dedupe retention does not expire before replay window.
- **Done when:** unique-key race tests pass and the retention/replay relationship is documented.
- **Status (2026-10-15): Done.** `inbox.repository.ts` provides a Mongo-backed global `eventId` unique index, majority-write atomic insert/duplicate detection, workspace-conflict rejection, TTL retention, and injected duplicate/rejected metrics. `inbox-retention.md` documents the supported 30-day replay/redelivery window plus a five-day recovery buffer (35-day key retention). TC-0211, TC-0213, and TC-0214 pass; TC-0212 passed against the local MongoDB `rs0` replica set with 20 concurrent writes, exactly one accepted inbox record, and 19 safe duplicates. The complete API test suite passes 90/90.

**AE-T-021.2 — Implement workspace-scoped trigger matcher**
- Subtasks: indexed candidate lookup; match trigger type/config; check enabled version; evaluate bounded eligibility; create run idempotently.
- Test cases: `TC-0215` correct rule matches; `TC-0216` different workspace rule never matches; `TC-0217` paused/disabled rule is not selected for new work; `TC-0218` malformed event is rejected; `TC-0219` candidate flood is limited by quotas/bounds.
- **Done when:** matcher uses trusted workspace scope, creates pinned-version runs, and all match/non-match paths have integration coverage.
- **Status (2026-10-15): Done.** `trigger.matcher.ts` uses resolver-minted workspace scope in the Mongo candidate query, selects only enabled headers whose current published version has the matching trigger type, rechecks workspace scope before evaluation, evaluates trigger configuration and bounded registered conditions, and creates idempotent runs pinned to `(automationId, version, contentHash)`. Candidate lookup is capped at 100 and rejects overflow before creating work. TC-0215–TC-0219 pass, including cross-workspace rejection, paused/disabled exclusion, malformed-event rejection, and candidate flood protection. The Mongo integration test verifies enabled workspace candidate selection and durable one-run persistence; the complete API suite passes 96/96 on local MongoDB replica set `rs0`.

---

## AE-E03 — Run orchestration and action execution

**Outcome:** workers execute actions with safe claiming, bounded retries, and recoverable state transitions.

### AE-F03.1 — Run/action state machine and claims

#### AE-US-030 — Claim a queued run without concurrent ownership

**Story:** As the engine, I want atomic run claiming so that two workers cannot both believe they own the same execution.

**Requirements:** FR-011, BR-002, BR-007.

**Acceptance criteria**
- Given a queued run, when one worker claims it successfully, then its status/lease owner/expiry are recorded atomically.
- Given two workers claim concurrently, then no more than one claim succeeds for the same lease generation.
- Given a worker disappears and a lease expires, then recovery can requeue/reconcile work under documented idempotency rules.

**Tasks and task test cases**

**AE-T-030.1 — Implement run and action persistence/state transitions**
- Subtasks: define legal transitions; add optimistic version/conditional updates; persist action attempts; add indexes for history/claim queries.
- Test cases: `TC-0301` legal transition succeeds; `TC-0302` illegal transition is rejected; `TC-0303` concurrent claims yield one owner; `TC-0304` status update with stale version fails; `TC-0305` action index uniqueness prevents duplicate action record.
- **Done when:** transitions are centralized, illegal transitions and claim races are covered by integration tests, and state model is documented.
- **Status (2026-10-15): Done for repository/state-transition scope.** `run.repository.ts` centralizes legal run transitions, revision-guarded conditional writes, atomic queued-run claims, monotonic fencing-token increments, action-attempt persistence, and the history/claim/uniqueness indexes. `run-state-model.md` documents run states and the concurrency invariants. TC-0301–TC-0305 passed against local MongoDB replica set `rs0`, including two concurrent claim attempts yielding exactly one owner and duplicate action-attempt prevention. The complete API suite passed 102/102. Lease renewal, expiry recovery, shutdown, and unknown-outcome behavior remain AE-T-030.2; production claim enablement remains subject to ADR-0004 approval.

**AE-T-030.2 — Implement worker lease/recovery and graceful shutdown**
- Subtasks: acquire/renew lease; recover expired lease; stop accepting new jobs during shutdown; record interrupted/unknown outcome.
- Test cases: `TC-0306` lease expiration enables controlled recovery; `TC-0307` stale worker cannot overwrite a newer lease generation; `TC-0308` graceful shutdown stops new claims; `TC-0309` crash mid-action leaves a recoverable known state.
- **Done when:** worker lifecycle tests run in CI or a reliable resilience suite and lease invariants are documented.
- **Status (2026-10-21): Implementation complete; release verification Pending.** `retry_wait` now persists a fenced `runAfter`/`firstAttemptAt` from `retry.policy.ts`; `automation_action_attempts` is written before handler invocation and updated afterward; a previously succeeded action is skipped, while `running`/`unknown_outcome` attempts are not blindly repeated. Run state and wiring docs were updated. Focused resilience tests passed: `run.execution.test.ts` (13/13), `run.lease.test.ts` (7/7), `concurrency-fairness.test.ts` (4/4), `automation.architecture.test.ts` (3/3); API suite passed 311/324 with 13 Mongo-backed tests skipped. Repository-wide `pnpm run validate` remains blocked by unavailable `pnpm audit`/managed TruffleHog execution. Mongo persistence checks (including retry due-time and write-ahead update) remain unverified because `MONGO_URI` is unset and Docker is unavailable; keep this task Pending until those tests run against approved local `rs0`.

### AE-F03.2 — Typed action execution

#### AE-US-031 — Execute a registered internal action

**Story:** As an authorized workspace user, I want an automation to execute a supported action after its conditions pass so that repetitive work is automated safely.

**Requirements:** FR-009, FR-010, FR-011, BR-005, BR-006.

**Acceptance criteria**
- Given conditions pass and action permissions remain valid, when execution starts, then the registered handler receives a validated, bounded input and trusted workspace context.
- Given conditions fail, then actions do not execute and the run is marked `skipped` with a safe explanation.
- Given an unknown or unauthorized action, then no side effect occurs and a typed failure is recorded.

**Tasks and task test cases**

**AE-T-031.1 — Implement action handler interface and executor**
- Subtasks: define typed input/output; add handler registry; map errors to transient/permanent/ambiguous classes; add per-action timeout.
- Test cases: `TC-0311` registered handler executes once; `TC-0312` unknown handler causes no side effect; `TC-0313` malformed input rejected before handler; `TC-0314` handler timeout is represented accurately; `TC-0315` handler cannot widen workspace scope.
- **Done when:** executor is the only path to actions, input schema and permission checks precede invocation, and handler contract tests pass.

**AE-T-031.2 — Deliver the first low-risk internal action**
- Subtasks: choose approved action (e.g. send internal notification); define recipient resolution; implement safe output; test authorization and failure behavior.
- Test cases: `TC-0316` valid recipient receives one logical notification; `TC-0317` cross-workspace recipient is rejected; `TC-0318` deleted/disabled recipient follows documented policy; `TC-0319` notification provider transient failure is classified for retry.
- **Done when:** one complete action works end-to-end and has tests, documentation, audit outcome, and action-specific metrics.

### AE-F03.3 — Retry, timeout and dead-letter handling

#### AE-US-032 — Recover from transient failures without endless execution

**Story:** As an operator, I want bounded retries and dead-letter visibility so that temporary failures recover while permanent failures do not create infinite load.

**Requirements:** FR-012, FR-013, BR-007, BR-008.

**Acceptance criteria**
- Given a transient failure, when retry policy permits, then the attempt is scheduled with bounded backoff/jitter and attempt count increments.
- Given a permanent failure, then the action is not endlessly retried.
- Given retry budget is exhausted, then the run is made inspectable and alertable with a safe failure summary.
- Given an ambiguous external result, then the action is not blindly repeated unless a verified idempotency strategy applies.

**Tasks and task test cases**

**AE-T-032.1 — Implement failure classification and retry scheduler**
- Subtasks: error taxonomy; backoff with jitter; maximum attempts/age; Retry-After support; clock-injected unit tests.
- Test cases: `TC-0321` transient error retries; `TC-0322` permanent error does not retry; `TC-0323` retry delay obeys configured cap; `TC-0324` attempt/age budget ends retries; `TC-0325` provider Retry-After is respected within policy.
- **Done when:** retry decisions are deterministic under test, bounded, observable, and documented for each initial action type.

**AE-T-032.2 — Implement dead-letter state and safe inspection/recovery**
- Subtasks: persist terminal reason and attempts; expose authorized listing/detail; implement audited retry/replay policy; add DLQ alerts.
- Test cases: `TC-0326` exhausted work reaches terminal/DLQ state; `TC-0327` unauthorized user cannot inspect/retry; `TC-0328` authorized retry generates audit; `TC-0329` unsafe non-idempotent replay is blocked or routed to reconciliation.
- **Done when:** DLQ items are inspectable, access-controlled, audited, and covered by tests/runbook.

---

## AE-E04 — Security, governance and observability

**Outcome:** the engine is tenant-safe, bounded, auditable and diagnosable.

### AE-F04.1 — Execution-time authorization and tenant isolation

#### AE-US-040 — Re-check permissions at execution time

**Story:** As a workspace administrator, I want actions to respect current authorization so that revoking a user's permission prevents future unauthorized effects.

**Requirements:** FR-013, BR-004, BR-005, BR-006.

**Acceptance criteria**
- Given a rule was valid when created but its owner's permission has since been revoked, when execution requires that authority, then the defined authorization policy is re-evaluated and the unauthorized action is denied.
- Given an event, target, run or action has mismatched workspace scope, then no mutation occurs.
- Given scope is missing, no unscoped query or implicit global fallback is performed.

**Tasks and task test cases**

**AE-T-040.1 — Integrate existing principal/policy/scoped-gateway contracts**
- Subtasks: map caller principal to trusted context; pass workspace scope through run/action; ensure repository abstraction requires scope; add architecture rule/test.
- Test cases: `TC-0401` no scope prevents data access; `TC-0402` workspace A cannot mutate workspace B task; `TC-0403` revoked permission blocks action; `TC-0404` guest/API-key roles follow explicit policy; `TC-0405` direct collection access outside approved gateway is blocked by review/test policy.
- **Done when:** reuse of existing contracts is verified against repository evidence and adversarial cross-workspace tests pass.

### AE-F04.2 — Loop protection, budgets and quotas

#### AE-US-041 — Stop runaway automation chains

**Story:** As a platform operator, I want loops and fan-out bounded so that one misconfigured rule cannot exhaust resources or spam users.

**Requirements:** FR-019, FR-020, BR-010.

**Acceptance criteria**
- Given an event chain exceeds hop/run/action/fan-out budget, then additional work is rejected or stopped under documented rules.
- Given a known self-triggering configuration is detected, validation returns a clear warning/error according to policy.
- Given one workspace exhausts its quota, other workspaces retain their configured fair share.

**Tasks and task test cases**

**AE-T-041.1 — Add causation lineage and loop circuit breaker**
- Subtasks: propagate event/run/causation context; count chain depth; set hard cap; expose circuit-breaker metric.
- Test cases: `TC-0411` simple self-loop is detected or stopped; `TC-0412` legitimate bounded chain succeeds; `TC-0413` hop limit terminates further runs; `TC-0414` breaker records an actionable reason.
- **Done when:** loop tests prove both prevention and legitimate-chain behavior and the operator receives a signal.

**AE-T-041.2 — Add per-workspace action/event quotas**
- Subtasks: define usage windows; enforce global/workspace/integration limits; add deterministic rate-limit behavior; document admin override controls.
- Test cases: `TC-0415` quota within limit succeeds; `TC-0416` excess returns controlled rejection/backpressure; `TC-0417` one workspace cannot consume all worker capacity; `TC-0418` counters behave correctly under concurrent updates.
- **Done when:** quota enforcement is concurrency-safe, visible to operators, and tested under parallel load.

### AE-F04.3 — Audit and observability

#### AE-US-042 — Trace a run from event through each action

**Story:** As a support operator, I want correlated run history and diagnostic signals so that I can identify and resolve failures without database access.

**Requirements:** FR-011, FR-015, FR-024, NFR-006, NFR-014.

**Acceptance criteria**
- Given an event creates a run, then event/run/action logs and traces share correlation identifiers.
- Given an action fails, then safe failure code, timing, attempt count and next retry decision are visible.
- Given a secret or sensitive payload is present in an exception/provider response, then it is redacted from logs and telemetry.

**Tasks and task test cases**

**AE-T-042.1 — Add structured logs, metrics and trace propagation**
- Subtasks: standard fields; trace context across queue; latency/queue age/retry metrics; cardinality review.
- Test cases: `TC-0421` end-to-end correlation is preserved; `TC-0422` required metrics increment on success/failure; `TC-0423` metrics avoid unbounded user/run labels; `TC-0424` secrets are redacted in exception path.
- **Done when:** sample traces/logs/metrics are documented and validated in the target observability stack or tested telemetry sink.

**AE-T-042.2 — Implement protected append-oriented audit records**
- Subtasks: define audit schema; record actor/target/outcome; redact values; protect ordinary app paths from editing existing audit items.
- Test cases: `TC-0425` automation lifecycle writes expected audit record; `TC-0426` denied action records outcome without leaking secrets; `TC-0427` application API cannot mutate a prior audit record under the intended access policy.
- **Done when:** audit semantics, access control and retention are reviewed and automated tests pass.

---

## AE-E05 — Management API, authoring and run history

**Outcome:** authorized users can author, preview, operate and diagnose automations without direct database access.

### AE-F05.1 — Lifecycle management API

#### AE-US-050 — Enable, pause, resume, disable and archive an automation

**Story:** As a workspace administrator, I want explicit lifecycle controls so that I can safely govern which rules run.

**Requirements:** FR-006, FR-014, BR-009, BR-012.

**Acceptance criteria**
- Given a valid version and sufficient permission, when enabled, then it becomes eligible for future trigger matching.
- Given paused/disabled/archived, no new eligible run is scheduled according to the documented semantics.
- Given an existing run is in-flight at pause/disable, behavior matches a documented policy and is visible to the user.

**Tasks and task test cases**

**AE-T-050.1 — Implement lifecycle API and policy checks**
- Subtasks: transition endpoint/service; concurrency checks; audit; state/error response schemas; update OpenAPI.
- Test cases: `TC-0501` allowed transition works; `TC-0502` illegal transition returns stable error; `TC-0503` insufficient permission rejected; `TC-0504` concurrent stale edit rejected; `TC-0505` repeated enable request is idempotent or returns documented conflict.
- **Done when:** lifecycle API matches the state machine, has contract tests and documents in-flight behavior.
- **Status (2026-10-18): Done for lifecycle API/service scope.** Added
  `POST /api/v1/workspaces/{workspaceId}/automations/{automationId}/{enable|pause|resume|disable|archive}`
  with required `If-Match` revision, a status+revision compare-and-set in the repository
  (`transitionStatus`), non-enumerating 404 on denial, and one audit event per
  success/denial. TC-0501–TC-0505 pass; typecheck and lint clean; OpenAPI lint clean.
  Not included: cancelling queued/in-flight runs on pause/disable (spec D-20, belongs to
  the run worker/repository), a real platform auth adapter (AE-T-010.2b release gate),
  and transactional audit durability (AE-T-042.2).

### AE-F05.2 — Dry-run and user-facing rule explanation

#### AE-US-051 — Preview conditions and action plan safely

**Story:** As an automation author, I want to preview which conditions pass and what actions would run so that I can catch mistakes before enabling a rule.

**Requirements:** FR-017, FR-024.

**Acceptance criteria**
- Given a representative sample/context, dry-run returns trigger/condition outcomes and planned actions.
- Given a dry-run request, no production state is changed and no external side effect is sent.
- Given referenced data is missing or inaccessible, the preview explains the limitation without leaking cross-workspace data.

**Tasks and task test cases**

**AE-T-051.1 — Implement dry-run evaluator and preview response**
- Subtasks: separate planning from execution; record condition explanations; redact values; add no-mutation instrumentation/test.
- Test cases: `TC-0511` positive and negative conditions explain result; `TC-0512` dry-run invokes no action handler; `TC-0513` inaccessible reference is handled safely; `TC-0514` preview enforces the same parser/resource bounds as real execution.
- **Done when:** dry-run has a distinct no-side-effect code path and negative side-effect tests pass.
- **Status (2026-10-18): Done for dry-run evaluator/preview scope.** Added
  `POST /api/v1/workspaces/{workspaceId}/automations/{automationId}/dry-run`, backed by the pure
  `buildDryRunPreview` (no repository, handler, executor, or audit dependency). It reuses the real
  `createConditionEvaluator`, JSON bounds, and rule validation, redacts values, and reports
  `limitations` for missing sample fields and unpreviewed runtime concerns. TC-0511–TC-0514 pass;
  typecheck, lint, and OpenAPI lint clean.
  Not included: execution-time authorization and recipient resolution preview, quota/fan-out
  estimates (spec §8.4), preview against a published version, and a real platform auth adapter
  (AE-T-010.2b release gate).
### AE-F05.3 — Run/action history and safe recovery UI/API

#### AE-US-052 — Inspect run history and retry safely

**Story:** As an authorized author/operator, I want paginated run/action history and safe recovery controls so that I can diagnose failed automation.

**Requirements:** FR-015, FR-016, FR-022, FR-024.

**Acceptance criteria**
- Given a run belongs to the current workspace, an authorized user can view its status, pinned version, timestamps, attempts and safe failure details.
- Given a run belongs to another workspace, it is not discoverable through detail, list, or retry endpoints.
- Given manual retry/replay is unsafe under the action's idempotency/reconciliation policy, the request is blocked or requires an approved recovery route.

**Tasks and task test cases**

**AE-T-052.1 — Implement scoped history APIs and pagination**
- Subtasks: run list/detail; action detail; query indexes; redact fields; stable cursor ordering.
- Test cases: `TC-0521` same-workspace history visible; `TC-0522` cross-workspace history hidden; `TC-0523` pagination stable under new runs; `TC-0524` secret/input payloads are redacted.
- **Done when:** API contract, indexes, permission filtering and pagination tests pass.
- **Status (2026-10-18): Done for scoped run-history API/repository scope.** Added
  `GET /api/v1/workspaces/{workspaceId}/automations/{automationId}/runs` and
  `GET /api/v1/workspaces/{workspaceId}/automation-runs/{runId}` backed by a read-only
  `RunHistoryRepository` (Mongo + in-memory), the `run_history_by_automation` index, and an
  allowlist view that excludes lease/fencing/trace/input fields and scrubs free text.
  Ordering is `createdAt desc, runId desc` with a stable `(createdAt, runId)` cursor.
  TC-0521–TC-0524 pass; typecheck, lint, and OpenAPI lint clean.
  Not included: retry/replay (AE-T-052.2), a separate per-action endpoint (actions are inline in
  run detail), and a real platform auth adapter (AE-T-010.2b release gate).

**AE-T-052.2 — Implement controlled retry/replay endpoint**
- Subtasks: distinguish retry from replay; verify authorization and state; evaluate idempotency safety; write audit; require idempotency key where needed.
- Test cases: `TC-0525` safe retry creates/continues one logical operation; `TC-0526` unauthorized retry denied; `TC-0527` replay of non-idempotent ambiguous action is refused/reconciled; `TC-0528` duplicate client request does not initiate duplicate recovery.
- **Done when:** retry/replay rules are explicit, audited, permission-tested and included in a recovery runbook.
- **Status (2026-10-18): Done for recovery API/service scope.** Added
  `POST .../automation-runs/{runId}/retry` (same run, `If-Match`, delegates to the audited
  dead-letter policy) and `POST .../automation-runs/{runId}/replay` (new run linked by `replayOf`,
  deterministic id, same permission/reason/policy). Both require `Idempotency-Key` backed by an
  atomic reserve/complete/release store (in-memory + Mongo, scoped to workspace and principal) so
  duplicate requests never start a second recovery. Ambiguous (`unknown_outcome`) actions are
  refused; every attempt is audited. TC-0525–TC-0528 pass; typecheck, lint, and OpenAPI lint clean.
  Not included: execution of replay runs by the worker (needs verification, see below), durable
  idempotency-key retention policy, and a real platform auth adapter (AE-T-010.2b release gate).

### AE-F05.4 — Rule builder UI

#### AE-US-053 — Create and edit rules from the builder

**Story:** As a workspace automation author, I want a schema-driven UI so that I can configure supported triggers, conditions and actions without writing code.

**Requirements:** FR-001, FR-004, FR-005, FR-017, NFR-012.

**Acceptance criteria**
- Given the API advertises supported registry definitions, then the UI only offers supported triggers/operators/actions and displays server validation errors.
- Given an invalid rule, the UI identifies the field and does not imply successful enablement.
- Given keyboard-only use and supported screen readers, primary authoring and run inspection workflows are operable to the agreed accessibility baseline.

**Tasks and task test cases**

**AE-T-053.1 — Implement schema-driven trigger/condition/action editor**
- Subtasks: define UI form schema mapping; create nested condition group UI with limits; add ordered actions; handle draft save/conflict.
- Test cases: `TC-0531` supported action fields render by schema; `TC-0532` malformed config shows field error; `TC-0533` nesting/action limits are enforced; `TC-0534` concurrent draft edit reports conflict without silent data loss.
- **Done when:** authoring flow can save a draft and server validation errors map to the correct controls.
- **Status (2026-10-19): Done.** Schema-driven RuleBuilder UI feature implemented in `apps/web/features/rule-builder` with dedicated Next.js route `/automations/builder`. Supported triggers (`task.status_changed`) and actions (`notification.send` v1) render schema-mapped controls; nested condition group editor enforces `conditionDepth <= 5`, `groups <= 10`, `nodes <= 50`; ordered action list editor enforces `actionsPerRule <= 10` with sequential reordering; draft saving maps server validation issues (`RuleValidationIssue`) directly to field controls with `aria-invalid` and accessible error descriptions; concurrent draft edits (409 revision conflict) display conflict notice without silent data loss, preserving all user edits. All four test cases (`TC-0531`, `TC-0532`, `TC-0533`, `TC-0534`) pass in `apps/web/tests/integration/rule-builder.test.tsx`.

- **Follow-up (2026-10-20):** The authoring route now supplies an explicit workspace ID and tab-scoped platform bearer token to the API request. Workspace IDs are no longer hardcoded in the automation, run, schedule, or operations screens; the server must still verify membership and permissions. Draft API failures no longer fall back to browser storage and report a false server-save success. Focused request tests verify the bearer header, encoded workspace path, idempotency key, and fail-closed behavior. These changes do not provide the absent platform auth adapter or establish live API integration.


**AE-T-053.2 — Accessibility and E2E workflow tests**
- Subtasks: keyboard navigation; label/focus/error semantics; E2E create/validate/enable/history flow.
- Test cases: `TC-0535` keyboard reaches and activates all core controls; `TC-0536` errors associate with fields; `TC-0537` end-to-end rule results in one visible run.
- **Done when:** automated E2E and agreed accessibility checks pass for the core workflow.
- **Status (2026-10-19): Done.** Accessibility verification implemented in `apps/web/tests/integration/rule-builder-a11y.test.tsx`. `TC-0535` proves all interactive controls (buttons, inputs, selects, form landmarks) are keyboard-reachable without unintended `tabindex="-1"`, buttons carry accessible labels (`aria-label`), and form supports Enter-key submission via `type="submit"`. `TC-0536` proves field-level validation errors associate with controls via `aria-describedby`, accessible error paragraphs carry `role="alert"`, and `aria-invalid` semantics correctly reflect valid/invalid states. `TC-0537` (full live-stack end-to-end create/enable/run cycle) is reported as SKIPPED with documented requirements (requires `AUTOMATION_API_ENABLED=true`, mounted backend automation routes, and active run worker) and tracked as an E2E release gate in AE-E07. All automated accessibility and unit/integration checks pass cleanly.

- **Verification update (2026-10-20):** Latest local web run: 15 tests, 14 passed, 1 skipped, 0 failed. `TC-0537` remains skipped because the authenticated API/runtime/worker stack is not configured; therefore AE-T-053.2 is not complete despite the historical status above.

---

## AE-E06 — Scheduled triggers, fairness and scale

**Outcome:** scheduled rules run predictably across time zones and the engine remains fair under uneven demand.

### AE-F06.1 — Durable schedule occurrence generation

#### AE-US-060 — Run a scheduled automation at the configured local time

**Story:** As a workspace author, I want schedules with an explicit time zone so that reminders run at the intended local time.

**Requirements:** FR-018, NFR-003, BR-011.

**Acceptance criteria**
- Given a valid schedule and IANA time zone, then each intended occurrence receives a stable identity and UTC execution instant.
- Given a DST gap or repeated local time, then the documented policy determines skip/shift/first-or-second occurrence behavior.
- Given scheduler restarts or repeated polling, duplicate ticks do not create duplicate logical occurrences.

**Tasks and task test cases**

**AE-T-060.1 — Implement schedule occurrence model and scheduler claim**
- Subtasks: store timezone/next occurrence; create unique occurrence ID/key; atomically advance cursor; instrument lateness.
- Test cases: `TC-0601` normal schedule produces expected occurrence; `TC-0602` duplicate scheduler tick is deduplicated; `TC-0603` process restart resumes from durable cursor; `TC-0604` disabled schedule creates no future new occurrence.
- **Done when:** schedule occurrence creation is durable, idempotent and has clock-controlled tests.
- **Status (date): Implemented; verification pending.** `schedule.occurrence.ts` (pure next-occurrence + deterministic
  occurrence key), `schedule.repository.ts` (Mongo + in-memory, unique occurrence index, CAS cursor advance) and
  `schedule.scheduler.ts` (tick/claim, lateness) cover TC-0601–TC-0604 with a controlled clock. DST/missed-run policy
  stays in AE-T-060.2. Mark Done only after typecheck, lint and the Mongo test pass locally.

**AE-T-060.2 — Define/test DST and missed-run semantics**
- Subtasks: choose DST-gap/fold policy; choose catch-up/coalesce/skip for missed runs; document IANA time zone handling; test boundaries.
- Test cases: `TC-0605` spring-forward gap follows policy; `TC-0606` fall-back fold follows policy; `TC-0607` long outage applies missed-run policy; `TC-0608` all persisted timestamps remain unambiguous UTC instants.
- **Done when:** DST/missed-run behavior is approved by product and all boundary tests pass.

### AE-F06.2 — Fair scheduling and capacity controls

#### AE-US-061 — Prevent a noisy workspace starving others

**Story:** As a platform operator, I want per-workspace fairness and bounded queue consumption so that demand from one tenant does not monopolize the engine.

**Requirements:** NFR-005, NFR-010, FR-020.

**Acceptance criteria**
- Given one workspace generates a high-volume burst, other eligible workspaces continue to make progress within the agreed fairness envelope.
- Given providers slow down, the system applies backpressure instead of continuously multiplying retries.
- Given queue depth grows, operators can determine backlog age and contributing dimensions without high-cardinality metrics.

**Tasks and task test cases**

**AE-T-061.1 — Load-test and tune concurrency/fairness controls**
- Subtasks: define benchmark workload; test burst and steady-state traffic; tune worker concurrency/prefetch; document measured limits.
- Test cases: `TC-0611` burst queue drains within measured target; `TC-0612` one tenant cannot starve all others; `TC-0613` provider 429 responses cause bounded throughput/backoff; `TC-0614` worker scale-in does not lose acknowledged work.
- **Done when:** reproducible benchmark report records hardware/config, workload, results, bottlenecks and accepted limits.

---

## AE-E07 — Production readiness, CI/CD and operations

**Outcome:** the service can be released, monitored, recovered and maintained by an assigned team.

### AE-F07.1 — CI quality gates and environment configuration

#### AE-US-070 — Validate automation changes automatically in CI

**Story:** As an engineering team, we want consistent automated checks so that risky changes are caught before merge/release.

**Requirements:** NFR-007, NFR-009, NFR-014.

**Acceptance criteria**
- Given a pull request changes automation contracts/logic, required lint/type/test/security/contract jobs execute.
- Given a required check fails, the change cannot pass the configured merge gate unless a documented exception is approved.
- Given an environment variable is missing or invalid, startup/config validation fails clearly and never prints secrets.

**Tasks and task test cases**

**AE-T-070.1 — Add automation CI suites and architecture guards**
- Subtasks: unit/integration/contract jobs; cross-tenant suite; migration tests; dependency/secret scans; protect required status checks.
- Test cases: `TC-0701` bad schema/type fails CI; `TC-0702` cross-tenant test is mandatory; `TC-0703` secret scanner catches fixture pattern without leaking it; `TC-0704` skipped required security job is not treated as green.
- **Done when:** merge pipeline proves all required checks run and failures block merge under repository policy.
- **Status (2026-10-19): Done for repository CI policy.** The control-plane workflow has explicit architecture, quality (lint/typecheck), full test/automation-suite, security scan, build, and commit-message jobs. The required `validate` status checks every dependency with `always()` and fails unless each reports `success`, so a skipped security job is not green. The versioned main ruleset requires `validate`; repository governance checks enforce the workflow contract. Applying the versioned ruleset to GitHub remains a repository-administrator operation.

**AE-T-070.2 — Validate runtime configuration per environment**
- Subtasks: document env variables; safe startup validation; separate secrets per environment; update `.env.example` with placeholders only.
- Test cases: `TC-0705` missing required config fails with safe error; `TC-0706` invalid timeout/limit rejected; `TC-0707` secret values do not appear in logs/build output.
- **Done when:** local/staging/production configuration contract and startup failure behavior are documented and tested.
- **Status (2026-10-19): Done for repository configuration contract.** API and web environment schemas validate required values before startup; production requires `MONGODB_URI`; safe validation errors name only invalid keys/rules; placeholder-only examples and the local/staging/production secret-separation contract are documented in `docs/operations/environment-configuration.md`. TC-0705–TC-0707 are covered by API environment tests. Provisioning actual staging/production secret stores remains an environment-owner responsibility and is intentionally outside repository source control.

### AE-F07.2 — Deployment, rollback and operational readiness

#### AE-US-071 — Release with a safe rollback and kill switch

**Story:** As an operator, I want staged rollout, pause controls and recovery procedures so that incidents can be contained without losing execution history.

**Requirements:** NFR-008, NFR-014, FR-023.

**Acceptance criteria**
- Given an adverse rollout, operators can stop new automation intake/execution according to a documented kill-switch policy.
- Given a rollback, already-completed external side effects are not falsely represented as undone.
- Given a recovery drill, measured recovery outcomes are compared to agreed RPO/RTO targets.

**Tasks and task test cases**

**AE-T-071.1 — Implement release gates, feature flags and kill switch**
- Subtasks: stage/shadow/canary rollout; gate scheduled triggers if not ready; define pause intake vs drain semantics; verify flag access/audit.
- Test cases: `TC-0711` kill switch stops new claims/intake as defined; `TC-0712` already-running action follows documented policy; `TC-0713` rollback preserves run/action evidence; `TC-0714` flag change is permission-checked and audited.
- **Done when:** a controlled exercise shows operators can halt unsafe work and safely resume only after review.

**AE-T-000.3b (P0 Release Gate) — Convert production target to replica set and verify transactions**
- **Parent story / Epic:** AE-US-071 / AE-E07 (transferred from AE-E00 scope split).
- **Owner:** Abid Ullah | **ETA:** TBD (blank)
- **Gate description:** Blocks production enablement of outbox/ingest feature flag (ADR-0003 gate). Done only when target deployment is converted to a replica set/sharded cluster, `scripts/verify-mongo-transactions.mjs` passes all checks against that actual target, and evidence is recorded.
- **Status:** Pending / Open release gate.

**AE-T-010.2b (P0 Release Gate) — Implement and verify real platform PrincipalResolver/PolicyPort adapter**
- **Parent story / Epic:** AE-US-071 / AE-E07 (transferred from AE-E01 scope split).
- **Owner:** Abid Ullah | **ETA:** TBD (blank)
- **Gate description:** Blocks production enablement of the automation API feature flag (`automationApiEnabled`). Done only when the conformance suite and tenant matrix pass against the REAL platform authentication and policy service. Platform auth location currently: `NONE` (specified in [platform-auth-contract.md](docs/architecture/platform-auth-contract.md)).
- **Status:** Pending / Open release gate.

**AE-T-071.2 — Create dashboards, alerts and operational runbooks**
- Subtasks: queue/outbox/DLQ dashboards; provider failure alerts; loop/budget alert; incident procedures and support access.
- Test cases: `TC-0715` test alert fires from a known simulated fault; `TC-0716` runbook steps locate and safely resolve a DLQ item; `TC-0717` support can inspect run history without direct database access.
- **Done when:** every critical metric has a dashboard/alert or explicit rationale, and runbooks are reviewed by the operational owner.

**AE-T-071.3 — Prove backup, restore and data recovery**
- Subtasks: backup policy; restore in isolated environment; reconcile queue/run/outbox state; document RPO/RTO evidence.
- Test cases: `TC-0718` restored database passes integrity checks; `TC-0719` duplicate replay after restoration does not repeat safe idempotent effects; `TC-0720` unreconciled external outcome is flagged for review.
- **Done when:** a dated restore-drill report records actual durations, data loss window, issues and remediation owners.

### AE-F07.3 — Security/privacy and operational readiness sign-off

#### AE-US-072 — Complete operational readiness review

**Story:** As the release owner, I want a documented readiness decision so that production release depends on evidence rather than optimism.

**Requirements:** all P0 FR/NFR items, security checklist and operational checklist.

**Acceptance criteria**
- Given any P0 security, tenant isolation, backup, monitoring or recovery gate fails, then general availability is blocked unless an authorized risk owner records an explicit exception.
- Given a risk is accepted temporarily, the record includes owner, impact, expiry/review date, mitigation and rollback trigger.

**Tasks and task test cases**

**AE-T-072.1 — Run threat-model review and security validation**
- Subtasks: review trust boundaries; execute tenant isolation tests; verify secret redaction; check dependency/security findings; record exceptions.
- Test cases: `TC-0721` cross-tenant attack matrix passes; `TC-0722` sensitive data redaction passes; `TC-0723` permission bypass and replay abuse tests pass; `TC-0724` high-risk findings have disposition and owners.
- **Done when:** reviewer-approved security report exists and no unaccepted critical/high-risk issue remains under the team's policy.

**AE-T-072.2 — Complete release readiness evidence**
- Subtasks: verify SLO dashboard; inspect CI evidence; validate runbooks/ownership; confirm rollback/restore drills; sign release decision.
- Test cases: `TC-0725` every P0 requirement maps to passing evidence or approved exception; `TC-0726` operational owner can execute the incident checklist without undocumented knowledge.
- **Done when:** signed ORR links tests, dashboards, runbooks, migration plan, risk register and release/rollback decision.

---

# 29. Story-level Definition of Done vs task “Done when”

These are not interchangeable.

## 29.1 Task “Done when”

A task's “Done when” is its local completion contract. It answers: **what observable evidence proves this specific work item is complete?**

Example: “Done when the scoped repository requires a trusted workspace context, index migration is applied, and `TC-0101` through `TC-0104` pass against the supported database setup.”

## 29.2 Story Definition of Done

A story can move to `Done` only when all applicable items are true:

- [ ] All acceptance criteria pass in a reproducible test environment.
- [ ] All child tasks/subtasks are complete or formally removed with story scope revised.
- [ ] Unit and integration tests pass; contract/E2E/security/performance tests pass where relevant.
- [ ] Authorization, cross-workspace access, failure modes and resource bounds are verified.
- [ ] Logs/metrics/traces and audit behavior exist for production-impacting paths.
- [ ] API/event/schema docs and OpenAPI/contract artefacts are updated.
- [ ] Database changes are reviewed, migration-tested and have a recovery/rollback plan.
- [ ] Code has peer review and CI required checks are green.
- [ ] User-facing error behavior and accessibility are checked for UI work.
- [ ] No unresolved blocker; accepted risks are recorded with owner and expiry/review date.
- [ ] The work is deployable behind a feature flag or compatible release strategy where needed.
- [ ] Evidence links are attached to the Story.

## 29.3 Epic Definition of Done

An Epic is done when:
- [ ] All included P0/P1 Stories that define the agreed outcome are done.
- [ ] Epic success measures are met using observed evidence, not assumptions.
- [ ] Cross-feature integration and end-to-end tests pass.
- [ ] Security, privacy, operational, documentation and migration work is complete for the capability.
- [ ] Dependencies and deferred scope are recorded.
- [ ] Product owner and technical owner accept the outcome.

## 29.4 Release Definition of Done

A release is production-ready only after the production-readiness gates in AE-E07 are evidenced. A green unit-test run by itself is insufficient.

---

# 30. Test case specification and traceability

## 30.1 Test case template

```markdown
## TC-#### — concise test title
**Covers:** FR-### / NFR-### / BR-### / AE-US-### / AE-T-###.#
**Test level:** Unit / Component / Integration / Contract / E2E / Security / Load / Resilience
**Priority:** P0 / P1 / P2
**Preconditions:** persisted state, principal/role, workspace, feature flags, provider setup
**Test data:** IDs and conditions needed; no production secrets
**Steps:** numbered actions or event injection
**Expected result:** explicit status/data/side-effect assertions
**Observability assertion:** expected audit/log/metric/trace if applicable
**Cleanup:** how test data and provider fakes are reset
```

## 30.2 Minimum cross-cutting risk matrix

| Risk area | Minimum tests | Release importance |
|---|---|---|
| Tenant isolation | Missing scope, forged workspace ID, cross-workspace event/resource/run/replay | P0 blocking |
| Duplicate delivery | Duplicate event, concurrent event ingestion, queue redelivery | P0 blocking |
| Worker concurrency | Concurrent claim, expired lease, stale worker completes late | P0 blocking |
| Version pinning | Edit while run queued/running; immutable published version | P0 blocking |
| Authorization | Revoked access, guest/API-key principal, unauthorized admin action | P0 blocking |
| Side-effect safety | timeout after provider success, provider idempotency, unsafe replay | P0 for external effects |
| Resource abuse | deep rules, very large payload/list, trigger storm, loop/fan-out | P0 blocking |
| Data protection | secret/PII in logs/errors/history/audit | P0 blocking |
| Recovery | database/queue/provider outage, restart, restore, migration rollback | P0 before GA |
| UI behavior | validation mapping, draft conflict, keyboard accessibility | P1 before UI GA |
| Schedule correctness | DST gap/fold, missed occurrences, duplicate ticks | P1 before schedules GA |

## 30.3 Requirements traceability matrix template

Maintain a checked-in `docs/testing/requirements-traceability.csv` (or equivalent) with one row per requirement:

| Requirement ID | Requirement summary | Epic | Story | Test IDs | Implementation reference | Status | Evidence link |
|---|---|---|---|---|---|---|---|
| FR-008 | Duplicate delivery creates one logical run | AE-E02 | AE-US-021 | TC-0211, TC-0212 | path/PR/commit | Planned | CI report |

Rules:
- Every P0 functional and security requirement maps to a test.
- Every high-risk failure mode maps to an automated or documented resilience test.
- A missing implementation reference or failing test must not be shown as complete.
- Tests that cannot be automated need a named reviewer, evidence file and re-run trigger.

---

# 31. Prioritization, dependencies, estimation and change control

## 31.1 Priority definitions

- **P0 — release blocker:** required to protect data, achieve the first vertical slice, or meet a minimum reliability invariant.
- **P1 — launch capability:** required before a capability is generally available, but may be excluded from a limited internal prototype with explicit approval.
- **P2 — enhancement:** improves convenience or efficiency but is not required for the agreed release outcome.

Do not use priority labels to hide unresolved security issues. Cross-tenant access, unsafe arbitrary code execution, non-durable accepted work, and unbounded execution are release blockers for a production service.

## 31.2 Dependency policy

- Stories in AE-E01 depend on the relevant repository conventions and AE-E00 audit outcomes.
- AE-E02 depends on event contracts and the chosen event-delivery ADR.
- AE-E03 depends on run schema, trigger matching, and the queue/claim decision.
- UI run history depends on stable run/error contracts.
- Scheduling depends on durable occurrence identity and deduplication.
- Production release depends on security, resilience, runbooks and recovery evidence, not just feature completion.

Record dependency edges in the work tracker. Do not put “depends on backend” without naming the exact story/contract and expected hand-off.

## 31.3 Estimation policy

- The team estimates stories/tasks after refinement and repository inspection.
- Separate implementation effort from waiting time, risk, and cross-team dependency.
- Use a spike with a timebox to resolve unknowns; do not estimate an unbounded investigation as a normal delivery task.
- For high-risk tasks, add contingency based on evidence from prototypes/load tests, not arbitrary optimism.
- Re-estimate when scope, data model, queue choice or failure policy materially changes.

## 31.4 Change control

Any change to event envelope, action contracts, condition semantics, run state machine, authorization boundary, retry/replay semantics, retention, or public API should include:
- reason and compatibility impact;
- ADR or ADR update if architectural;
- migration/version plan;
- affected requirements/stories/tests;
- rollback or forward-fix plan;
- security/privacy impact assessment;
- release notes and operational changes.

---

# 32. Risks, open questions and product decisions

Maintain `docs/architecture/risk-register.md` with probability, impact, owner, mitigation, trigger, status and review date. Seed it with:

| Risk / open question | Why it matters | Required resolution |
|---|---|---|
| Current queue/event infrastructure unknown | Wrong queue choice can force costly redesign | Repository audit + queue ADR |
| MongoDB transaction support/configuration unknown | Outbox atomicity depends on deployment semantics | Verify topology and run integration test |
| Exact authorization authority for long-running runs | Acting user may lose access after a delay | Agree actor/service-principal policy with security/product |
| Disable semantics for in-flight runs | Abrupt cancellation may leave partial side effects | Product decision and state-machine tests |
| Scheduled missed-run policy | Catch-up may create a large burst | Product decision: skip/coalesce/catch-up with limits |
| External API ambiguous outcome | Blind retry can duplicate non-idempotent effects | Idempotency/reconciliation per action provider |
| Automation loop detection across multiple rules | Multi-rule cycles may evade simple self-loop detection | Hop/budget guard plus loop telemetry |
| Run-history retention and privacy deletion | Durable debugging data may contain personal data | Privacy/legal/product retention decision |
| Target volume and acceptable latency unknown | Cannot select capacity or make truthful SLO claims | Usage forecast and load benchmark |
| Action catalogue not finalized | Each action has different effects, permissions and retry semantics | Approve smallest valuable first-release set |
| Support/incident owner unknown | Alerts are ineffective without accountable responders | Name operational owner/on-call path |

**v2.0 proposed defaults for these items (spec §3):** actor policy → D-11/D-12 · disable semantics → D-20 · edits vs in-flight → D-21 · missed schedules → D-22 · DST → D-23/D-24 · stale state → D-25 · retention → D-27 · loops → D-13 and spec §11.7 · queue/outbox/claim → D-01…D-08. They are *defaults to confirm via ADR*, not decisions made by the document.

A question is not resolved merely because a default appears in this document. Each open question must be confirmed against the existing project and stakeholder requirements.

---

# 33. Documentation completeness checklist

Use this checklist during architecture review. Mark each item `Complete`, `Planned`, `Not needed (reason)`, or `Blocked` and link evidence.

## Product and requirements
- [ ] Problem statement, goals, non-goals and measurable success metrics
- [ ] Personas, use cases, scope and first-release boundaries
- [ ] Functional requirements, NFRs, business rules and constraints
- [ ] Glossary and domain vocabulary
- [ ] Stories, acceptance criteria, priorities and dependencies
- [ ] Product decisions for pause/disable, retries, schedules, and action failure behavior

## Architecture and design
- [ ] System context, container, component and sequence diagrams
- [ ] Bounded contexts, module ownership and dependency rules
- [ ] Domain model, state machines and invariants
- [ ] Queue/event delivery semantics and outbox/inbox design
- [ ] API/event/action contracts and schema versioning
- [ ] Data model, indexes, consistency and migration plan
- [ ] ADRs with alternatives and consequences
- [ ] Capacity model and measured performance baseline

## Security and privacy
- [ ] Threat model and trust boundaries
- [ ] Authentication, workspace authorization and execution-time permission policy
- [ ] Secret storage/redaction and data minimization
- [ ] Injection/SSRF protection if HTTP/webhook actions are introduced
- [ ] Audit controls, retention and privacy deletion policy
- [ ] Dependency, secret, SAST/DAST and security-test process

## Quality and verification
- [ ] Test strategy and per-task test cases
- [ ] Requirement-to-test traceability
- [ ] Acceptance, contract, integration and E2E suites
- [ ] Concurrency, duplicate delivery, chaos/resilience and load tests
- [ ] Accessibility checks for authoring UI
- [ ] Definition of Ready, task Done-when, Story/Feature/Epic/Release DoD

## Operations and release
- [ ] Environments/configuration/secrets/runbook
- [ ] CI/CD gates, feature flags and rollout strategy
- [ ] SLO/SLI definitions, dashboards and alert thresholds
- [ ] Incident ownership, escalation and incident playbooks
- [ ] Kill switch, pause/drain/recovery semantics
- [ ] Backup/restore, RPO/RTO evidence and queue reconciliation
- [ ] Migration/rollback/forward-fix plan
- [ ] Operational readiness review sign-off

## User and support documentation
- [ ] Build/enable/pause/disable an automation
- [ ] Interpret run statuses and safe failure reasons
- [ ] Retry/replay safety guide
- [ ] Known limitations and quotas
- [ ] Support troubleshooting guide and escalation route

---

# 34. Definition of Ready (DoR)

A Story is ready to enter implementation only when:
- [ ] Its user/business outcome and scope are understood.
- [ ] Acceptance criteria are observable and testable.
- [ ] It links to requirements, or is clearly marked as an approved technical enabler.
- [ ] Dependencies and interface owners are named.
- [ ] Relevant ADR/schema/API decisions are complete, or the remaining discovery is an explicit timeboxed spike.
- [ ] Security/tenant/data implications have been considered.
- [ ] Tasks, subtasks and relevant task-level test cases are identified.
- [ ] Test data/environment needs are understood.
- [ ] The team has estimated it according to its normal planning method.
- [ ] It is small enough to complete and verify within the team's agreed iteration; if not, split it by vertical outcome.

A story must not be marked Ready merely because its title and description exist.

---

# 35. Final delivery guidance

Start with **AE-E00 repository audit and ADRs**, then deliver a thin vertical slice through AE-E01 → AE-E02 → AE-E03 → AE-E04. Do not implement every listed feature in parallel. Complete this first outcome:

`Task status changed → durable event → deduplicated trigger match → pinned automation version → bounded condition evaluation → one internal notification action → persisted run/action history → correlated audit and observability`

The first slice is accepted only when duplicate delivery, cross-workspace access, stale permission, concurrent claim, transient failure, permanent failure, worker crash, and secret-redaction cases have tested outcomes. After that, add the builder and run history, then schedules and broader integrations according to product priority.

**Status note:** This is the proposed backlog and engineering specification. The actual repository audit, chosen queue/database decisions, accepted SLOs, estimates, completed implementation, and passing test evidence remain to be supplied by the project team. Do not label unverified work as complete.
---


---

# 53. Backlog additions from this review

Add these to the existing work hierarchy only after the repository audit confirms they do not already exist. They belong primarily under **AE-E07 — Production readiness**. External connector SDK and multi-region work remain separate future scope unless explicitly required.

## AE-US-073 — Enforce configurable rule and execution limits

**User Story:** As a platform operator, I want rule complexity and execution limits centrally configured and enforced so that malformed or runaway automation cannot exhaust shared resources.

**Requirements:** FR-003, FR-015; NFR-005, NFR-007, NFR-010.

**Acceptance criteria**
- AC-1: A rule exceeding payload, tree-depth, node-count or action-count limits is rejected with a stable field-specific error.
- AC-2: The worker enforces action timeout, run deadline, attempts, chain hops and concurrency even if a job bypasses the UI.
- AC-3: Limits are centrally configured and surfaced in diagnostics without exposing secrets.
- AC-4: Quota denial/delay increments a metric and returns a documented outcome; accepted events are not silently lost.

**Tasks and subtasks**
- **AE-T-073.1 — Define limit configuration contract**
  - Subtasks: inventory limits; define units/defaults/hard caps; validate config at startup; document overrides.
  - Tests: valid/invalid config; missing config; hard cap cannot be overridden beyond safety policy.
  - Done when: configuration schema, owners, default rationale and stable error handling are documented and tested.
- **AE-T-073.2 — Enforce rule structure limits**
  - Subtasks: body-size guard; JSON depth/node counting; array/string bounds; action-count validation.
  - Tests: exact limit accepted; limit+1 rejected; deeply nested malformed input rejected within bounded time.
  - Done when: API/validator tests prove limits apply before persistence and no unbounded recursion occurs.
- **AE-T-073.3 — Enforce worker execution budgets**
  - Subtasks: action deadline; run deadline; retry/age budget; chain/hop budget; quota metrics.
  - Tests: timeout, retry exhaustion, fan-out overflow, workspace quota and no silent accepted-event loss.
  - Done when: worker tests prove each runtime guard triggers the documented status and telemetry.

**Story tests:** TC-LIMIT-001 (boundary values), TC-LIMIT-002 (over-limit rejection), TC-LIMIT-003 (runaway chain circuit), TC-LIMIT-004 (quota alert/audit).

**Story DoD:** All ACs pass in CI; limits are configurable/documented; relevant security/tenant tests pass; dashboards/alerts are linked.

## AE-US-074 — Define SLI/SLO and queue-health alerts

**User Story:** As the service owner, I want precise indicators and actionable alerts so that event delay, backlog, retries and provider failures are detectable before users report them.

**Requirements:** NFR-001, NFR-002, NFR-006, NFR-008.

**Acceptance criteria**
- AC-1: Each indicator has a formula, source metric, owner, window and documented exclusions.
- AC-2: Dashboards separate enqueue latency, queue wait, action duration and end-to-end completion.
- AC-3: Alerts exist for growing queue age, stalled outbox, retry/DLQ spike, worker lease expiry and provider throttling.
- AC-4: Alert routes to a named owner and has a runbook.

**Tasks/subtasks**
- **AE-T-074.1 — Instrument execution path**: add correlated counters/histograms; test success/failure dimensions; verify bounded metric cardinality. Done when dashboard data is verified in staging.
- **AE-T-074.2 — Define candidate SLOs and error budget**: set targets with owner; review thresholds with load-test results. Done when SLOs are explicitly approved or remain marked provisional.
- **AE-T-074.3 — Build alerts/runbooks**: create actionable rules, test firing/resolution, link runbooks. Done when a controlled staging simulation exercises each critical alert.

**Story tests:** TC-OBS-001 (correlation continuity), TC-OBS-002 (queue age alert), TC-OBS-003 (outbox stall alert), TC-OBS-004 (cardinality/privacy check).

**Story DoD:** Metrics are testable, sensitive data is excluded, alert ownership is assigned and the operating team has reviewed the dashboard/runbooks.

## AE-US-075 — Enforce execution-data retention and privacy policy

**User Story:** As a workspace/data owner, I want run details and event snapshots minimized and retained according to an approved policy so that privacy and storage costs are controlled without breaking recovery.

**Requirements:** NFR-006, NFR-008, NFR-010; applicable privacy/security constraints.

**Acceptance criteria**
- AC-1: Every persisted data class has an owner, purpose, retention rule and deletion behavior.
- AC-2: Active runs, unresolved outcomes, unpublished outbox records and dedupe records inside the supported redelivery/replay window are not prematurely deleted.
- AC-3: Secrets and unnecessary personal data are excluded/redacted from logs, traces and run summaries.
- AC-4: Deletion/retention jobs are restartable, observable and auditable.

**Tasks/subtasks**
- **AE-T-075.1 — Data inventory/classification**: map fields and copies; classify sensitive fields; record region/access/retention. Done when reviewed by engineering/security/product and relevant privacy owner.
- **AE-T-075.2 — Implement safe cleanup jobs**: identify eligible records; batch cleanup; audit counts; protect active/recovery data. Tests cover boundary timestamps and job interruption. Done when cleanup is idempotent and a dry-run reports expected counts.
- **AE-T-075.3 — Test redaction/deletion paths**: test exception, trace, provider-response and export paths. Done when test fixtures prove secrets/sensitive values do not leak and deletion behavior matches approved policy.

**Story tests:** TC-PRIV-001 (active run protected), TC-PRIV-002 (dedupe horizon retained), TC-PRIV-003 (secret redaction), TC-PRIV-004 (cleanup restart).

**Story DoD:** Retention policy approved; cleanup safely demonstrated in staging; legal/compliance assertions are limited to verified scope.

## AE-US-076 — Operate feature flags and emergency pause safely

**User Story:** As an authorized operator, I want to roll out new automation behavior gradually and stop unsafe new work quickly without losing execution history.

**Acceptance criteria**
- AC-1: Each temporary flag has an owner, purpose, default and expiry/review date.
- AC-2: Rollout cohorts respect workspace isolation and are auditable.
- AC-3: Kill switch stops new eligible work and follows documented policy for queued/in-flight work.
- AC-4: Flag changes and emergency overrides are permission-checked and audited.

**Tasks/subtasks**
- **AE-T-076.1 — Build flag registry and policy**: schema, ownership, expiry reporting. Done when expired flags can be identified automatically.
- **AE-T-076.2 — Implement safe pause/kill switch**: stop intake/claims according to scope; preserve accepted jobs; add recovery. Done when pause/drain/resume drill passes.
- **AE-T-076.3 — Add progressive rollout**: shadow mode and workspace-based cohorts. Tests prove non-cohort work is unchanged. Done when canary rollback is demonstrated in staging.

**Story tests:** TC-FLAG-001 (unauthorized flag change), TC-FLAG-002 (queued-run semantics), TC-FLAG-003 (resume without duplicate effect), TC-FLAG-004 (expiry report).

**Story DoD:** The kill switch and rollback have an owner/runbook, and behavior under in-flight side effects is documented.

## AE-US-077 — Protect API and schema compatibility

**User Story:** As an API/event consumer, I want compatibility rules and migration tests so that routine releases do not break existing automations or workers.

**Acceptance criteria**
- AC-1: API, event, rule and action schemas have explicit versions and compatibility rules.
- AC-2: Breaking changes require a version/migration plan and published change notes.
- AC-3: CI tests old/new producer-consumer and schema-version combinations in the support window.
- AC-4: Database migrations follow a tested expand-and-contract or documented alternative.

**Tasks/subtasks**
- **AE-T-077.1 — Document compatibility policy**: classify additive/breaking changes; define support window; define deprecation notices. Done when reviewed by owners of consumers.
- **AE-T-077.2 — Add contract matrix to CI**: test old event/rule against new worker and migration from previous supported schema. Done when the CI job fails on an intentional incompatible fixture.
- **AE-T-077.3 — Add migration/rollback rehearsals**: test restartable backfill, validation and forward fix. Done when evidence and recovery instructions are stored with the release.

**Story tests:** TC-COMPAT-001 (old event/new consumer), TC-COMPAT-002 (new optional field/old consumer), TC-COMPAT-003 (migration interrupted/restarted), TC-COMPAT-004 (old rule version dispatch).

**Story DoD:** Compatibility policy, automated contract tests and migration runbook are reviewed and part of release gates.

## AE-US-078 — Add software supply-chain release evidence

**User Story:** As a security reviewer, I want release artifacts and dependencies checked with traceable evidence so that known vulnerable or untrusted dependencies are not silently shipped.

**Acceptance criteria**
- AC-1: CI scans dependencies and repository for known vulnerabilities/secrets.
- AC-2: Release pipeline emits an SBOM when supported and links it to an immutable build/commit identity.
- AC-3: High-severity findings are fixed or have a time-bounded, owner-approved exception.
- AC-4: Image signing/provenance is reported only when actually generated and verified.

**Tasks/subtasks**
- **AE-T-078.1 — Integrate dependency/secret scan**: configure CI, define severity policy and exception format. Done when test fixtures prove blocking findings fail the intended gate.
- **AE-T-078.2 — Generate and archive SBOM**: attach artifact to build/release. Done when an auditor can trace the SBOM to the exact build.
- **AE-T-078.3 — Image/artifact verification where applicable**: add signing/provenance if deployment supports it. Done when verification runs before deploy and failure behavior is tested.

**Story tests:** TC-SUPPLY-001 (known vulnerable test dependency), TC-SUPPLY-002 (secret fixture), TC-SUPPLY-003 (SBOM build identity), TC-SUPPLY-004 (invalid signature rejected where signing is enabled).

**Story DoD:** CI evidence is stored, exception ownership is clear and documentation does not overstate implemented assurance level.

## AE-US-079 — Define incident response and operational ownership

**User Story:** As a service owner, I want actionable incident severity, contacts, runbooks and postmortem follow-up so that outages and unsafe automation behavior can be contained and learned from.

**Acceptance criteria**
- AC-1: Severity levels map to observable impact and approved response/communication policies.
- AC-2: Each critical alert has an on-call/owning route and runbook.
- AC-3: Runbooks cover queue backlog, outbox stall, provider outage, DLQ growth, tenant-isolation concern, database outage and rollback.
- AC-4: Postmortem actions have owner, priority, due date and verification.

**Tasks/subtasks**
- **AE-T-079.1 — Approve severity and escalation model**: define impact examples, owners and customer communication. Done when reviewed by engineering/product/security/support as relevant.
- **AE-T-079.2 — Write and test runbooks**: conduct tabletop/staging drills. Done when another engineer can follow the runbook without undocumented knowledge.
- **AE-T-079.3 — Introduce postmortem template/action tracking**: include evidence and data-integrity check. Done when a simulated incident produces a tracked improvement item.

**Story tests:** TC-OPS-001 (alert route), TC-OPS-002 (kill-switch drill), TC-OPS-003 (DLQ recovery drill), TC-OPS-004 (postmortem action owner).

**Story DoD:** Operational owners and response commitments are explicit; unresolved staffing/coverage gaps are recorded as release blockers or accepted risks.

## AE-US-080 — Establish measured load and capacity baseline

**User Story:** As an engineering lead, I want a repeatable representative load test so that capacity, scaling triggers and performance regressions are based on evidence.

**Acceptance criteria**
- AC-1: Scenarios cover normal, peak, burst, noisy neighbor, slow provider, database latency, retries and recovery.
- AC-2: The report contains test configuration, workload shape, throughput, percentiles, resource use, queue age, failures and data-integrity results.
- AC-3: Scale-out is tested and does not violate tenant isolation or duplicate-effect guarantees.
- AC-4: Limits/SLOs remain provisional when tests are insufficient.

**Tasks/subtasks**
- **AE-T-080.1 — Define workload assumptions**: events/sec, matches/event, actions/run, retries and payload distribution. Done when estimates have owners and assumptions.
- **AE-T-080.2 — Automate repeatable load scenarios**: seed data, execute, collect measurements. Done when a baseline report can be regenerated from the same commit/config.
- **AE-T-080.3 — Derive capacity/scaling thresholds**: test bottlenecks and cost. Done when recommendations cite measurements rather than only queue-depth constants.

**Story tests:** TC-PERF-001 (baseline), TC-PERF-002 (burst), TC-PERF-003 (noisy neighbor), TC-PERF-004 (worker restart/queue drain), TC-PERF-005 (no lost/duplicated logical effects).

**Story DoD:** Baseline and known bottlenecks are documented; regression gate noise/variance is understood; no data-integrity/security gate is waived for speed.

## AE-US-081 — Prove backup restore and recovery targets

**User Story:** As an operator, I want a tested recovery procedure so that database/broker incidents have a known recovery path and recovery claims are evidence-based.

**Acceptance criteria**
- AC-1: Backup scope/frequency, encryption, access and retention are documented.
- AC-2: Restore drill measures achieved RTO/RPO for the tested failure scenario.
- AC-3: Post-restore reconciliation identifies active runs, outbox/inbox gaps, uncertain external actions and duplicate risk.
- AC-4: RTO/RPO remain marked unverified until a drill passes.

**Tasks/subtasks**
- **AE-T-081.1 — Define recovery dataset and ownership**: identify database, queues, secrets references, audit and event data. Done when dependencies are mapped.
- **AE-T-081.2 — Automate or rehearse restore**: restore isolated backup, validate invariants and access. Done when timings and gaps are recorded.
- **AE-T-081.3 — Reconcile execution state**: inspect queued/running/unknown outcomes and safely resume. Done when duplicate/loss scenarios have a documented resolution.

**Story tests:** TC-DR-001 (restore integrity), TC-DR-002 (RPO measurement), TC-DR-003 (RTO measurement), TC-DR-004 (unknown external outcome reconciliation).

**Story DoD:** Restore evidence, runbook, owners and measured targets are reviewed; no invented RTO/RPO is published.

## AE-US-082 — Build a connector contract (only if external integrations are in v1)

**User Story:** As an automation author, I want external actions to use a consistent secure contract so that permissions, secrets, retries, rate limits and results behave predictably across providers.

**Acceptance criteria**
- AC-1: Every connector declares typed config/result schemas, permission scopes, timeout, retry classification and idempotency capability.
- AC-2: Secrets are referenced securely, redacted, and revoked on disconnect.
- AC-3: Provider-specific rate limits and circuit-breaker settings are configurable and observable.
- AC-4: Unknown provider outcomes are reconciled or surfaced without blind duplicate side effects.

**Tasks/subtasks**
- **AE-T-082.1 — Define connector interface**: typed request/response, errors, capabilities and registration. Done when a fake connector passes contract tests.
- **AE-T-082.2 — Build one low-risk provider adapter**: secrets, rate limits, timeouts and redaction. Done when integration tests cover normal and failure paths.
- **AE-T-082.3 — Add connector compatibility and lifecycle**: version pins, disconnect/revoke, audit. Done when revoked credentials cannot be reused and changes are audited.

**Story tests:** TC-CONN-001 (schema mismatch), TC-CONN-002 (429/Retry-After), TC-CONN-003 (timeout/unknown outcome), TC-CONN-004 (secret redaction), TC-CONN-005 (revocation).

**Story DoD:** Include this story only if external actions are approved for v1; a public SDK or marketplace needs a separate ADR and security gate.

---


---

# 56. Stories added in v2.0 (design items that had no backlog home)

> Format matches Section 28. Each story needs its acceptance criteria satisfied **and** its tests green before "Done".

## AE-US-083 — Execution identity and owner-access-loss handling

**Epic/Feature:** AE-E04 (governed execution). **Priority:** P0. **Requirements:** BR-005, NFR-004, INV-07; spec D-11, D-12.

**User Story:** As a workspace admin, I want automations to run under a controlled delegated identity that is re-checked on every run, so that an automation can never act with permissions its creator no longer has.

**Acceptance criteria**
- AC-1: Every run builds an execution principal `automation:{automationId}` scoped to the automation's workspace; the human session/token is never used at run time.
- AC-2: Before each action, authorization is evaluated for the action's required permission **at that moment**; denial ⇒ run `failed` with `PERMISSION_REVOKED`, no retry, no effect, audit record written.
- AC-3: If the creator is removed or loses the required permission, the automation transitions to `paused` with reason `OWNER_ACCESS_LOST`, workspace admins are notified, and no new runs start.
- AC-4: An admin can transfer ownership; re-enable re-validates and re-authorizes.

**Tasks/subtasks**
- **AE-T-083.1 — Define `ExecutionPrincipal` and `PolicyPort` usage**: type, builder, adapter to the existing policy engine `[VERIFY]`. Done when a fake policy can deny per action in tests.
- **AE-T-083.2 — Owner-access watcher**: reacts to membership/permission-change events and re-checks at claim time (belt and braces). Done when removal pauses the automation within one event cycle.
- **AE-T-083.3 — Ownership transfer + audit**. Done when transfer is permissioned, audited, and re-validated.

**Story tests:** TC-AUTHZ-001 (revoked between authoring and execution), TC-AUTHZ-002 (owner removed ⇒ paused), TC-AUTHZ-003 (denied action leaves no effect + audit), TC-AUTHZ-004 (no human token reaches handlers).

**Story DoD:** ADR-0008 accepted; tenant matrix includes execution paths; no handler reads ambient session state.

## AE-US-084 — Lease fencing and stale-worker rejection

**Epic/Feature:** AE-E03. **Priority:** P0. **Requirements:** FR (run/queue reliability), INV-04; spec §11.3.

**User Story:** As an operator, I want a worker that lost its lease to be unable to commit state, so that a paused/slow worker cannot corrupt a run that another worker now owns.

**Acceptance criteria**
- AC-1: Claim atomically sets `leaseOwner`, `leaseExpiresAt` and increments `fencingToken`.
- AC-2: Every subsequent run/action write filters on `{_id, fencingToken, expected status}`; zero matched documents ⇒ worker stops immediately and increments `automation_stale_write_rejected_total`.
- AC-3: Lease renewal is fenced too; expired leases are recovered by the reaper per the transition table.
- AC-4: Effects remain protected by action idempotency keys (a stale worker's already-sent effect is not repeated by the new owner).

**Tasks/subtasks**
- **AE-T-084.1 — Fenced repository methods** (`claimNext`, `transition`, `renewLease`) with replica-set integration tests. Done when 20-way claim race yields one owner.
- **AE-T-084.2 — Reaper** (batch, idempotent, counter reconciliation). Done when expired runs recover without duplicate effects.
- **AE-T-084.3 — Failure-injection harness**: pause worker A past lease TTL (fake clock + forced reclaim). Done when A's late write is provably rejected.

**Story tests:** TC-FENCE-001 (claim race), TC-FENCE-002 (stale write rejected), TC-FENCE-003 (reaper recovery), TC-FENCE-004 (no duplicate effect after reclaim).

**Story DoD:** Metrics + alert for lease-expiry rate; runbook entry; ADR-0004 accepted.

## AE-US-085 — Relative timers with stale-check at fire time

**Epic/Feature:** AE-E06. **Priority:** P1. **Requirements:** FR (scheduled/time triggers), BR-011; spec §12.3.

**User Story:** As an automation author, I want triggers like "24 hours before due date" to survive date changes and deletions, so that reminders are neither missed nor sent for outdated dates.

**Acceptance criteria**
- AC-1: Setting a due date upserts a timer keyed by `(automationId, resourceId, kind)` with `fireAt`; changing/removing the date reschedules/cancels it.
- AC-2: At fire time the current resource is re-read; if the date no longer matches, the run is `skipped` with `STALE_TIMER`.
- AC-3: Timer run idempotency key includes `fireAt`; duplicate firing creates one run.
- AC-4: Missed timers after downtime follow the catch-up policy (D-22) and are visible in run history.

**Tasks/subtasks**
- **AE-T-085.1 — Timer collection + unique index + claim loop.** Done when concurrent schedulers fire once.
- **AE-T-085.2 — Event handlers for due-date set/change/delete.** Done when reschedule/cancel tests pass.
- **AE-T-085.3 — Stale-check in executor with fake-clock tests (DST, month end, leap day).**

**Story tests:** TC-TIMER-001 (reschedule), TC-TIMER-002 (cancel on delete), TC-TIMER-003 (stale skip), TC-TIMER-004 (downtime catch-up), TC-TIMER-005 (DST).

**Story DoD:** Timer metrics (due, fired, stale-skipped, late); ADR-0009 accepted.

## AE-US-086 — Architecture-boundary and tenant-matrix test harness

**Epic/Feature:** AE-E07 / AE-E01. **Priority:** P0. **Requirements:** NFR-004, NFR-009, CON-002; spec §6.4, §13.10.

**User Story:** As an engineering lead, I want CI to fail when module boundaries or tenant scoping are violated, so that isolation does not depend on reviewers remembering rules.

**Acceptance criteria**
- AC-1: A dependency rule test fails if `automation-core` imports I/O/infra, or if any module outside the scoped data gateway imports the Mongo driver.
- AC-2: A generated **tenant matrix** runs every repository/API method with `{own workspace, other workspace, missing scope, forged path ID}` and asserts only the first succeeds.
- AC-3: A spy asserts missing scope fails **before** any driver call.
- AC-4: Matrix coverage is checked: adding a repository method without matrix registration fails CI.

**Tasks/subtasks**
- **AE-T-086.1 — Boundary rules** (dependency-cruiser/ESLint boundaries). Done when a deliberate violation fails CI.
- **AE-T-086.2 — Matrix generator + registry check.** Done when a new method is auto-flagged.
- **AE-T-086.3 — Driver-spy missing-scope test.**

**Story tests:** TC-TEN-001…004 (one per matrix cell type), TC-ARCH-001 (core purity), TC-ARCH-002 (driver import ban).

**Story DoD:** Tests are non-skippable on release branches.

## AE-US-087 — One-command local environment and typed configuration

**Epic/Feature:** AE-E07. **Priority:** P1. **Requirements:** NFR-009; spec §16.2–16.3.

**User Story:** As a new engineer, I want to run the engine and its tests locally with one command so that I am productive within a day.

**Acceptance criteria**
- AC-1: `docker compose up` provides a single-node Mongo **replica set** so transactions work locally.
- AC-2: `.env.example` documents every variable with no real secrets; the process refuses to start on invalid config.
- AC-3: Scripts exist for install, dev, unit, integration, lint, typecheck and seed.
- AC-4: Limits (spec §3.4) come from a single typed config object, not scattered constants.

**Tasks/subtasks**
- **AE-T-087.1 — Compose + seed script.** Done when a clean clone passes integration tests locally.
- **AE-T-087.2 — Config schema + boot validation.** Done when invalid config fails fast with a clear message.
- **AE-T-087.3 — Contributor guide + PR template + CODEOWNERS.**

**Story tests:** TC-DX-001 (clean-clone setup), TC-DX-002 (invalid config fails fast).

**Story DoD:** Setup time measured on a clean machine; README current.
