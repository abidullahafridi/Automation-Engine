import { createHash } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists, walkFiles, writeJsonFile } from "../utilities/fs.mjs";

const isInside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const resolveInputFiles = async ({ workspaceRoot, task, ignoredDirectories }) => {
  const projectRoot = path.resolve(workspaceRoot, task.projectRoot);
  const requestedInputs = task.inputs.length > 0 ? task.inputs : ["."];
  const groups = await Promise.all(requestedInputs.map(async (input) => {
    const target = path.resolve(projectRoot, input);
    if (!isInside(projectRoot, target)) throw new Error(`${task.id} input escapes its project root: ${input}`);
    if (!(await pathExists(target))) return [];
    return walkFiles(target, { ignoredDirectories });
  }));
  const outputPaths = task.outputs.map((output) => path.resolve(projectRoot, output));
  return [...new Set(groups.flat())].filter(
    (filePath) => !outputPaths.some((outputPath) => isInside(outputPath, filePath))
  );
};

export const fingerprintTask = async ({
  workspaceRoot,
  task,
  dependencyFingerprints,
  ignoredDirectories,
  workspaceConfiguration = {},
  environment = process.env
}) => {
  const hash = createHash("sha256");
  const selectedEnvironment = [...(task.environment ?? [])].sort().map((name) => [name, environment[name] ?? null]);
  hash.update(JSON.stringify({
    id: task.id,
    command: task.command,
    dependencies: task.taskDependencies.map((id) => [id, dependencyFingerprints.get(id) ?? null]),
    environment: selectedEnvironment,
    workspaceConfiguration
  }));
  const files = await resolveInputFiles({ workspaceRoot, task, ignoredDirectories });
  for (const filePath of files) {
    hash.update(path.relative(workspaceRoot, filePath));
    hash.update(await readFile(filePath));
  }
  return hash.digest("hex");
};

const cacheEntryPath = (workspaceRoot, task) =>
  path.join(workspaceRoot, ".repo-cache", "tasks", `${task.id.replaceAll(":", "--")}.json`);

const outputsExist = async (workspaceRoot, task) => {
  if (task.outputs.length === 0) return false;
  const projectRoot = path.resolve(workspaceRoot, task.projectRoot);
  const statuses = await Promise.all(task.outputs.map((output) => pathExists(path.resolve(projectRoot, output))));
  return statuses.every(Boolean);
};

export const hasReusableTaskResult = async ({ workspaceRoot, task, fingerprint }) => {
  if (!task.cache || !(await outputsExist(workspaceRoot, task))) return false;
  const entryPath = cacheEntryPath(workspaceRoot, task);
  if (!(await pathExists(entryPath))) return false;
  try {
    const entry = JSON.parse(await readFile(entryPath, "utf8"));
    return entry.fingerprint === fingerprint && entry.exitCode === 0;
  } catch {
    return false;
  }
};

export const recordTaskResult = async ({ workspaceRoot, task, fingerprint, exitCode }) => {
  if (!task.cache || exitCode !== 0) return;
  await writeJsonFile(cacheEntryPath(workspaceRoot, task), {
    task: task.id,
    fingerprint,
    exitCode,
    recordedAt: new Date().toISOString()
  });
};

export const getTaskCachePath = cacheEntryPath;

export const listTaskCacheEntries = async (workspaceRoot) => {
  const root = path.join(workspaceRoot, ".repo-cache", "tasks");
  const files = await walkFiles(root);
  const entries = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    try {
      return { path: path.relative(workspaceRoot, file).split(path.sep).join("/"), valid: true, entry: JSON.parse(await readFile(file, "utf8")) };
    } catch {
      return { path: path.relative(workspaceRoot, file).split(path.sep).join("/"), valid: false, entry: null };
    }
  }));
  return entries.sort((left, right) => left.path.localeCompare(right.path));
};
