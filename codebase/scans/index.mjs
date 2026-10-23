import { runDependencyScan } from "./dependency-scan.mjs";
import { runSecretScan } from "../security/scanner/index.mjs";

export const runWorkspaceScans = async (workspace, dependencies = {}) => {
  const minimumSeverity = workspace.architecture.security?.dependencyAudit?.minimumSeverity ?? "high";
  const secretScanPolicy = workspace.architecture.security?.secretScan;
  const dependencyScanner = dependencies.dependencyScanner ?? runDependencyScan;
  const secretScanner = dependencies.secretScanner ?? runSecretScan;
  const [dependencyScan, secretScan] = await Promise.all([
    dependencyScanner({ workspaceRoot: workspace.root, minimumSeverity, commandRunner: dependencies.commandRunner }),
    secretScanner({ workspaceRoot: workspace.root, policy: secretScanPolicy, commandRunner: dependencies.commandRunner })
  ]);
  const tools = [dependencyScan.result, secretScan.result];
  return {
    ok: tools.every(({ status }) => status === "passed"),
    tools,
    issues: [...dependencyScan.issues, ...secretScan.issues]
  };
};
