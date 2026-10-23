# ADR-0001: Modular monolith and worker process

- **Status:** Deferred; proposed direction only
- **Date:** 2026-10-14
- **Decision owner:** Product and engineering owners (not identified in repository)
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Review:** No independent reviewer or product approval recorded
- **Next review:** Before automation implementation units or processes are created

## Context

The specification proposes a modular monolith with a separate worker process type in the same
codebase. The repository is a feature-first monorepo foundation with a server-owned API and
no automation runtime, worker, queue, or automation packages. No workload, deployment
ownership, or operational topology has been established for the engine.

## Drivers

- Preserve clear feature and integration boundaries.
- Avoid premature service/package proliferation.
- Keep domain/application contracts independent of process transport.
- Operate worker failures and scaling only with an identified owner and evidence.

## Options

1. **Proposed: modular monolith with a separate worker entry point in the same codebase.**
   Share contracts and domain/application code while keeping HTTP and background process
   composition explicit.
2. **Implement the worker inside the API process.** Simpler initial deployment, but couples
   HTTP availability, worker lifecycle, and resource contention.
3. **Split automation into independently deployed services/packages immediately.** Rejected
   as an unmeasured operational and ownership burden.

## Decision

**Deferred.** The modular-monolith / separate-worker direction is provisional. Confirm the
deployment owner, process lifecycle, and operational constraints before creating a worker
entry point or workspace unit. Do not infer that the API's current optional Mongo integration
provides worker readiness.

## Consequences

- No automation package, worker process, or deployment unit is authorized by this draft.
- If accepted, enforce feature boundaries and explicit composition; extract services only
  when measured scaling or ownership needs justify it.

## Security and operations

Worker shutdown, health, concurrency limits, secret access, logging redaction, and deployment
rollback must be defined before production execution. A worker must use the same approved
tenant authorization and durable claim contracts as the API-facing system.

## Follow-ups and blocked work

- Identify platform/operator owner and expected deployment topology.
- Revisit after ADR-0002–0004 establish delivery and durable execution prerequisites.
- **Blocked:** creating production automation process/package topology and the first
  executable vertical slice.

## Deferral record

Deferred on 2026-10-14 because no automation workload, worker operational owner, or deployment
model is recorded. `@adeelchainz` owns routing this decision for review; product and
engineering owners must be identified before implementation architecture becomes Ready.

## Evidence

- [Automation Engine specification, D-01 and §17.4](../../automation-engine-spec-v2.md)
- [Backlog, AE-E00 and AE-E01–AE-E07](../../automation-engine-backlog.md)
- [Repository audit](../architecture/repository-audit.md)
- [Repository architecture policy](../../architecture.yaml)
