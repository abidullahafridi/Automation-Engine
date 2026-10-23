import path from "node:path";
import { pathExists, readJsonFile, toWorkspaceRelativePath } from "../utilities/fs.mjs";

export const projectManifestFileName = "project.json";

export const projectTypes = new Set(["app", "server", "package", "prebuilt", "config"]);

export const projectTypeByRoot = {
  apps: "app",
  servers: "server",
  packages: "package",
  prebuilt: "prebuilt"
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const normalizeTask = ([name, task]) => ({
  name,
  command: typeof task?.command === "string" ? task.command : undefined,
  dependsOn: asArray(task?.dependsOn).filter((dependency) => typeof dependency === "string"),
  inputs: asArray(task?.inputs).filter((input) => typeof input === "string"),
  outputs: asArray(task?.outputs).filter((output) => typeof output === "string"),
  environment: asArray(task?.environment ?? task?.env).filter((name) => typeof name === "string"),
  cache: task?.cache === true
});

export const readProjectManifest = async ({ workspaceRoot, projectRoot, fallbackType }) => {
  const manifestPath = path.join(projectRoot, projectManifestFileName);

  if (!(await pathExists(manifestPath))) {
    return undefined;
  }

  const manifest = await readJsonFile(manifestPath);
  const location = toWorkspaceRelativePath(workspaceRoot, projectRoot);
  const inferredName = location.replaceAll("/", "-");
  const type = typeof manifest.type === "string" ? manifest.type : fallbackType;

  return {
    name: typeof manifest.name === "string" ? manifest.name : inferredName,
    type,
    root: location,
    manifestPath: toWorkspaceRelativePath(workspaceRoot, manifestPath),
    description: typeof manifest.description === "string" ? manifest.description : "",
    internalDependencies: asArray(manifest.internalDependencies).filter(
      (dependency) => typeof dependency === "string"
    ),
    externalDependencies: asArray(manifest.externalDependencies).filter(
      (dependency) => typeof dependency === "string"
    ),
    capabilities: asArray(manifest.capabilities).filter((capability) => typeof capability === "string"),
    tasks: Object.entries(manifest.tasks ?? {}).map(normalizeTask)
  };
};

export const validateProjectManifest = (project) => {
  const issues = [];

  if (!project.name) {
    issues.push({ level: "error", message: `Project at ${project.root} is missing a name.` });
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(project.name)) {
    issues.push({
      level: "error",
      message: `${project.name || project.root} must use a lowercase kebab-case project name.`
    });
  }

  if (!projectTypes.has(project.type)) {
    issues.push({
      level: "error",
      message: `${project.name} uses unsupported project type "${project.type}".`
    });
  }

  for (const task of project.tasks) {
    if (!task.command) {
      issues.push({
        level: "error",
        message: `${project.name}:${task.name} has no command.`
      });
    }

    if (!/^[a-z0-9][a-z0-9:-]*$/.test(task.name)) {
      issues.push({
        level: "error",
        message: `${project.name} has invalid task name "${task.name}".`
      });
    }

    for (const [field, values] of [["input", task.inputs], ["output", task.outputs]]) {
      for (const value of values ?? []) {
        if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) {
          issues.push({ level: "error", message: `${project.name}:${task.name} has invalid ${field} path "${value}".` });
        }
      }
    }

    for (const name of task.environment ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        issues.push({ level: "error", message: `${project.name}:${task.name} has invalid environment variable name "${name}".` });
      }
    }
  }

  return issues;
};
