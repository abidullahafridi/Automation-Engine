import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const defaultTasksByType = {
  app: {
    dev: { command: "pnpm run dev" },
    build: { command: "pnpm run build" },
    test: { command: "pnpm test" }
  },
  server: {
    dev: { command: "pnpm run dev" },
    build: { command: "pnpm run build" },
    test: { command: "pnpm test" }
  },
  package: {
    build: { command: "pnpm run build" },
    test: { command: "pnpm test" },
    lint: { command: "pnpm run lint" }
  },
  prebuilt: {
    check: { command: "pnpm run check" }
  },
  config: {}
};

export const createProjectManifest = ({ name, type, description = "" }) => ({
  name,
  type,
  description,
  internalDependencies: [],
  externalDependencies: [],
  capabilities: [],
  tasks: defaultTasksByType[type] ?? {}
});

export const generateProject = async ({ workspaceRoot, architecture, name, type }) => {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Project name must be lowercase kebab-case.");
  }
  const rootByProjectType = Object.fromEntries(
    Object.entries(architecture.foundation.allowedProjectTypesByRoot ?? {})
      .flatMap(([rootName, projectTypes]) => projectTypes.map((projectType) => [projectType, rootName]))
  );
  for (const [rootName, projectType] of Object.entries(architecture.foundation.projectRoots)) {
    rootByProjectType[projectType] ??= rootName;
  }
  const rootName = rootByProjectType[type];

  if (!rootName) {
    throw new Error(`Unsupported project type: ${type}`);
  }

  const projectRoot = path.join(workspaceRoot, rootName, name);
  await mkdir(projectRoot, { recursive: true });

  const manifest = createProjectManifest({ name, type });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(projectRoot, "project.json"), manifestText, { flag: "wx" });

  return { root: projectRoot, manifest };
};
