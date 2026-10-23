# Repository Audit (AE-T-000.1)

Status: Historical repository snapshot as of 2026-10-15. Its initial inventory below predates
the automation feature implementation and is not current implementation evidence. See the
[2026-10-20 automation readiness audit](readiness-audit-2026-10-20.md) for the superseding
code, test, runtime-composition, and blocker assessment.

## 1. Verified facts
| # | Fact | Evidence |
|---|---|---|
| V1 | 7 workspace units: api, eslint-config, logging, tsconfig, types, ui, web | `pnpm run projects` |
| V2 | Dependency graph has no cycles | `pnpm run graph` |
| V3 | Package scope is `@workspace/*` | package.json files |
| V4 | Test runner in api is `tsx --test` | servers/api/package.json |
| V5 | Node engines >=20.19.0, TypeScript 5.9.3, ESLint 9.39.5 | package.json files |
| V6 | tsconfig presets: base.json, node.json (NodeNext, verbatimModuleSyntax), next.json | packages/tsconfig |
| V7 | Workspace globs: apps/*, servers/*, packages/*, prebuilt/*, prebuilt/*/* | pnpm-workspace.yaml |
| V8 | api capabilities: http-api, health, mongodb-integration; uses express 5, mongoose 9, zod 4 | project.json, package.json |
| V9 | api features dir contains only `health/` | `ls servers/api/features` |
| V10 | No automation code, no starter/, no run-transitions or idempotency files | git grep, find |
| V11 | project.json `tasks` is an object keyed by task name | packages/types/project.json |
| V12 | Policy: packages cannot import apps/servers/prebuilt; no explicit any; no inheritance, DI containers or mutable global state | architecture.yaml |
| V13 | Server features are flat by default; roles: route, controller, service, repository, validation, model, integration | architecture.yaml |

| V14 | No tenant/principal/permission/policy/membership/workspaceId/scope code in servers/ | `git grep -i` over servers/ returned no matches |
| V15 | No redaction/secret/token handling in packages/logging/src | `grep -i` returned no matches |
| V16 | No queue/scheduler/outbox/transaction code in servers/ or packages/ | `git grep -i` returned no matches |
| V17 | api has errors/, config/, validation/env.validation.ts, middleware/, integrations/mongodb/ (connection.ts, index.ts, types.ts) | `ls` |
| V18 | Error convention: frozen plain object `{kind: "application-error", ...}` via createApplicationError, not an Error subclass | servers/api/errors/application-error.ts |
| V19 | Reference feature layout: features/health with routes/, controllers/, services/ | `.project/PROJECT-STATE.md` (documentation claim) |
| V20 | `.github/workflows/control-plane.yml` runs the standard validation workflow. A separate Mongo transaction probe job is proposed and gated on repository variable `MONGO_REPLICA_SET_CI_APPROVED == 'true'`; it is not active until infrastructure owner approval | [control-plane.yml](../../.github/workflows/control-plane.yml) |
| V21 | The API-owned Mongo adapter calls `mongoose.connect(uri)` with no connection options and `mongoose.disconnect()` on shutdown; no session or transaction API is exposed | [connection.ts](../../servers/api/integrations/mongodb/connection.ts), [types.ts](../../servers/api/integrations/mongodb/types.ts) |
| V22 | `MONGODB_URI` is optional. Without it, `connect()` logs that persistence is disabled and resolves successfully; `server.ts` then starts the HTTP server | [env.validation.ts](../../servers/api/validation/env.validation.ts), [connection.ts](../../servers/api/integrations/mongodb/connection.ts), [server.ts](../../servers/api/server.ts) |
| V23 | `MONGODB_URI`, when present, is validated only as a non-empty string. No replica-set, deployment topology, or transaction capability is validated | [env.validation.ts](../../servers/api/validation/env.validation.ts), [api.ts](../../servers/api/config/api.ts) |
| V24 | The Mongo client is injectable. The Mongo integration tests use a fake client to verify connect/disconnect composition; they do not connect to MongoDB or verify transactions | [types.ts](../../servers/api/integrations/mongodb/types.ts), [mongodb.test.ts](../../servers/api/tests/mongodb.test.ts) |
| V25 | The API test suite includes environment, HTTP-boundary, Mongo integration-lifecycle, shutdown, and health behavior tests. This run passed all 10 API tests; all 2 logging tests also passed | [package.json](../../servers/api/package.json), [mongodb.test.ts](../../servers/api/tests/mongodb.test.ts), [logging.test.ts](../../packages/logging/tests/logging.test.ts) |
| V26 | The API example leaves `MONGODB_URI` commented out and shows a standalone localhost URI without `replicaSet`; this is an example only, not evidence of a running local or deployed database | [API .env.example](../../servers/api/.env.example) |
| V27 | A root Compose single-node `rs0` fixture and a proposed approval-gated CI probe job are now defined. They have not been run/approved in this environment. No actual MongoDB transaction/outbox/queue/scheduler implementation exists | [docker-compose.yml](../../docker-compose.yml), [control-plane.yml](../../.github/workflows/control-plane.yml), [MongoDB integration](../../servers/api/integrations/mongodb/connection.ts) |

## 2. Unknowns and status
| # | Item | Status | Evidence / next step |
|---|---|---|---|
| U1 | Workspace-scoped data gateway | VERIFIED ABSENT | V14. Decision to reuse the future auth milestone or define minimum explicit ports is deferred in [ADR-0008](../adr/0008-tenant-isolation-execution-identity.md). |
| U2 | Principal / policy engine | VERIFIED ABSENT | V14. PROJECT-STATE: auth not implemented, next milestone M03.3 |
| U3 | Actual production MongoDB topology; replica-set availability and transaction readiness | PENDING / UNVERIFIED | The saved [probe on a standalone target](evidence/ae-t-000-3-mongodb-transactions-2026-10-14T16-39-27-199Z.json) reports topology `FAIL`, `atomicCommit` `FAIL` (`MongoBulkWriteError`), `abortRollback` `FAIL` (`MongoBulkWriteError`), `duplicateKeyAbort` `FAIL` (`MongoServerError`), and `concurrentNoLostUpdate` `FAIL` (MongoDB code 20). This is a failed probe on a standalone target, NOT proof that transactions work or confirmation of the actual production target identity. Owner decision in [ADR-0003](../adr/0003-outbox-transactions.md) requires converting the target to a replica set (or sharded cluster), then passing every probe check against the actual target and recording evidence. Target conversion owner is Not assigned / TBD. |
| U4 | Queue, scheduler, outbox, or transaction implementation | VERIFIED ABSENT | Source/config search found no implementation in `servers/`, `packages/`, CI, or repository provisioning (V16, V21, V27). Proposed choices are recorded but deferred in [ADR-0002](../adr/0002-event-delivery-transport.md) and [ADR-0003](../adr/0003-outbox-transactions.md); dependent implementation remains blocked. |
| U5 | Workspace, membership, task persistence models and repositories | VERIFIED ABSENT | No persistence-backed feature/model/repository is present in the API; the Mongo integration currently provides only connection lifecycle (V9, V21, V24). |
| U6 | Error and configuration conventions | VERIFIED | Environment is parsed with Zod and mapped into immutable API config; application errors are frozen plain objects; the HTTP error boundary returns stable API errors and logs unexpected errors. See [env.validation.ts](../../servers/api/validation/env.validation.ts), [config/api.ts](../../servers/api/config/api.ts), [application-error.ts](../../servers/api/errors/application-error.ts), and [errors.ts](../../servers/api/middleware/errors.ts). |
| U7 | CI jobs and database-backed test infrastructure | VERIFIED | The only workflow is the control-plane workflow; its job has no MongoDB service/container. API persistence tests use an injected fake client, not a database-backed integration fixture (V20, V24, V25). |
| U8 | Logging and sensitive-data redaction | VERIFIED ABSENT | The Pino logger has no redaction configuration. Production HTTP logging uses Morgan `combined`; no query/header redaction is configured. Treat logging of request URLs and arbitrary error/context values as a security/privacy gap to address before automation credentials or sensitive payloads are logged. See [logger.ts](../../packages/logging/src/logger.ts), [http.ts](../../packages/logging/src/http.ts), and [create-app.ts](../../servers/api/bootstrap/create-app.ts). |
| U9 | Doc inconsistency | NOTE | PROJECT-STATE says "eight workspace projects"; `pnpm run projects` listed 7. Possibly stale |
| U10 | Approved repeatable Mongo integration-test infrastructure | PROPOSED / APPROVAL PENDING | `docker-compose.yml` proposes a local single-node `rs0` fixture; the workflow has a separate probe job gated by `MONGO_REPLICA_SET_CI_APPROVED == 'true'`. Docker/Compose are unavailable in this environment, so the local fixture was not run. CI replica-set infrastructure approval is pending; a local/CI mechanism pass is not target verification. |
| U11 | Integration-test infrastructure for Mongo | VERIFIED ABSENT | No local database fixture or CI service is configured (V20, V24–V27). Adding Compose and a CI replica-set service changes repository/CI policy and needs owner approval; neither was added by this audit. |


## 3. Proposed reuse points (recommendation, not fact)
- `packages/logging` for structured logs, after a redaction policy and safe request-logging behavior are designed.
- types package for cross-workspace API contracts
- api errors/ and validation/env.validation.ts conventions
- repo CLI (`node codebase/cli/repo.mjs`) for tasks and checks

## 4. Conflicts spec vs repo (recommendation)
- Spec proposes 7 packages; architecture.yaml favors minimal growth. Proposal: one package first (ADR-0001).
- Spec assumes existing workspace gateway/policy engine; neither is present (U1, U2). Decide through ADR whether automation waits for the auth milestone or owns the minimum explicit ports; do not imply these capabilities already exist.

## 5. AE-T-000.2 — Runtime and persistence validation

### Verified in repository configuration and source

- The server loads dotenv, validates its environment with Zod, maps it to an immutable API config, constructs the Mongo adapter, awaits `database.connect()`, and then starts the HTTP server. Since MongoDB is optional and the no-URI adapter resolves successfully, the API can run without persistence; that mode is not suitable for persistence-dependent automation work. See [server.ts](../../servers/api/server.ts), [env.ts](../../servers/api/config/env.ts), [env.validation.ts](../../servers/api/validation/env.validation.ts), [api.ts](../../servers/api/config/api.ts), and [connection.ts](../../servers/api/integrations/mongodb/connection.ts).
- When configured, the adapter delegates connection to Mongoose with only the URI. `MongoClient` is injectable, but its interface exposes only `connect` and `disconnect`; there is no transaction/session contract. The API Mongo tests prove the adapter lifecycle against a fake client, not database connectivity, replica-set topology, or transaction behavior. See [types.ts](../../servers/api/integrations/mongodb/types.ts) and [mongodb.test.ts](../../servers/api/tests/mongodb.test.ts).
- The API `.env.example` comments out a localhost standalone Mongo URI. It is documentation, not a running local database or deployment setting. No Compose/Docker database setup or CI Mongo service was found. CI installs dependencies and runs the repository validation workflow only. See [API .env.example](../../servers/api/.env.example) and [control-plane.yml](../../.github/workflows/control-plane.yml).
- API test infrastructure is `tsx --test`; its current Mongo test is a unit/lifecycle test using an injected fake. During this audit, the API suite passed **10/10** tests and the logging suite passed **2/2** tests. These results do not establish MongoDB integration or transaction readiness.
- Configuration and error conventions are reusable: Zod validates runtime environment input; API config is a frozen projection; `createApplicationError` returns a frozen plain object; the Express error boundary maps validation/application errors to stable API responses and logs unexpected failures. See [env.validation.ts](../../servers/api/validation/env.validation.ts), [config/api.ts](../../servers/api/config/api.ts), [application-error.ts](../../servers/api/errors/application-error.ts), and [errors.ts](../../servers/api/middleware/errors.ts).
- `packages/logging` provides Pino structured logs and Morgan HTTP logs. Pino has no configured redaction; production HTTP logging uses Morgan `combined`, with no query/header redaction. Logging policy is therefore **not** ready to carry automation secrets or sensitive payloads without additional design. See [logger.ts](../../packages/logging/src/logger.ts), [http.ts](../../packages/logging/src/http.ts), and [create-app.ts](../../servers/api/bootstrap/create-app.ts).

### Blockers and decisions

1. **Deployment topology is unknown.** No live MongoDB URI was inspected or tested. The actual local/staging/production deployment owner must confirm where MongoDB runs and whether it is a replica set with transactions enabled. Do not infer this from the commented example URI.
2. **Transactional outbox is not currently supportable from verified evidence.** Before choosing it, verify the target topology and record the decision in an ADR. If local/CI coverage is required, propose a single-node replica-set fixture and CI service separately for owner review; this audit did not add infrastructure.
3. **Queue and scheduler choices remain open.** No implementation or existing abstraction was found. Record the selected delivery/runtime approach in the relevant ADR rather than treating queue, outbox, or scheduler support as existing.
4. **Sensitive logging needs a policy.** Define redaction and request-log behavior before adding automation tokens, credentials, or user-controlled sensitive data to log context.

**AE-T-000.2 result:** repository-side runtime, configuration, tests, CI, logging, and error conventions are documented with source evidence. The real MongoDB topology/transaction prerequisite remains an explicit owner-confirmation blocker; no unsupported runtime or transaction assumption is recorded as verified.

## 7. AE-T-000.3 — MongoDB transaction verification (2026-10-15)

- The repository probe is `node scripts/verify-mongo-transactions.mjs`. It requires `MONGO_URI` and explicit `ALLOW_NON_PROD=yes`; the URI is never written to the evidence file or command output. The probe uses the API workspace's installed Mongoose client and covers transaction-capable topology, multi-document commit, explicit abort/rollback, duplicate-key abort behavior, and concurrent updates.
- Current local invocation returned `BLOCKED: Set MONGO_URI to a non-production MongoDB deployment; no connection was attempted.` No `MONGO_URI` was configured, so no target was contacted.
- The saved probe result dated 2026-10-14 reports a standalone target, which is not transaction-capable. Topology detection failed; `atomicCommit`, `abortRollback`, and `duplicateKeyAbort` failed; `concurrentNoLostUpdate` failed with MongoDB error code 20. See [sanitized probe evidence](evidence/ae-t-000-3-mongodb-transactions-2026-10-14T16-39-27-199Z.json). The evidence does not identify the target owner or record a safe deployment identity, so it cannot be accepted as target-topology verification.
- The only current CI workflow has no MongoDB service or replica-set fixture. The repository audit contains no approval to add infrastructure, and no deployment owner, target endpoint, or approved repeatable local/CI environment is identified. Do not add an unapproved service or infer production capability from the standalone result.

**AE-T-000.3 result: Blocked / Done criteria not met.** The repository documents why a repeatable replica-set test environment is unavailable, but TC-0009 and TC-0010 have not passed against the actual target topology. Completion requires a named deployment owner, a non-production target, safe deployment identity evidence, successful commit and abort checks, and an approved repeatable integration environment.

## 6. AE-T-001.1 — ADR review status

Draft ADRs [0001–0009](../adr/README.md) record context, alternatives, proposed direction,
consequences, security/operational implications, follow-ups, evidence, and explicitly deferred
backlog stories. **No ADR is accepted:** independent reviewer and product/security/platform
approvals are not recorded. Deferral owner, date, reason, and blockers are stated per ADR.
These drafts do not unblock the dependent stories; review/ratification is required before
those stories become Ready.
