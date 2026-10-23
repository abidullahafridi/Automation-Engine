import path from "node:path";
import { pathExists, walkFiles } from "../utilities/fs.mjs";
import { projectManifestFileName, readProjectManifest } from "../projects/manifest.mjs";
import { createArchitectureContext, readArchitecture } from "../configuration/architecture.mjs";

export const workspaceRoots = [
  "apps",
  "servers",
  "packages",
  "prebuilt",
  "codebase",
  "enablers",
  ".agent",
  ".project",
  ".github"
];

export const projectRoots = ["apps", "servers", "packages", "prebuilt"];

const discoverProjectManifests = async ({ workspaceRoot, projectRootName, fallbackType, ignoredDirectories }) => {
  const rootPath = path.join(workspaceRoot, projectRootName);
  const files = await walkFiles(rootPath, { ignoredDirectories });
  const projectDirectories = files
    .filter((filePath) => path.basename(filePath) === projectManifestFileName)
    .map((manifestPath) => path.dirname(manifestPath));
  const projects = await Promise.all(
    projectDirectories.map((projectRoot) =>
      readProjectManifest({ workspaceRoot, projectRoot, fallbackType })
    )
  );

  return projects.filter(Boolean);
};

export const discoverWorkspace = async ({ workspaceRoot = process.cwd() } = {}) => {
  const architecture = await readArchitecture(workspaceRoot);
  const context = createArchitectureContext(architecture);
  const rootStatuses = await Promise.all(
    context.requiredRoots.map(async (rootName) => ({
      name: rootName,
      path: path.join(workspaceRoot, rootName),
      exists: await pathExists(path.join(workspaceRoot, rootName))
    }))
  );

  const projectsByRoot = await Promise.all(
    context.projectRoots.map((projectRootName) =>
      discoverProjectManifests({
        workspaceRoot,
        projectRootName,
        fallbackType: context.projectTypeByRoot[projectRootName],
        ignoredDirectories: context.ignoredDirectories
      })
    )
  );

  const projects = projectsByRoot.flat().sort((a, b) => a.name.localeCompare(b.name));

  return {
    root: workspaceRoot,
    architecture,
    roots: rootStatuses,
    projects
  };
};
