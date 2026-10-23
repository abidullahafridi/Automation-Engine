# Workload and SLO Baseline Worksheet (AE-T-001.2)

**Task:** AE-T-001.2 — Establish initial service objectives and workload assumptions
**Status:** Done as a PROVISIONAL baseline; to be re-validated after the AE-E06 load test.
**Operating Owner:** Abid Ullah
**Review Date:** TBD (blank, owner sets)
**Date:** 2026-10-15

---

## 1. Initial Workload Assumptions (Provisional Baseline)

> [!WARNING]
> None of the numbers below are measured from production telemetry. They are provisional planning figures provided by the operating owner to dimension initial queues, rate limits, and test fixtures. They must not be presented as measured capacity.

| Parameter | Value | Status | Source / Rationale |
|---|---|---|---|
| **Peak Event Rate** | 50 events/sec | Provisional | Guess / initial operator forecast for early rollout |
| **Matched Automations / Event** | 2 automations | Provisional | Guess / initial rule density assumption |
| **Actions / Run** | 2 actions | Provisional | Guess / initial action chain length |
| **Initial Tenant Population** | 100 workspaces | Provisional | Guess / rollout cohort assumption |
| **Run-History Retention** | 30 days | Owner-approved proposal | Proposed by owner; privacy review pending |
| **Audit-Log Retention** | ~400 days | Owner-approved proposal | Proposed by owner; privacy review pending |

---

## 2. Derived First-Order Calculation

Using the baseline formula from spec §19:
$$\text{Peak Action Attempts/sec} = \text{Events/sec} \times \text{Automations/Event} \times \text{Actions/Run} \times \text{Attempts/Action}$$

Assuming 1st attempt ($1.0$ nominal attempts/action):
$$\text{Peak Action Attempts/sec} = 50 \times 2 \times 2 \times 1.0 = 200\text{ action invocations/sec}$$

---

## 3. Candidate SLO Indicators & Monitoring Signals

1. **Management API Availability:** $\ge 99.9\%$ monthly (provisional candidate; excluding planned maintenance and 4xx caller errors).
2. **Event Enqueue Latency:** p95 $< 500\text{ ms}$ under nominal load.
3. **Queue Wait Time:** Monitored via oldest-eligible-age gauge and queue-wait duration histogram.
4. **Execution Durability:** $100\%$ domain-event idempotency and accounting (zero silent lost events).
5. **Outbox Ingest Drain:** Oldest pending outbox age $< 5\text{ seconds}$ in steady state.

---

## 4. Re-validation Gate

These assumptions will be re-validated against measured metrics during the **AE-E06 Load & Stress Test** and before any general availability (GA) milestone.

