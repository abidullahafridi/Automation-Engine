# ADR-0003: Outbox atomicity and MongoDB transactions

- **Status:** Accepted (decision). Verification pending.
- **Date:** 2026-10-15
- **Decision owner:** Abid Ullah
- **Target conversion owner:** Not assigned / TBD
- **CI replica-set infrastructure owner:** Approval pending
- **Review:** Decision recorded by owner; target verification and CI infrastructure approval pending
- **Next review:** After target conversion and transaction probe evidence are available

## Context

An event describing a committed domain mutation must not be published when that mutation
rolls back. The repository currently has no persistence-backed domain mutation or outbox.
The API Mongoose adapter only connects/disconnects. A saved transaction probe reports a
standalone MongoDB target and failed transaction checks; it is not proof of transaction
support. The actual production target owner and topology remain unverified. Decision acceptance
does not mean target verification, implementation completion, or production enablement.

## Drivers

- Do not lose or invent events for domain mutations.
- Choose atomicity based on verified deployment capability.
- Exercise the selected consistency behavior against the real supported database semantics.

## Options

1. **Transactional outbox with MongoDB multi-document transactions.** Persist the domain mutation
   and outbox record in the same MongoDB multi-document transaction on a verified replica set
   or sharded cluster.
2. **Dual-write + reconciliation scanner.** Commit the domain write, then write an outbox record,
   with a reconciliation scanner that detects missing events.
3. **Event embedded in the aggregate document.** Persist the outbox event directly inside the
   aggregate document itself, avoiding multi-document transactions.

## Rejected alternatives

- **Dual-write + reconciliation scanner:** not acceptable as a production default (events can be missed or phantom).
- **Event embedded in the aggregate document:** only if the owner rejects the replica-set requirement, via a NEW ADR.

## Decision

**Decision owner: Abid Ullah | Decision date: 2026-10-15**

**Status: Accepted (decision). Verification pending.**

Approved architecture:
1. Domain mutation and its outbox event are written in the SAME MongoDB multi-document transaction.
2. MongoDB transactions require a replica set or sharded cluster. Standalone MongoDB is UNSUPPORTED for the
   automation engine's transactional outbox/ingest.
3. Local development and CI use a single-node MongoDB replica set.
4. The production outbox/ingest feature flag stays OFF until ALL checks of scripts/verify-mongo-transactions.mjs
   pass against the ACTUAL target environment and the evidence is recorded.
5. Transactional code retries transient transaction errors, monitors transaction aborts, and uses majority write concern.

Rejected alternatives:
 - Dual-write + reconciliation scanner: not acceptable as a production default (events can be missed or phantom).
 - Event embedded in the aggregate document: only if the owner rejects the replica-set requirement, via a NEW ADR.

## Consequences

- The actual deployment infrastructure must run a replica set or sharded cluster; standalone MongoDB is unsupported for the automation engine's transactional outbox/ingest.
- Local development and CI use a single-node MongoDB replica set (`rs0`).
- Transactional code must retry transient transaction errors, monitor transaction aborts, and use majority write concern.
- The production outbox/ingest feature flag stays OFF until ALL checks of `scripts/verify-mongo-transactions.mjs` pass against the ACTUAL target environment and the evidence is recorded.
- The root Compose fixture and proposed CI job are local/CI mechanism proofs, NOT proof that transactions work on the target environment.

## Security and operations

The chosen mode needs failure-injection coverage for mutation rollback, process crash between
writes, relay publish-before-ack crash, and recovery. Monitor transaction aborts and oldest
pending outbox age. Never publish an event whose source mutation is known to have failed.

## Follow-ups and blocked work

- **Target-to-replica-set conversion owner:** Not assigned / TBD.
- **Target verification:** Pending. Run `scripts/verify-mongo-transactions.mjs` against the actual target after conversion and record sanitized evidence.
- **CI replica-set environment:** Proposed, infrastructure owner approval pending. The approval-gated CI job and local Compose fixture are mechanisms, not proof of target support.
- **Backlog:** AE-T-000.3 = Partly (decision accepted, verification blocked on target replica set). AE-T-020.2 = development/tests may start on a LOCAL replica set; production enablement stays behind the ADR-0003 gate.
- Do not mark verification or either task fully complete until acceptance criteria are actually met.

## Evidence

- [Automation Engine specification, D-02–D-03 and §17.4](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-020 / AE-T-020.2](../../automation-engine-backlog.md)
- [Repository audit, V20–V27 and U3/U10](../architecture/repository-audit.md)
- [API MongoDB adapter](../../servers/api/integrations/mongodb/connection.ts)
- [API MongoDB tests](../../servers/api/tests/mongodb.test.ts)
- [Failed probe on a standalone target, NOT proof that transactions work](../architecture/evidence/ae-t-000-3-mongodb-transactions-2026-10-14T16-39-27-199Z.json)
