# Threat model review and security validation (AE-T-072.1)

**Task:** AE-T-072.1, Run threat-model review and security validation
**Story:** AE-US-072, Complete operational readiness review
**Requirements:** NFR-004, NFR-007, INV-01, INV-07, INV-08; spec 13.2, 13.10, Appendix C
**Owner:** Abid Ullah
**Status:** Tooling and tests implemented; verification pending. **The task is NOT Done**: a reviewer-approved report does not exist yet, and the gate currently fails on open high findings (see below).

## Trust boundaries reviewed (spec 6.3)

| Boundary | Control in code | Verified by |
|---|---|---|
| 1 Client to API | Strict schemas, bounds, 404 for cross-workspace, rate and quota limits | TC-0721 (matrix), API tests |
| 2 Service to database | Resolver-minted `WorkspaceScope` required by every repository; architecture guard | TC-0721, TC-0405 |
| 3 Worker and handlers | Execution principal, creator re-check, fenced writes, idempotency keys | TC-0723 |
| 4 Egress | No outbound HTTP in v1 | Not applicable yet (SSRF controls needed before v1.1) |

## Attack matrix (TC-0721)

Every repository and gateway is exercised with: own workspace, other workspace, forged scope, and (for events and runs) a mismatched workspace id. Only the own workspace may read or change data. Forged scope is refused before any driver call. Covered: automations, runs, run history, outbox, inbox, audit log, recovery idempotency, trigger matcher, action executor.

## Redaction (TC-0722)

Secrets must not reach logs, errors, audit records, validation errors or action results. Covered: key-based redaction, text scrubbing (Bearer, JWT, URL passwords, key=value), error reduction without stack, audit details, validation errors, executor failure results, and a source scan for raw `console` or `.stack` use.

## Permission bypass and replay abuse (TC-0723)

Covered: automation principals cannot retry or replay; missing or read-only permission is non-enumerating and audited; unknown-outcome actions cannot be confirmed away; replay of a completed run is refused; stale revision conflicts; idempotency key reuse with a different payload is refused; a repeated request returns the same replay run; cross-workspace recovery is not found; lifecycle refuses automation principals; the executor re-checks the creator's permission; owner access loss denies execution.

## Findings and exceptions (TC-0724)

`knownFindings` in `security.findings.ts` is the register. `evaluateSecurityGate` rules:

- Critical or high findings must be fixed, a false positive with evidence, or accepted under a complete exception.
- An exception needs approver, owner, impact, mitigation, rollback trigger, approval date and review date. An expired exception blocks again.
- Medium and low open findings are warnings, but still need an owner and evidence.
- Invalid findings, duplicate ids and an invalid clock block the gate.

Current register (from repository documents, not a full review):

| Id | Severity | Status | Tracking |
|---|---|---|---|
| SEC-001 no real auth adapter | high | open | AE-T-010.2b |
| SEC-002 production not a verified replica set | high | open | AE-T-000.3b |
| SEC-003 audit DB role not applied | high | open | AE-T-042.2 |
| SEC-004 release store in-memory | medium | open | AE-T-071.1 |
| SEC-005 no write-ahead action attempt | medium | open | AE-T-030.2 |
| SEC-006 no real automation pauser | medium | open | AE-T-083.2 |
| SEC-007 recipient permission not enforced | medium | open | AE-T-031.2 |
| SEC-008 no dependency and SBOM scan evidence | medium | open | AE-US-078 |
| SEC-009 stale precondition (D-25) missing | low | open | AE-E03 |

The gate fails until SEC-001 to SEC-003 are fixed or formally accepted. That is correct behaviour, not a bug. Do not mark any finding fixed without evidence.

## Report and sign-off

`buildSecurityReport` returns `approved` only if the gate passes, TC-0721 to TC-0724 all passed, and a reviewer approval is attached. Otherwise `blocked` or `pending-review`. `renderSecurityReportMarkdown` produces the report file for `docs/security/`.

Reviewer sign-off: **pending**.

## Not covered (explicit)

- Dependency, secret and image scan results (AE-US-078): no scanner output is recorded here.
- A full independent review: the register contains only what the repository documents show.
- Real database role tests, a penetration test, and the platform adapter (all production gates).
- Mongo-backed matrix runs: the matrix uses the in-memory doubles; the Mongo tenant tests already exist per repository.
- Persisting the generated report file and the reviewer approval record.# Threat model review and security validation (AE-T-072.1)

**Task:** AE-T-072.1, Run threat-model review and security validation
**Story:** AE-US-072, Complete operational readiness review
**Requirements:** NFR-004, NFR-007, INV-01, INV-07, INV-08; spec 13.2, 13.10, Appendix C
**Owner:** Abid Ullah
**Status:** Tooling and tests implemented; verification pending. **The task is NOT Done**: a reviewer-approved report does not exist yet, and the gate currently fails on open high findings (see below).

## Trust boundaries reviewed (spec 6.3)

| Boundary | Control in code | Verified by |
|---|---|---|
| 1 Client to API | Strict schemas, bounds, 404 for cross-workspace, rate and quota limits | TC-0721 (matrix), API tests |
| 2 Service to database | Resolver-minted `WorkspaceScope` required by every repository; architecture guard | TC-0721, TC-0405 |
| 3 Worker and handlers | Execution principal, creator re-check, fenced writes, idempotency keys | TC-0723 |
| 4 Egress | No outbound HTTP in v1 | Not applicable yet (SSRF controls needed before v1.1) |

## Attack matrix (TC-0721)

Every repository and gateway is exercised with: own workspace, other workspace, forged scope, and (for events and runs) a mismatched workspace id. Only the own workspace may read or change data. Forged scope is refused before any driver call. Covered: automations, runs, run history, outbox, inbox, audit log, recovery idempotency, trigger matcher, action executor.

## Redaction (TC-0722)

Secrets must not reach logs, errors, audit records, validation errors or action results. Covered: key-based redaction, text scrubbing (Bearer, JWT, URL passwords, key=value), error reduction without stack, audit details, validation errors, executor failure results, and a source scan for raw `console` or `.stack` use.

## Permission bypass and replay abuse (TC-0723)

Covered: automation principals cannot retry or replay; missing or read-only permission is non-enumerating and audited; unknown-outcome actions cannot be confirmed away; replay of a completed run is refused; stale revision conflicts; idempotency key reuse with a different payload is refused; a repeated request returns the same replay run; cross-workspace recovery is not found; lifecycle refuses automation principals; the executor re-checks the creator's permission; owner access loss denies execution.

## Findings and exceptions (TC-0724)

`knownFindings` in `security.findings.ts` is the register. `evaluateSecurityGate` rules:

- Critical or high findings must be fixed, a false positive with evidence, or accepted under a complete exception.
- An exception needs approver, owner, impact, mitigation, rollback trigger, approval date and review date. An expired exception blocks again.
- Medium and low open findings are warnings, but still need an owner and evidence.
- Invalid findings, duplicate ids and an invalid clock block the gate.

Current register (from repository documents, not a full review):

| Id | Severity | Status | Tracking |
|---|---|---|---|
| SEC-001 no real auth adapter | high | open | AE-T-010.2b |
| SEC-002 production not a verified replica set | high | open | AE-T-000.3b |
| SEC-003 audit DB role not applied | high | open | AE-T-042.2 |
| SEC-004 release store in-memory | medium | open | AE-T-071.1 |
| SEC-005 no write-ahead action attempt | medium | open | AE-T-030.2 |
| SEC-006 no real automation pauser | medium | open | AE-T-083.2 |
| SEC-007 recipient permission not enforced | medium | open | AE-T-031.2 |
| SEC-008 no dependency and SBOM scan evidence | medium | open | AE-US-078 |
| SEC-009 stale precondition (D-25) missing | low | open | AE-E03 |

The gate fails until SEC-001 to SEC-003 are fixed or formally accepted. That is correct behaviour, not a bug. Do not mark any finding fixed without evidence.

## Report and sign-off

`buildSecurityReport` returns `approved` only if the gate passes, TC-0721 to TC-0724 all passed, and a reviewer approval is attached. Otherwise `blocked` or `pending-review`. `renderSecurityReportMarkdown` produces the report file for `docs/security/`.

Reviewer sign-off: **pending**.

## Not covered (explicit)

- Dependency, secret and image scan results (AE-US-078): no scanner output is recorded here.
- A full independent review: the register contains only what the repository documents show.
- Real database role tests, a penetration test, and the platform adapter (all production gates).
- Mongo-backed matrix runs: the matrix uses the in-memory doubles; the Mongo tenant tests already exist per repository.
- Persisting the generated report file and the reviewer approval record.