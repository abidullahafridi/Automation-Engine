import { spawn } from "node:child_process";
import path from "node:path";
import { fingerprintTask, hasReusableTaskResult, recordTaskResult } from "../cache/task-cache.mjs";
import { createTaskResult } from "../contracts/control-plane.mjs";

const runCommand = ({ command, cwd, captureOutput }) => new Promise((resolve, reject) => {
  const child = spawn(command, {
    cwd,
    shell: true,
    env: process.env,
    stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr }));
});

const executeTask = async ({ workspace, task, captureOutput, dependencyFingerprints, ignoredDirectories, commandRunner }) => {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const fingerprint = await fingerprintTask({
    workspaceRoot: workspace.root,
    task,
    dependencyFingerprints,
    ignoredDirectories,
    workspaceConfiguration: workspace.architecture
  });
  dependencyFingerprints.set(task.id, fingerprint);
  if (await hasReusableTaskResult({ workspaceRoot: workspace.root, task, fingerprint })) {
    return createTaskResult({ task: task.id, status: "cached", exitCode: 0, startedAt, durationMs: Date.now() - started });
  }
  let commandResult;
  try {
    commandResult = await commandRunner({
      command: task.command,
      cwd: path.resolve(workspace.root, task.projectRoot),
      captureOutput
    });
  } catch (error) {
    return createTaskResult({
      task: task.id,
      status: "failed",
      exitCode: 1,
      startedAt,
      durationMs: Date.now() - started,
      error: { message: error instanceof Error ? error.message : String(error) }
    });
  }
  await recordTaskResult({ workspaceRoot: workspace.root, task, fingerprint, exitCode: commandResult.exitCode });
  return createTaskResult({
    task: task.id,
    status: commandResult.exitCode === 0 ? "passed" : "failed",
    startedAt,
    durationMs: Date.now() - started,
    ...commandResult
  });
};

export const executePlan = async ({ workspace, plan, dryRun = false, captureOutput = false, concurrency = 1, commandRunner = runCommand }) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Concurrency must be a positive integer.");
  if (dryRun) return plan.map((task) => createTaskResult({
    task: task.id,
    status: "planned",
    command: task.command,
    dependencies: task.taskDependencies
  }));

  const resultsByTask = new Map();
  const dependencyFingerprints = new Map();
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const pending = new Map(plan.map((task) => [task.id, task]));

  while (pending.size > 0) {
    for (const task of pending.values()) {
      const blocking = task.taskDependencies.find((id) => ["failed", "skipped"].includes(resultsByTask.get(id)?.status));
      if (blocking) {
        resultsByTask.set(task.id, createTaskResult({
          task: task.id,
          status: "skipped",
          reason: `Dependency ${blocking} did not succeed.`
        }));
        pending.delete(task.id);
      }
    }

    const ready = [...pending.values()]
      .filter((task) => task.taskDependencies.every((id) => resultsByTask.has(id) || !plan.some((item) => item.id === id)))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, concurrency);
    if (ready.length === 0) {
      for (const task of pending.values()) {
        resultsByTask.set(task.id, createTaskResult({ task: task.id, status: "skipped", reason: "Dependencies could not be resolved." }));
      }
      break;
    }
    const completed = await Promise.all(ready.map((task) => executeTask({
      workspace,
      task,
      captureOutput,
      dependencyFingerprints,
      ignoredDirectories,
      commandRunner
    })));
    completed.forEach((result) => resultsByTask.set(result.task, result));
    ready.forEach((task) => pending.delete(task.id));
  }

  return plan.map((task) => resultsByTask.get(task.id));
};
