import { createHash } from "node:crypto";
import { runToolCommand } from "../../tools/command-runner.mjs";
import { ensureManagedTruffleHog, managedToolErrorCode } from "../../tools/managed-trufflehog.mjs";

const parseFindings = (stdout) => {
  if (!stdout.trim()) return [];
  return stdout.trim().split(/\r?\n/).map((line) => {
    const finding = JSON.parse(line);
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("invalid finding");
    }
    return finding;
  });
};

const locationOf = (finding) => {
  const data = finding.SourceMetadata?.Data ?? {};
  const source = data.Filesystem ?? data.Git ?? {};
  return {
    file: source.file ?? source.path ?? "unknown",
    line: Number.isInteger(source.line) ? source.line : null
  };
};

const verificationStatusOf = (finding) => finding.Verified === true
  ? "verified"
  : finding.VerificationError
    ? "unknown"
    : "unverified";

const normalizeFinding = (finding, index) => {
  const detector = typeof finding.DetectorName === "string" ? finding.DetectorName : "unknown";
  const { file, line } = locationOf(finding);
  const verificationStatus = verificationStatusOf(finding);
  const identifier = createHash("sha256")
    .update(`${detector}\0${file}\0${line ?? ""}\0${verificationStatus}\0${index}`)
    .digest("hex")
    .slice(0, 16);
  return { identifier, detector, verificationStatus, file, line };
};

const failure = ({ scanStatus, message, version, durationMs = 0, exitCode = 1, rule = "security-tool-failure" }) => ({
  result: {
    name: "secret-scan",
    engine: "trufflehog",
    version,
    status: "failed",
    scanStatus,
    exitCode,
    durationMs,
    findingCount: 0
  },
  issues: [{ level: "error", rule, tool: "trufflehog", message }]
});

export const runTruffleHogScan = async ({
  workspaceRoot,
  policy,
  commandRunner = runToolCommand,
  toolProvider = ensureManagedTruffleHog
}) => {
  const requiredVersion = policy?.version ?? "unknown";
  if (!policy
    || !/^\d+\.\d+\.\d+$/.test(policy.version ?? "")
    || typeof policy.configuration !== "string"
    || !Array.isArray(policy.resultClasses)
    || policy.resultClasses.length === 0) {
    return failure({
      scanStatus: "invalid_tool",
      version: requiredVersion,
      rule: "security-tool-invalid",
      message: "The repository TruffleHog policy is invalid."
    });
  }
  let tool;
  try {
    tool = await toolProvider({ workspaceRoot, requiredVersion, commandRunner });
  } catch (error) {
    const code = managedToolErrorCode(error);
    const scanStatus = code === "invalid_tool" ? "invalid_tool" : "tool_missing";
    return failure({
      scanStatus,
      version: requiredVersion,
      rule: scanStatus === "invalid_tool" ? "security-tool-invalid" : "security-tool-missing",
      message: error instanceof Error ? error.message : "The managed TruffleHog tool is unavailable."
    });
  }

  let execution;
  try {
    execution = await commandRunner({
      command: tool.command,
      args: [
        "filesystem",
        ".",
        "--json",
        "--fail",
        "--no-update",
        `--results=${policy.resultClasses.join(",")}`,
        "--exclude-paths",
        policy.configuration
      ],
      cwd: workspaceRoot
    });
  } catch {
    return failure({
      scanStatus: "tool_missing",
      version: tool.version,
      rule: "security-tool-missing",
      message: "The managed TruffleHog executable could not start."
    });
  }

  let findings;
  try {
    findings = parseFindings(execution.stdout).map(normalizeFinding);
  } catch {
    return failure({
      scanStatus: "invalid_output",
      version: tool.version,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      rule: "security-output-invalid",
      message: "TruffleHog returned malformed JSON output."
    });
  }

  if (execution.exitCode === 1 || ![0, 183].includes(execution.exitCode)) {
    return failure({
      scanStatus: "scanner_error",
      version: tool.version,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      message: "TruffleHog failed while scanning the repository."
    });
  }
  if (execution.exitCode === 183 && findings.length === 0) {
    return failure({
      scanStatus: "invalid_output",
      version: tool.version,
      durationMs: execution.durationMs,
      exitCode: execution.exitCode,
      rule: "security-output-invalid",
      message: "TruffleHog reported findings without machine-readable result records."
    });
  }

  const issues = findings.map((finding) => ({
    level: "error",
    rule: "secret-detected",
    tool: "trufflehog",
    ...finding,
    message: `TruffleHog detected a ${finding.verificationStatus} ${finding.detector} credential in ${finding.file}${finding.line ? `:${finding.line}` : ""} (id: ${finding.identifier}).`
  }));
  const hasFindings = issues.length > 0;
  return {
    result: {
      name: "secret-scan",
      engine: "trufflehog",
      version: tool.version,
      status: hasFindings ? "failed" : "passed",
      scanStatus: hasFindings ? "findings" : "clean",
      exitCode: execution.exitCode,
      durationMs: execution.durationMs,
      findingCount: issues.length
    },
    issues
  };
};
