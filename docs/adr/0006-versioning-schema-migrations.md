# ADR-0006: Automation versions and schema migrations

- **Status:** Accepted
- **Date:** 2026-10-14
- **Decision owner:** abidullah
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Owner approval:** Accepted by: abidullah  Date: 14/10/2026.
- **Independent review:** Pending before production persistence or enablement.
- **Next review:** Before durable persistence or production enablement.

## Context

Published automations must not change underneath queued or running executions. The
specification proposes immutable numbered versions, content hashes, run-to-version pinning,
additive event/schema evolution, and expand/contract migrations. The repository has no
automation persistence models, migration framework, or versioned rule contracts.

## Drivers

- A run executes the exact validated definition it was created for.
- Published definitions are immutable.
- Concurrent edits/publication are detected rather than silently overwriting data.
- Schema evolution and rollback preserve readable historical data.

## Options

1. **Proposed: immutable published versions with a content hash; runs pin a version.**
   Drafts remain editable; publishing creates a new immutable version.
2. **Mutate the active definition in place.** Rejected because in-flight work could observe
   changed behavior.
3. **Repin existing queued work automatically.** Rejected as a default because it changes
   already accepted work; any opt-in requires explicit admin behavior and audit.

## Decision

**Accepted by: abidullah  Date: 14/10/2026.** Published versions are immutable. Each
version stores a `schemaVersion` and a `contentHash` computed as SHA-256 of canonical JSON
with recursively sorted object keys and no undefined values. Queued runs remain pinned to
the version they accepted; repinning is not allowed by default.

Publishing does not require a multi-document transaction: insert the immutable version
under a unique `(workspaceId, automationId, version)` key, then conditionally update the
automation header using its expected `rev`. A version insert that loses the header CAS
may remain orphaned and is harmless; retrying the same publish request must be
idempotent and safe. This decision is limited to version publication and does not approve
domain-write/outbox atomicity.

Every rule carries `schemaVersion`. Schema migrations are read-time upcasts; stored
published versions are never rewritten. Rollback is a forward-fix, not mutation of
history. Retain versions while the automation exists and while any run references them.

## Consequences

- Repository adapters must enforce the unique version key, immutable inserts, idempotency,
  and conditional header revision update. The current in-memory adapter is not durable or
  multi-process atomic.
- Read-time upcasts must preserve the stored hash/version and must not rewrite published
  data; rollback proceeds through a forward-fix.
- Versions cannot be removed while the automation exists or a run references them.
- This decision does not authorize production persistence, API exposure, or enablement;
  those retain their separate scope, adapter, transaction, review, and security gates.

## Security and operations

Never mutate historical executable versions or silently reinterpret stored rules. Avoid
storing secret values in versions; store references only. Migrations need backup/rollback
evidence and must not invalidate active, retrying, or unknown-outcome runs.

## Follow-ups and blocked work

- Define canonical content hashing and optimistic-concurrency behavior.
- Implement and test idempotent version insert followed by header revision CAS.
- **Resolved by this decision:** queued-run repinning default, retention while automation/run
  references exist, read-time upcasts, and forward-fix rollback policy.
- **Still gated:** durable adapter behavior against a supported database, trusted scope and
  production API/enablement under ADR-0008, and independent review.
- **Unblocked at the port/service contract level:** AE-T-012.1/.2 and stable version references.

## Deferral record

Accepted by decision owner abidullah on 14/10/2026 for immutable versions, canonical hashes,
retry-safe insert/CAS publication, pinned queued runs, read-time upcasts, forward-fix rollback,
and reference-based retention. Independent review and production persistence evidence remain
pending; acceptance is not a claim that a durable adapter exists.

## Production-enablement gate

Before production enablement, verify the durable adapter's unique index, immutable version
storage, idempotent retries, conditional `rev` update, orphan handling, run-version retention,
read-time upcasts, and forward-fix recovery against the supported database. Complete
independent review and satisfy ADR-0008's platform-adapter and cross-tenant-test gate.

## Review record

- Decision owner approval: Accepted by: abidullah  Date: 14/10/2026.
- Independent reviewer: Pending; no independent review is claimed.
- Production evidence review: Pending durable-adapter and supported-database tests.

## Evidence

- [Automation Engine specification, D-21 and §10.1 / §17.4](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-012](../../automation-engine-backlog.md)
- [Repository audit, API persistence findings](../architecture/repository-audit.md)
- Owner decision record: Accepted by: abidullah  Date: 14/10/2026.
