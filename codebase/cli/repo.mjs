#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverWorkspace } from "../workspace/discovery.mjs";
import { createDependencyGraph, topologicalProjectOrder } from "../graph/dependency-graph.mjs";
import { createAffectedExecutionPlan, createExecutionPlan, listTasks } from "../execution/tasks.mjs";
import { executePlan } from "../execution/runner.mjs";
import { runWorkspaceChecks } from "../checks/workspace-checks.mjs";
import { runWorkspaceScans } from "../scans/index.mjs";
import { generateProject } from "../generators/project-generator.mjs";
import { findAffectedWorkspaceUnits } from "../affected/affected-units.mjs";
import { createExecutionPlanContract, createResult } from "../contracts/control-plane.mjs";
import { getExecutionProfile } from "../execution/profiles.mjs";
import { listTaskCacheEntries } from "../cache/task-cache.mjs";

const execFileAsync = promisify(execFile);
const print = (value) => process.stdout.write(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
const hasFlag = (args, name) => args.includes(`--${name}`);
const getOption = (args, name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const getOptions = (args, name) => args.flatMap((value, index) => value === `--${name}` && args[index + 1] ? args[index + 1].split(",") : []);
const requireOption = (args, name) => {
  const value = getOption(args, name);
  if (!value) throw new Error(`Missing required option --${name}`);
  return value;
};

const readGitChangedFiles = async (workspaceRoot) => {
  try {
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      execFileAsync("git", ["diff", "--name-only", "HEAD"], { cwd: workspaceRoot }),
      execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: workspaceRoot })
    ]);
    return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))].sort();
  } catch {
    return [];
  }
};

const getAffected = async (workspace, args) => {
  const explicit = getOptions(args, "changed");
  const changedFiles = explicit.length > 0 ? explicit : await readGitChangedFiles(workspace.root);
  return findAffectedWorkspaceUnits({ workspace, changedFiles });
};

const createPlan = async (workspace, taskName, args) => {
  if (!taskName) throw new Error("Missing task name.");
  const graph = createDependencyGraph(workspace.projects);
  const tasks = listTasks(workspace.projects);
  if (!hasFlag(args, "affected")) {
    return { plan: createExecutionPlan({ graph, projects: workspace.projects, tasks, taskName }), affected: null };
  }
  const affected = await getAffected(workspace, args);
  return {
    affected,
    plan: createAffectedExecutionPlan({ graph, projects: workspace.projects, tasks, taskName, affectedUnits: affected.units })
  };
};

const printIssues = (kind, issues, { json, ...details }) => {
  const result = createResult({ kind, ok: !issues.some((issue) => issue.level === "error"), issues, ...details });
  if (json) print(result);
  else if (issues.length === 0) print("No issues found.\n");
  else issues.forEach((issue) => print(`${issue.level.toUpperCase()}: ${issue.message}\n`));
  process.exitCode = result.ok ? 0 : 1;
  return result;
};

const printScanResult = (scan, json) => {
  if (json) return printIssues("scan-result", scan.issues, { json: true, tools: scan.tools });
  const secretScan = scan.tools.find(({ name }) => name === "secret-scan");
  if (secretScan) {
    print(`Security scan\nScanner: TruffleHog\nVersion: ${secretScan.version}\n\nStatus: ${secretScan.scanStatus.toUpperCase()}\n`);
  }
  return printIssues("scan-result", scan.issues, { json: false, tools: scan.tools });
};

const runTaskCommand = async ({ workspace, args, taskName }) => {
  const { plan, affected } = await createPlan(workspace, taskName, args);
  const results = await executePlan({
    workspace,
    plan,
    dryRun: hasFlag(args, "dry-run"),
    captureOutput: hasFlag(args, "json") || hasFlag(args, "verbose"),
    concurrency: Number(getOption(args, "concurrency") ?? 1)
  });
  const ok = !results.some((result) => ["failed", "skipped"].includes(result.status));
  const output = { kind: "task-execution", ok, task: taskName, affected, results };
  if (hasFlag(args, "json")) print(output);
  else results.forEach((result) => {
    print(`${result.status.toUpperCase()}: ${result.task}\n`);
    if (hasFlag(args, "verbose") && result.stdout) print(result.stdout);
    if (hasFlag(args, "verbose") && result.stderr) process.stderr.write(result.stderr);
  });
  process.exitCode = ok ? 0 : 1;
};

const commands = {
  help: async () => print(`repo commands

  projects [--json]                         List discovered workspace units
  graph [--json]                            Print the internal dependency graph
  affected [--changed <paths>] [--json]     Analyze changed files and affected units
  tasks [--json]                            List workspace tasks
  plan <task> [--affected] [--json]         Print a dependency-ordered task plan
  run <task> [--affected] [--dry-run] [--json] [--verbose] [--concurrency <n>]
  build|test [--affected] [--dry-run] [--json] [--verbose] [--concurrency <n>]
  profile <name> [--dry-run] [--json]       Run local, affected, pull-request, main, or release profile
  check|scan|validate [--json]               Run repository checks
  cache [--json]                             Inspect task cache entries
  generate project --type <type> --name <name>

`),
  projects: async ({ workspace }) => print(workspace.projects),
  graph: async ({ workspace }) => {
    const graph = createDependencyGraph(workspace.projects);
    const order = topologicalProjectOrder(graph);
    print({ ...graph, order: order.ordered, cycles: order.cycles });
  },
  affected: async ({ workspace, args }) => print(await getAffected(workspace, args)),
  tasks: async ({ workspace }) => print(listTasks(workspace.projects)),
  plan: async ({ workspace, args }) => {
    const { plan, affected } = await createPlan(workspace, args[0], args);
    if (hasFlag(args, "json")) print(createExecutionPlanContract({ requestedTasks: [args[0]], tasks: plan, affectedUnits: affected?.units ?? [] }));
    else print(plan);
  },
  run: async ({ workspace, args }) => runTaskCommand({ workspace, args, taskName: args[0] }),
  build: async ({ workspace, args }) => runTaskCommand({ workspace, args, taskName: "build" }),
  test: async ({ workspace, args }) => runTaskCommand({ workspace, args, taskName: "test" }),
  check: async ({ workspace, args }) => printIssues("validation-result", await runWorkspaceChecks(workspace), { json: hasFlag(args, "json") }),
  scan: async ({ workspace, args }) => {
    const scan = await runWorkspaceScans(workspace);
    printScanResult(scan, hasFlag(args, "json"));
  },
  validate: async ({ workspace, args }) => {
    const [checks, scan] = await Promise.all([runWorkspaceChecks(workspace), runWorkspaceScans(workspace)]);
    printIssues("validation-result", [...checks, ...scan.issues], { json: hasFlag(args, "json"), tools: scan.tools });
  },
  profile: async ({ workspace, args }) => {
    const profile = getExecutionProfile(args[0]);
    const profileArgs = profile.affected && !hasFlag(args, "affected") ? [...args, "--affected"] : args;
    const checkResults = await Promise.all(profile.checks.map(async (name) => name === "scan"
      ? runWorkspaceScans(workspace)
      : { issues: await runWorkspaceChecks(workspace), tools: [] }));
    const issues = checkResults.flatMap(({ issues: groupIssues }) => groupIssues);
    const tools = checkResults.flatMap(({ tools: groupTools }) => groupTools);
    const taskResults = [];
    for (const taskName of profile.tasks) {
      if (!listTasks(workspace.projects).some((task) => task.name === taskName)) continue;
      const { plan } = await createPlan(workspace, taskName, profileArgs);
      taskResults.push(...await executePlan({ workspace, plan, dryRun: hasFlag(args, "dry-run"), captureOutput: true, concurrency: Number(getOption(args, "concurrency") ?? 1) }));
    }
    const ok = !issues.some((issue) => issue.level === "error") && !taskResults.some((result) => ["failed", "skipped"].includes(result.status));
    const result = { kind: "execution-profile-result", ok, profile, issues, tools, taskResults };
    if (hasFlag(args, "json")) print(result);
    else {
      print(`${profile.name}: ${ok ? "PASSED" : "FAILED"}\n`);
      issues.forEach((issue) => print(`${issue.level.toUpperCase()}: ${issue.message}\n`));
      taskResults.forEach((item) => print(`${item.status.toUpperCase()}: ${item.task}\n`));
    }
    process.exitCode = ok ? 0 : 1;
  },
  cache: async ({ workspace }) => print({ kind: "cache-inventory", entries: await listTaskCacheEntries(workspace.root) }),
  generate: async ({ workspace, args }) => {
    if (args[0] !== "project") throw new Error(`Unsupported generator target: ${args[0] ?? "(missing)"}`);
    const generated = await generateProject({ workspaceRoot: workspace.root, architecture: workspace.architecture, type: requireOption(args, "type"), name: requireOption(args, "name") });
    print(generated.manifest);
  }
};

const main = async () => {
  const [commandName = "help", ...args] = process.argv.slice(2);
  const command = commands[commandName];
  if (!command) throw new Error(`Unknown command: ${commandName}`);
  await command({ workspace: await discoverWorkspace(), args });
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) print({ kind: "error", ok: false, error: { message } });
  else process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
