# Automation Engine ADR register

These ADRs record accepted decisions and proposals still awaiting human approval.
**Deferred** means a choice is not accepted and does not unblock dependent implementation.
**Accepted (decision). Verification pending.** means the owner has selected the architecture,
but target-environment verification or operational approval remains incomplete and dependent
production enablement stays gated.
ADR-0005 records the accepted v1 rule-language scope under a single-reviewer exception; owner
and reviewer details are not recorded here. ADR-0006 is accepted for version/migration semantics;
ADR-0008 is accepted for the port contract only. Neither acceptance proves production readiness.
ADR-0005's named security tests are recorded in its checklist; production remains separately gated.

| ADR | Topic | Status | Primary blocker |
|---|---|---|---|
| [0001](./0001-modular-monolith-worker.md) | Modular monolith and worker process | Deferred | Deployment and worker ownership |
| [0002](./0002-event-delivery-transport.md) | Event delivery and transport | Deferred | Workload, topology, delivery expectations |
| [0003](./0003-outbox-transactions.md) | Outbox atomicity and MongoDB transactions | Accepted (decision). Verification pending. | Actual target replica-set conversion and probe; CI approval pending |
| [0004](./0004-run-queue-lease-fencing.md) | Run queue, claims, leases, fencing | Deferred | Durable-store choice and concurrency evidence |
| [0005](./0005-rule-language-action-registry.md) | Rule language and action registry | Accepted (single-reviewer exception) | Verify security checklist before AE-US-012 / production enablement |
| [0006](./0006-versioning-schema-migrations.md) | Automation versions and migrations | Accepted | Durable adapter verification and independent production review |
| [0007](./0007-retry-dead-letter-replay.md) | Retry, dead-letter, and replay | Deferred | Action-specific behavior and product policy |
| [0008](./0008-tenant-isolation-execution-identity.md) | Tenant isolation and execution identity | Accepted (port contract only) | Real platform adapter, cross-tenant tests, production security review |
| [0009](./0009-schedules-timers-dst.md) | Schedules, timers, and DST | Deferred | Product ratification and scheduler ownership |

Deferral owner for deferred entries in this review set: `@adeelchainz` (repository owner /
CODEOWNER). Product, security, platform, and engineering decision owners must be identified
where each deferred ADR calls for them. Each ADR names the blocked backlog stories and the
evidence needed to revisit it.

This register covers ADR-0001 through ADR-0009 referenced by the v2 specification. It does
not claim completion of ADR-0010 through ADR-0012 or the conditional ADRs in §17.4.
