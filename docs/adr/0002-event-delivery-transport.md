# ADR-0002: Event delivery and transport

- **Status:** Deferred; proposed direction only
- **Date:** 2026-10-14
- **Decision owner:** Product and engineering owners (not identified in repository)
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Review:** No independent reviewer or product approval recorded
- **Next review:** Before AE-T-020.2 or AE-T-021.1 is marked Ready

## Context

Automation needs durable, duplicate-tolerant event delivery and ingestion. The repository has
no event transport, outbox, queue, or scheduler. The API currently owns an optional Mongoose
connection, but [the repository audit](../architecture/repository-audit.md) could not verify
the actual MongoDB deployment topology or transaction support. Event volume and delivery SLOs
are also not established.

## Drivers

- Accepted domain changes must not be silently lost.
- At-least-once delivery and duplicate handling must be explicit.
- Keep the domain independent of a transport vendor.
- Do not imply that MongoDB transactions or a production topology already exist.

## Options

1. **Proposed: `EventTransport` port with a Mongo outbox poller adapter.** Reuse the proposed
   Mongo system of record and start with polling; adapter selection remains conditional on
   ADR-0003 and verified topology.
2. **Adopt a broker immediately.** Adds provisioning, operating ownership, and another
   delivery boundary before measured throughput or latency requires it.
3. **Publish synchronously from the domain request.** Couples request success to downstream
   availability and does not resolve the database/event dual-write problem.
4. **Defer event-driven automation.** Safe until durable delivery prerequisites and owners
   are known, but blocks the first event-triggered slice.

## Decision

**Deferred.** The provisional direction is a transport-neutral `EventTransport` port with
Mongo-backed polling only if ADR-0003's atomicity prerequisites are verified. No transport
contract or delivery guarantee is accepted until product/engineering owners confirm workload,
topology, and recovery expectations.

## Consequences

- A broker is not introduced on the basis of this draft.
- No event-triggered automation may be declared production-ready.
- Duplicate delivery must be expected by downstream consumers if this direction is later
  accepted.

## Security and operations

The transport must validate event schemas and trusted workspace provenance, bound payload
size, avoid logging payload secrets, expose oldest-unpublished age, and support observable
retry/recovery. Ordering is not promised unless a later decision defines its scope.

## Follow-ups and blocked work

- Confirm real event volume, latency/recovery SLO, and MongoDB topology.
- Revisit transport choice after ADR-0003.
- **Blocked:** AE-US-020 publication implementation and AE-T-020.2; AE-US-021 / AE-T-021.1
  durable ingestion and deduplication; any event-triggered vertical slice.

## Deferral record

Deferred on 2026-10-14 because deployment topology, transaction capability, workload, and
product delivery expectations are unverified. `@adeelchainz` owns routing the decision for
review; product and engineering decision owners must be identified and approve it before the
blocked stories become Ready.

## Evidence

- [Automation Engine specification, D-01–D-08 and §17.4](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-020 and AE-US-021](../../automation-engine-backlog.md)
- [Repository audit, AE-T-000.2](../architecture/repository-audit.md)
- [API MongoDB integration](../../servers/api/integrations/mongodb/connection.ts)
