# Automation Engine workload and service-objective baseline

**Status:** Proposed baseline; not an approved SLO, SLA, capacity commitment, or
retention policy.
**Prepared:** 2026-10-14
**Proposed review date:** 2026-10-28 (requires owner confirmation)
**Decision state:** Blocked pending workload forecast, named operating owner, and
product/security/privacy approval.

This document records measurable indicators and the evidence needed to set initial
targets. It does not turn unmeasured values from the specification into commitments.
The Automation Engine is not implemented in this repository, so there is no runtime
telemetry or production workload baseline to measure today.

## 1. Workload assumptions and capacity inputs

### Current evidence

- The repository has no Automation Engine runtime, event queue, worker, scheduler, or
  automation-specific telemetry implementation.
- No product forecast, event-volume telemetry, action mix, provider limits, or production
  deployment shape is recorded in the repository.
- MongoDB topology and transaction support remain unverified; see the
  [repository audit](./repository-audit.md) and [ADR register](../adr/README.md).
- The specification's example object counts and provisional development guardrails are
  not an expected workload or a production capacity envelope.

Therefore, expected events/sec, peak burst multiplier, matched automations/event,
actions/run, retries, and run-history growth are **unknown**, not zero. Do not size
production infrastructure or claim capacity until the forecast below has been completed
and benchmarked.

### Forecast to obtain

| Input | Initial value | Source / measurement method | Accountable role |
|---|---|---|---|
| Normal incoming events/sec and daily event volume | TBD | Product usage forecast, then compare with ingress counters after launch | Product owner |
| Peak sustained event rate and duration | TBD | Forecast busiest expected interval; validate with ingress counters | Product owner + engineering |
| Burst multiplier and burst duration | TBD | Forecast peak-to-normal ratio and define a burst test profile | Product owner + engineering |
| Fraction of events matching at least one automation | TBD | Matched-event counter divided by accepted events, segmented by trigger type | Product owner + engineering |
| Eligible automations per event (average and tail) | TBD | Match-count histogram; use bounded histogram buckets | Engineering |
| Actions per run and action-type mix | TBD | Run/action counters and action-type histogram | Product owner + engineering |
| Attempts per action, timeout and retry rates | TBD | Attempt, retry, timeout and terminal-outcome counters | Engineering |
| Schedule catch-up volume | TBD | Forecast schedule population and missed-occurrence horizon; load-test recovery | Product owner + engineering |
| Event and run payload size distribution | TBD | Redacted size histograms at accepted ingress and persisted-run boundaries | Engineering + privacy/security |
| Provider rate limits and latency distribution | TBD per provider | Published provider limits plus observed adapter latency/throttle metrics | Integration owner |
| Run-history growth and query mix | TBD | Runs/day × retained days, action records/run, index/storage measurements | Product owner + engineering |

Use the specification's first-order estimate after inputs are supplied:

`action attempts/sec = events/sec × average eligible automations/event × average actions/run × average attempts/action`

Estimate in-flight actions with Little's Law:

`in-flight actions ≈ action arrival rate × average action service time`

These estimates are benchmark inputs, not evidence of capacity. Test forecast normal,
expected peak, a burst with documented factor/duration, noisy-neighbor behavior, provider
throttling, retries, scheduler catch-up, and queue recovery. Record software version,
machine shape, database/queue configuration, dataset distribution, test duration,
throughput, p50/p95/p99, resource use, queue age, errors, retries, and integrity results.
No numerical load profile is approved by this document.

## 2. Candidate indicators and provisional objectives

All indicators below need implementation before they can be reported. The data sources
are proposed instrumentation contracts, not claims that the telemetry already exists.
Use bounded-cardinality labels; do not label metrics with workspace, run, or automation
IDs.

| Indicator | Measurement and window | Data source | Initial target / state | Owner role |
|---|---|---|---|---|
| Management API availability | Eligible successful requests / eligible requests, monthly; define expected 4xx exclusions before adoption | HTTP request counter by route group and outcome | 99.9% monthly is a **provisional candidate** from spec §21.2, only after operational maturity; not an SLA | Engineering + operating owner (unassigned) |
| API latency | Server-side request-duration p50/p95/p99 by route group and rolling window | HTTP request-duration histogram | Numeric target **TBD** after forecast and representative baseline | Engineering |
| Event enqueue delay | Domain-event occurrence/commit to durable pipeline acceptance; p50/p95/p99 by rolling window | Persisted event timestamps and enqueue-delay histogram | p95 <500 ms is a **provisional candidate** from spec §21.2 under agreed load; not measured or committed | Engineering |
| Queue wait / oldest eligible age | `worker_started_at - job_eligible_at` distribution and oldest eligible item age, by queue class; report rolling percentiles and current gauge | Persisted eligible/start timestamps; queue-wait histogram and oldest-eligible-age gauge | Threshold and objective **TBD** from forecast, benchmark, and user expectation; no queue-age number is approved | Operating owner (unassigned) + engineering |
| Run completion latency | `finished_at - eligible_at`, p50/p95/p99 segmented by action type and outcome; report rolling window | Run lifecycle timestamps and run-duration histogram | Separate internal and third-party actions; numeric targets **TBD** after representative measurements | Product owner + engineering |
| Execution success | Completed runs / runs expected to execute, by rolling window; report infrastructure failures separately from business failures and condition-false skips | Run terminal-state counters and expected-execution denominator | Target **TBD**; define eligible population before setting an objective | Product owner + engineering |
| Event durability/accounting | Accepted events eventually reach a documented accounted state: matched, intentionally ignored, rejected, or quarantined | Ingress and terminal event-state counters reconciled by event identity | Correctness invariant; acceptable loss/reconciliation window **TBD** and requires product/engineering approval | Engineering + operating owner (unassigned) |
| Recovery | Time to restore acceptable service, measured for each drill/incident; record data-loss outcome separately | Incident timeline and recovery-drill records | RTO/RPO **TBD** until business impact is agreed and drills provide evidence | Product owner + operating owner (unassigned) |

Every objective adopted later must name the eligible population, numerator/denominator,
measurement window, exclusions, data source, alert/runbook, and accountable owner. Do not
call an internal objective an SLA without product/legal/operations approval. Do not claim
an error budget until its SLO and eligible population are approved.

## 3. Queue and alert measurement

Proposed first-release queue signals:

- oldest eligible run age and queue-wait p50/p95/p99 by queue class;
- enqueue rate, completion rate, backlog growth, and estimated drain time;
- worker saturation and lease-expiry rate;
- oldest pending outbox age and pending outbox count;
- retry and dead-letter rate/age;
- run completion objective burn once an objective is approved.

Queue-depth-only thresholds are not sufficient. Set warning/critical thresholds from a
repeatable benchmark and connect each alert to a severity, runbook, deduplication rule,
and escalation path. The named team/person receiving alerts and operating the queue is
**unassigned**; no paging route or response-time promise is approved.

## 4. Run-history and related data retention

These are options copied from spec §24.2 for review, not a retention decision. Confirm
purpose, data classification, contractual/legal requirements, deletion behavior, storage
cost, and accountable data owner before implementing TTL or cleanup.

| Data | Candidate initial policy | Safeguard | Approval / owner |
|---|---|---|---|
| Run/action history | 30 days searchable in v1; configurable later | Never purge active, retry-wait, or unresolved unknown-outcome work | Product + privacy/security; data owner unassigned |
| Raw event payload/snapshots | Do not store by default; if required, candidate maximum 7 days | Minimize and redact; separate from audit metadata | Product + privacy/security; data owner unassigned |
| Outbox | Keep until publication is confirmed plus a recovery buffer | Reconcile before cleanup; never expire unpublished records by TTL | Engineering + operating owner (unassigned) |
| Inbox/deduplication keys | Longer than the maximum supported replay/redelivery window | Expiry must not permit duplicate side effects | Engineering + product |
| Application logs | Candidate 14–30 days | Redact sensitive data and restrict access | Operating owner + privacy/security (unassigned) |
| Traces | Candidate 7–14 days | Redact attributes; sample successful traces and retain errors under policy | Operating owner + privacy/security (unassigned) |
| Aggregated metrics | Candidate 90 days | Bounded cardinality; extend only if useful and affordable | Operating owner (unassigned) |
| Security/audit evidence | Period not set | Preserve required evidence; define access and deletion exceptions | Security/privacy/legal owner unassigned |

## 5. Ownership and review actions

The repository documents repository governance ownership but does not identify an
Automation Engine operating team or on-call owner. Proposed role assignments below are
responsibility requests, not assignments to named people:

| Decision / action | Required accountable role | Current state |
|---|---|---|
| Supply normal/peak/burst workload forecast and user-facing freshness expectation | Product owner | Unassigned |
| Define event/run eligibility and approve internal service objectives | Product owner + engineering owner | Unassigned |
| Implement instrumentation, benchmark, and report baseline | Engineering/platform owner | Unassigned |
| Accept alerts, operate queue/workers, and own runbooks/escalation | Named operating owner/team | **Unassigned; blocker** |
| Approve data purpose, run-history retention, deletion and audit exceptions | Product + privacy/security (legal if applicable) | Unassigned |
| Review this baseline and record decisions | Engineering, product, and operating owner | Proposed date 2026-10-28; not scheduled |

Before this baseline can be marked accepted, record named owners, fill the workload inputs,
review the measurement contracts and retention choices, benchmark the forecast, and replace
provisional targets only with approved/measured values. Until then, this document is a
reviewable draft and dependent production-readiness work remains blocked.

## References

- [Automation Engine specification §14, §21–§24](../../automation-engine-spec-v2.md)
- [Repository runtime and persistence audit](./repository-audit.md)
- [Automation Engine ADR register](../adr/README.md)
