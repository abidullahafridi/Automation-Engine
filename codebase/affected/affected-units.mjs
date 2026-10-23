import path from "node:path";
import { toPosixPath } from "../utilities/fs.mjs";
import { createDependencyGraph, topologicalProjectOrder } from "../graph/dependency-graph.mjs";

const normalizeChangedPath = (workspaceRoot, changedPath) => {
  const absolute = path.isAbsolute(changedPath) ? changedPath : path.resolve(workspaceRoot, changedPath);
  const relative = toPosixPath(path.relative(workspaceRoot, absolute));
  return relative.startsWith("../") || relative === ".." ? undefined : relative;
};

export const findOwningWorkspaceUnit = ({ projects, filePath }) => {
  const normalized = toPosixPath(filePath);
  return projects
    .filter((project) => normalized === project.root || normalized.startsWith(`${project.root}/`))
    .sort((left, right) => right.root.length - left.root.length || left.name.localeCompare(right.name))[0];
};

export const createReverseDependencyMap = (projects) => {
  const reverse = new Map(projects.map((project) => [project.name, []]));
  for (const project of projects) {
    for (const dependency of project.internalDependencies) {
      if (reverse.has(dependency)) reverse.set(dependency, [...reverse.get(dependency), project.name].sort());
    }
  }
  return reverse;
};

export const findAffectedWorkspaceUnits = ({ workspace, changedFiles }) => {
  const normalizedFiles = [...new Set(changedFiles
    .map((file) => normalizeChangedPath(workspace.root, file))
    .filter(Boolean))].sort();
  const changes = normalizedFiles.map((file) => ({
    path: file,
    owner: findOwningWorkspaceUnit({ projects: workspace.projects, filePath: file })?.name ?? null
  }));
  const globalPrefixes = ["codebase/", "enablers/", ".github/", ".agent/", ".project/"];
  const globalFiles = new Set(["architecture.yaml", "package.json", "AGENTS.md", "CLAUDE.md"]);
  const globalChange = changes.some(({ path: file }) => globalFiles.has(file) || globalPrefixes.some((prefix) => file.startsWith(prefix)));
  const affected = new Set(globalChange ? workspace.projects.map((project) => project.name) : changes.map((change) => change.owner).filter(Boolean));
  const reverse = createReverseDependencyMap(workspace.projects);
  const pending = [...affected].sort();
  while (pending.length > 0) {
    const dependency = pending.shift();
    for (const dependent of reverse.get(dependency) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        pending.push(dependent);
        pending.sort();
      }
    }
  }
  const order = topologicalProjectOrder(createDependencyGraph(workspace.projects));
  const deterministicOrder = [...order.ordered, ...order.cycles.sort()];
  return {
    changedFiles: changes,
    globalChange,
    units: deterministicOrder.filter((name) => affected.has(name))
  };
};
