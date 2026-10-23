import test from "node:test";
import assert from "node:assert/strict";
import { runWorkspaceScans } from "./index.mjs";

const workspace = {
  root: process.cwd(),
  architecture: {
    security: {
      dependencyAudit: { minimumSeverity: "high" },
      secretScan: { version: "3.97.5", configuration: ".trufflehog-exclude-paths.txt", resultClasses: ["verified", "unknown", "unverified"] }
    }
  }
};
const cleanDependencyScan = async () => ({
  result: { name: "dependency-audit", engine: "pnpm audit", status: "passed", exitCode: 0, durationMs: 1, findingCount: 0 },
  issues: []
});
const secretScan = (scanStatus) => async () => ({
  result: {
    name: "secret-scan",
    engine: "trufflehog",
    version: "3.97.5",
    status: scanStatus === "clean" ? "passed" : "failed",
    scanStatus,
    exitCode: scanStatus === "findings" ? 183 : scanStatus === "clean" ? 0 : 1,
    durationMs: 1,
    findingCount: scanStatus === "findings" ? 1 : 0
  },
  issues: scanStatus === "clean" ? [] : [{ level: "error", rule: "fixture", message: scanStatus }]
});

for (const [scanStatus, expected] of [
  ["clean", true],
  ["findings", false],
  ["scanner_error", false],
  ["tool_missing", false]
]) {
  test(`aggregate scan ${scanStatus} produces ok=${expected}`, async () => {
    const result = await runWorkspaceScans(workspace, {
      dependencyScanner: cleanDependencyScan,
      secretScanner: secretScan(scanStatus)
    });
    assert.equal(result.ok, expected);
  });
}
