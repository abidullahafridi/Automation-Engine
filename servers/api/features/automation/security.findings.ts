import { isIsoInstant } from "./condition.validation.js";

export const severityLevels = Object.freeze(["critical", "high", "medium", "low"] as const);
export type Severity = (typeof severityLevels)[number];

export const findingStatuses = Object.freeze(["open", "fixed", "false-positive", "accepted-risk"] as const);
export type FindingStatus = (typeof findingStatuses)[number];

export const findingSources = Object.freeze([
  "threat-model",
  "tenant-test",
  "redaction-test",
  "dependency-scan",
  "code-review"
] as const);
export type FindingSource = (typeof findingSources)[number];

/** AE-US-072: a temporarily accepted risk needs owner, impact, review date, mitigation and rollback trigger. */
export type RiskException = Readonly<{
  approver: string;
  owner: string;
  impact: string;
  mitigation: string;
  rollbackTrigger: string;
  approvedAt: string;
  reviewBy: string;
}>;

export type SecurityFinding = Readonly<{
  id: string;
  title: string;
  severity: Severity;
  source: FindingSource;
  owner: string;
  status: FindingStatus;
  /** File, test id or document that supports the status. Required for every finding. */
  evidence: string;
  /** Backlog task or gate that resolves the finding. */
  tracking?: string;
  exception?: RiskException;
}>;

export type GateBlockCode =
  | "INVALID_FINDING"
  | "DUPLICATE_ID"
  | "UNRESOLVED"
  | "EXCEPTION_INCOMPLETE"
  | "EXCEPTION_EXPIRED"
  | "INVALID_TIME";

export type GateIssue = Readonly<{
  findingId: string;
  code: GateBlockCode;
  /** Static, safe text. */
  message: string;
}>;

export type SecurityGateResult = Readonly<{
  passed: boolean;
  blockers: readonly GateIssue[];
  warnings: readonly GateIssue[];
  /** Findings that are still open, per severity. */
  unresolved: Readonly<Record<Severity, number>>;
}>;

const isHighRisk = (severity: Severity): boolean => severity === "critical" || severity === "high";

const filled = (value: string): boolean => value.trim().length > 0;

const isValidFinding = (finding: SecurityFinding): boolean =>
  filled(finding.id) &&
  filled(finding.title) &&
  filled(finding.owner) &&
  filled(finding.evidence) &&
  severityLevels.includes(finding.severity) &&
  findingStatuses.includes(finding.status) &&
  findingSources.includes(finding.source);

type ExceptionCheck = Readonly<{ incomplete: boolean; expired: boolean }>;

const checkException = (exception: RiskException, nowMs: number): ExceptionCheck => {
  const complete =
    filled(exception.approver) &&
    filled(exception.owner) &&
    filled(exception.impact) &&
    filled(exception.mitigation) &&
    filled(exception.rollbackTrigger) &&
    isIsoInstant(exception.approvedAt) &&
    isIsoInstant(exception.reviewBy) &&
    Date.parse(exception.reviewBy) > Date.parse(exception.approvedAt);
  if (!complete) return Object.freeze({ incomplete: true, expired: false });
  return Object.freeze({ incomplete: false, expired: Date.parse(exception.reviewBy) <= nowMs });
};

const issue = (findingId: string, code: GateBlockCode, message: string): GateIssue =>
  Object.freeze({ findingId, code, message });

/**
 * Release rule (AE-US-072, AE-T-072.1): no critical or high finding may be left unresolved.
 * Resolved means fixed, false positive with evidence, or accepted under a complete, unexpired exception.
 * Pure and fail-closed: an invalid clock blocks everything.
 */
export const evaluateSecurityGate = (
  findings: readonly SecurityFinding[],
  now: string
): SecurityGateResult => {
  const unresolved: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  if (!isIsoInstant(now)) {
    return Object.freeze({
      passed: false,
      blockers: Object.freeze([issue("*", "INVALID_TIME", "The evaluation time is not a valid instant.")]),
      warnings: Object.freeze([]),
      unresolved: Object.freeze(unresolved)
    });
  }
  const nowMs = Date.parse(now);
  const blockers: GateIssue[] = [];
  const warnings: GateIssue[] = [];
  const seen = new Set<string>();

  for (const finding of findings) {
    if (!isValidFinding(finding)) {
      blockers.push(issue(finding.id, "INVALID_FINDING", "Finding is missing an id, title, owner or evidence."));
      continue;
    }
    if (seen.has(finding.id)) {
      blockers.push(issue(finding.id, "DUPLICATE_ID", "Finding id is used more than once."));
      continue;
    }
    seen.add(finding.id);

    const high = isHighRisk(finding.severity);
    const report = (code: GateBlockCode, message: string): void => {
      (high ? blockers : warnings).push(issue(finding.id, code, message));
    };

    switch (finding.status) {
      case "fixed":
      case "false-positive":
        break;
      case "open":
        unresolved[finding.severity] += 1;
        report("UNRESOLVED", "Finding is open and has no accepted disposition.");
        break;
      case "accepted-risk": {
        if (finding.exception === undefined) {
          report("EXCEPTION_INCOMPLETE", "Accepted risk has no exception record.");
          break;
        }
        const check = checkException(finding.exception, nowMs);
        if (check.incomplete) report("EXCEPTION_INCOMPLETE", "Exception record is incomplete or has invalid dates.");
        else if (check.expired) report("EXCEPTION_EXPIRED", "Exception review date has passed.");
        break;
      }
    }
  }

  return Object.freeze({
    passed: blockers.length === 0,
    blockers: Object.freeze(blockers),
    warnings: Object.freeze(warnings),
    unresolved: Object.freeze(unresolved)
  });
};

const owner = "Abid Ullah";

/**
 * Findings known from the repository documents (backlog statuses, ADR gates, task "Not covered" notes).
 * This is NOT a full review result: the reviewer must extend it. Statuses are kept honest, so the gate
 * fails until the production gates are really closed.
 */
export const knownFindings: readonly SecurityFinding[] = Object.freeze([
  Object.freeze({
    id: "SEC-001",
    title: "No real platform PrincipalResolver/PolicyPort adapter (platform auth location is NONE)",
    severity: "high" as const,
    source: "threat-model" as const,
    owner,
    status: "open" as const,
    evidence: "docs/architecture/platform-auth-contract.md",
    tracking: "AE-T-010.2b"
  }),
  Object.freeze({
    id: "SEC-002",
    title: "Production target is not verified as a replica set, so transactional outbox is unproven",
    severity: "high" as const,
    source: "threat-model" as const,
    owner,
    status: "open" as const,
    evidence: "docs/architecture/evidence/ae-t-000-3-mongodb-transactions-2026-10-15T10-07-18-790Z.json",
    tracking: "AE-T-000.3b"
  }),
  Object.freeze({
    id: "SEC-003",
    title: "Audit database role (find and insert only) is proposed but not applied or verified",
    severity: "high" as const,
    source: "code-review" as const,
    owner,
    status: "open" as const,
    evidence: "audit-records.md",
    tracking: "AE-T-042.2"
  }),
  Object.freeze({
    id: "SEC-004",
    title: "Release control store is in-memory only; flags and kill switch are not durable",
    severity: "medium" as const,
    source: "code-review" as const,
    owner,
    status: "open" as const,
    evidence: "release-gates.md",
    tracking: "AE-T-071.1"
  }),
  Object.freeze({
    id: "SEC-005",
    title: "Action attempt is written after the action returns; a crash mid-action leaves no attempt record",
    severity: "medium" as const,
    source: "code-review" as const,
    owner,
    status: "open" as const,
    evidence: "wiring.md",
    tracking: "AE-T-030.2"
  }),
  Object.freeze({
    id: "SEC-006",
    title: "No real AutomationPauser, so owner access loss cannot auto-pause the automation (spec D-12)",
    severity: "medium" as const,
    source: "code-review" as const,
    owner,
    status: "open" as const,
    evidence: "wiring.md",
    tracking: "AE-T-083.2"
  }),
  Object.freeze({
    id: "SEC-007",
    title: "notification.send permission is checked against the workspace, not the resolved recipient",
    severity: "medium" as const,
    source: "code-review" as const,
    owner,
    status: "open" as const,
    evidence: "notification-action.md",
    tracking: "AE-T-031.2"
  }),
  Object.freeze({
    id: "SEC-008",
    title: "No recorded dependency, secret and SBOM scan evidence for a release build",
    severity: "medium" as const,
    source: "dependency-scan" as const,
    owner,
    status: "open" as const,
    evidence: "automation-engine-backlog.md AE-US-078",
    tracking: "AE-US-078"
  }),
  Object.freeze({
    id: "SEC-009",
    title: "Stale-state precondition (spec D-25) is not implemented; conditions use the event snapshot only",
    severity: "low" as const,
    source: "threat-model" as const,
    owner,
    status: "open" as const,
    evidence: "wiring.md",
    tracking: "AE-E03"
  })
]);