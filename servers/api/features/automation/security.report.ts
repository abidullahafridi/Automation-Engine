import { isIsoInstant } from "./condition.validation.js";
import {
  evaluateSecurityGate,
  type GateIssue,
  type SecurityFinding,
  type SecurityGateResult
} from "./security.findings.js";

/** The four test cases of AE-T-072.1. */
export const requiredEvidenceIds = Object.freeze(["TC-0721", "TC-0722", "TC-0723", "TC-0724"] as const);

export type TestEvidence = Readonly<{
  testId: string;
  result: "passed" | "failed" | "not-run";
}>;

export type ReviewerApproval = Readonly<{
  reviewer: string;
  approvedAt: string;
  /** What the reviewer reviewed, for example the commit or report version. */
  scope: string;
}>;

export type ReportStatus = "approved" | "pending-review" | "blocked";

export type SecurityReport = Readonly<{
  generatedAt: string;
  status: ReportStatus;
  gate: SecurityGateResult;
  findings: readonly SecurityFinding[];
  evidence: readonly TestEvidence[];
  /** Required test cases that are missing, failed or not run. */
  evidenceGaps: readonly string[];
  approval: ReviewerApproval | undefined;
}>;

const isValidApproval = (approval: ReviewerApproval | undefined): approval is ReviewerApproval =>
  approval !== undefined &&
  approval.reviewer.trim().length > 0 &&
  approval.scope.trim().length > 0 &&
  isIsoInstant(approval.approvedAt);

const findEvidenceGaps = (evidence: readonly TestEvidence[]): readonly string[] => {
  const gaps: string[] = [];
  for (const id of requiredEvidenceIds) {
    const found = evidence.find((item) => item.testId === id);
    if (found === undefined) gaps.push(`${id}: not provided`);
    else if (found.result !== "passed") gaps.push(`${id}: ${found.result}`);
  }
  return Object.freeze(gaps);
};

/**
 * Approved only when the gate passes, every required test case passed and a valid reviewer
 * approval is attached. Anything less is blocked or pending review, never approved.
 */
export const buildSecurityReport = ({
  generatedAt,
  findings,
  evidence,
  approval
}: Readonly<{
  generatedAt: string;
  findings: readonly SecurityFinding[];
  evidence: readonly TestEvidence[];
  approval?: ReviewerApproval;
}>): SecurityReport => {
  const gate = evaluateSecurityGate(findings, generatedAt);
  const evidenceGaps = findEvidenceGaps(evidence);
  const validApproval = isValidApproval(approval) ? approval : undefined;
  const status: ReportStatus = !gate.passed || evidenceGaps.length > 0
    ? "blocked"
    : validApproval === undefined
      ? "pending-review"
      : "approved";
  return Object.freeze({
    generatedAt,
    status,
    gate,
    findings: Object.freeze([...findings]),
    evidence: Object.freeze([...evidence]),
    evidenceGaps,
    approval: validApproval
  });
};

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");

const issueLines = (items: readonly GateIssue[]): readonly string[] =>
  items.length === 0
    ? ["None."]
    : items.map((item) => `- ${cell(item.findingId)} (${item.code}): ${cell(item.message)}`);

export const renderSecurityReportMarkdown = (report: SecurityReport): string => {
  const lines: string[] = [
    "# Security validation report (AE-T-072.1)",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: **${report.status}**`,
    "",
    "## Gate blockers",
    ...issueLines(report.gate.blockers),
    "",
    "## Gate warnings",
    ...issueLines(report.gate.warnings),
    "",
    "## Test evidence",
    "| Test | Result |",
    "| --- | --- |",
    ...report.evidence.map((item) => `| ${cell(item.testId)} | ${item.result} |`),
    "",
    "## Evidence gaps",
    ...(report.evidenceGaps.length === 0 ? ["None."] : report.evidenceGaps.map((gap) => `- ${cell(gap)}`)),
    "",
    "## Findings",
    "| Id | Severity | Status | Owner | Tracking | Title |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.findings.map((item) =>
      `| ${cell(item.id)} | ${item.severity} | ${item.status} | ${cell(item.owner)} | ${cell(item.tracking ?? "-")} | ${cell(item.title)} |`),
    "",
    "## Reviewer sign-off",
    report.approval === undefined
      ? "Pending. No reviewer approval is attached."
      : `Approved by ${cell(report.approval.reviewer)} at ${report.approval.approvedAt} (scope: ${cell(report.approval.scope)}).`,
    ""
  ];
  return lines.join("\n");
};