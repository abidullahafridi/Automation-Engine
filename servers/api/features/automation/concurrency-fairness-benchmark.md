# Concurrency, Fairness and Load Benchmark Report (AE-T-061.1)

**Task:** AE-T-061.1 — Load-test and tune concurrency/fairness controls
**Story:** AE-US-061 — Prevent a noisy workspace starving others
**Requirements:** NFR-005, NFR-010, FR-020; Spec D-28, §11.4, §18, §19
**Owner:** Abid Ullah
**Date:** 2026-10-19
**Commit:** <commit-hash>
**Command:** `pnpm --filter @workspace/api exec tsx --test features/automation/tests/concurrency-fairness.test.ts`
**Full suite:** `ALLOW_NON_PROD=yes MONGO_URI="mongodb://localhost:27017/nutshyll_test?replicaSet=rs0" pnpm --filter @workspace/api test` → **304 pass, 0 fail, 0 skipped**

---

## 1. Hardware & Configuration

- **Host:** x86_64, Windows 11, Node.js 24.x, MongoDB 8.x (replica set `rs0`)
- **Worker:** `maxPerWorkspace=4`, `maxTotal=16`, `leaseDurationMs=60_000`, `renewIntervalMs=20_000`
- **Quota:** events 600/min/ws (6,000/min global), runs 300/min/ws (3,000/min global)
- **Retry:** base 1,000ms, max 60,000ms, maxAge 300,000ms

---

## 2. Measured Results

| TC | Workload | Measured Result | Target | Pass |
|---|---|---|---|---|
| TC-0611 | 100 burst runs, 16 worker slots | drained in **35.46 ms** (isolated), **23.68 ms** (repeat) | < 200 ms | ✅ |
| TC-0612 | heavy: 50 runs, quiet-1: 10, quiet-2: 10 | heavy capped at 4 concurrent; quiet each admitted round-robin, first quiet run started within **< 5 ms** | quiet progress < 100 ms | ✅ |
| TC-0613 | provider 429, `Retry-After: 5` | next attempt at **5,000 ms + jitter**, capped at 60,000 ms; no amplification | ≥ 5,000 ms, bounded | ✅ |
| TC-0614 | 5 in-flight runs, shutdown grace 5,000 ms | 3 drained, 2 requeued with `interruptedReason=WORKER_SHUTDOWN`; **0 acknowledged work lost** | 0 lost | ✅ |

---

## 3. Bottlenecks

1. **Per-process concurrency cap (16):** stable event-loop lag < 10 ms under simulation; beyond 16, queue wait grows linearly — accepted limit.
2. **Provider 429:** bounded by `Retry-After` + jitter; retry amplification capped at 1 attempt per delay — accepted.
3. **Lease recovery:** expired leases recovered without duplicate execution via fencing tokens — accepted.

---

## 4. Accepted Limits

- `maxTotal = 16`, `maxPerWorkspace = 4` per worker process
- Provider retry amplification ≤ 1 per scheduled delay
- Lease TTL 60 s, renew 20 s