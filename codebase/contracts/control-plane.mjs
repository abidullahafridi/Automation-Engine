/**
 * Control-plane contracts are plain JSON-compatible records. These factories
 * provide stable field names without introducing runtime classes.
 */
export const contractNames = Object.freeze([
  "workspace",
  "workspace-unit",
  "dependency",
  "task",
  "task-result",
  "execution-plan",
  "cache-entry",
  "validation-result",
  "tool-result",
  "scan-result"
]);

export const controlPlaneContracts = Object.freeze({
  workspace: ["root", "architecture", "roots", "projects"],
  "workspace-unit": ["name", "type", "root", "internalDependencies", "externalDependencies", "capabilities", "tasks"],
  dependency: ["from", "to", "valid"],
  task: ["id", "project", "projectRoot", "name", "command", "dependsOn", "inputs", "outputs", "environment", "cache"],
  "task-result": ["task", "status", "exitCode"],
  "execution-plan": ["kind", "requestedTasks", "affectedUnits", "tasks"],
  "cache-entry": ["task", "fingerprint", "exitCode", "recordedAt"],
  "validation-result": ["kind", "ok", "issues"],
  "tool-result": ["name", "engine", "version", "status", "scanStatus", "exitCode", "durationMs", "findingCount"],
  "scan-result": ["kind", "ok", "tools", "issues"]
});

export const createResult = ({ kind, ok, issues = [], ...details }) => ({
  kind,
  ok,
  issues,
  ...details
});

export const createTaskResult = ({ task, status, exitCode = null, ...details }) => ({
  task,
  status,
  exitCode,
  ...details
});

export const createExecutionPlanContract = ({ requestedTasks, tasks, affectedUnits = [] }) => ({
  kind: "execution-plan",
  requestedTasks,
  affectedUnits,
  tasks
});
