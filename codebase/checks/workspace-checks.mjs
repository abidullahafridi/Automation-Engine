import path from "node:path";
import { readFile } from "node:fs/promises";
import { projectManifestFileName, validateProjectManifest } from "../projects/manifest.mjs";
import { workspaceRoots } from "../workspace/discovery.mjs";
import { createDependencyGraph, findGraphIssues, topologicalProjectOrder } from "../graph/dependency-graph.mjs";
import { pathExists, readJsonFile, walkFiles } from "../utilities/fs.mjs";
import { validateArchitectureBoundaries } from "../validators/architecture-boundaries.mjs";
import { createExecutionPlan, listTasks } from "../execution/tasks.mjs";
import { validateArchitectureConfiguration } from "../configuration/architecture.mjs";
import { checkGitGovernance } from "./git-governance.mjs";

export const checkWorkspaceStructure = async (workspace) => {
  const missingRoots = workspace.roots
    .filter((root) => !root.exists)
    .map((root) => ({ level: "error", message: `Missing required root directory: ${root.name}` }));

  const requiredFiles = Array.isArray(workspace.architecture.foundation?.requiredFiles)
    ? workspace.architecture.foundation.requiredFiles
    : [];
  const rootFileStatuses = await Promise.all(
    requiredFiles.map(async (fileName) => ({
      fileName,
      exists: await pathExists(path.join(workspace.root, fileName))
    }))
  );

  const missingRootFiles = rootFileStatuses
    .filter((file) => !file.exists)
    .map((file) => ({ level: "error", message: `Missing required root file: ${file.fileName}` }));

  return [...missingRoots, ...missingRootFiles];
};

export const checkProjectManifests = (workspace) =>
  workspace.projects.flatMap((project) => validateProjectManifest(project));

export const checkMissingProjectManifests = async (workspace) => {
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const knownRoots = workspace.projects.map((project) => path.resolve(workspace.root, project.root));
  const projectRootNames = Object.keys(workspace.architecture.foundation?.projectRoots ?? {});
  const files = (await Promise.all(projectRootNames.map((rootName) =>
    walkFiles(path.join(workspace.root, rootName), { ignoredDirectories })
  ))).flat();
  return files
    .filter((file) => path.basename(file) === "package.json")
    .filter((file) => !knownRoots.some((root) => {
      const relative = path.relative(root, file);
      return relative === "package.json" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }))
    .map((file) => ({
      level: "error",
      message: `Workspace unit package ${path.relative(workspace.root, file).split(path.sep).join("/")} has no ${projectManifestFileName}.`
    }));
};

export const checkProjectRegistry = (workspace) => {
  const issues = [];
  const projectsByName = new Map();
  const expectedTypes = workspace.architecture.foundation?.projectRoots ?? {};
  const allowedTypesByRoot = workspace.architecture.foundation?.allowedProjectTypesByRoot ?? {};

  for (const project of workspace.projects) {
    const existing = projectsByName.get(project.name);
    if (existing) {
      issues.push({ level: "error", message: `Duplicate project name ${project.name}: ${existing.root} and ${project.root}.` });
    } else {
      projectsByName.set(project.name, project);
    }
    const rootName = project.root.split("/")[0];
    if (project.root.startsWith("../") || path.isAbsolute(project.root)) {
      issues.push({ level: "error", message: `${project.name} has invalid workspace path ${project.root}.` });
    }
    const allowedTypes = allowedTypesByRoot[rootName] ?? [expectedTypes[rootName]].filter(Boolean);
    if (!allowedTypes.includes(project.type)) {
      issues.push({ level: "error", message: `${project.name} is type ${project.type} but its root ${rootName}/ allows ${allowedTypes.join(", ") || "no project type"}.` });
    }
    if (project.internalDependencies.includes(project.name)) {
      issues.push({ level: "error", message: `${project.name} cannot depend on itself.` });
    }
    for (const field of ["internalDependencies", "externalDependencies", "capabilities"]) {
      const values = project[field];
      if (new Set(values).size !== values.length) {
        issues.push({ level: "error", message: `${project.name} contains duplicate values in ${field}.` });
      }
    }
  }
  const taskIds = listTasks(workspace.projects).map((task) => task.id);
  for (const duplicate of taskIds.filter((id, index) => taskIds.indexOf(id) !== index)) {
    issues.push({ level: "error", message: `Duplicate task id ${duplicate}.` });
  }
  return issues;
};

export const checkDependencyGraph = (workspace) => {
  const graph = createDependencyGraph(workspace.projects);
  const graphIssues = findGraphIssues(graph);
  const order = topologicalProjectOrder(graph);
  const cycleIssues = order.cycles.map((name) => ({
    level: "error",
    message: `Project dependency cycle includes ${name}.`
  }));

  return [...graphIssues, ...cycleIssues];
};

export const checkReservedControlPlaneDependencies = async (workspace) => {
  const disallowed = new Set(workspace.architecture.foundation?.disallowedOrchestrators ?? []);
  const packageJsonPath = path.join(workspace.root, "package.json");

  if (!(await pathExists(packageJsonPath))) {
    return [];
  }

  const packageJson = await readJsonFile(packageJsonPath);
  const dependencyNames = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {})
  ];

  return dependencyNames
    .filter((name) => disallowed.has(name))
    .map((name) => ({
      level: "error",
      message: `Disallowed monorepo orchestration dependency found in root package.json: ${name}`
    }));
};

const readPnpmWorkspacePatterns = (source) => {
  const packageBlock = source.match(/^packages:\s*\r?\n((?:\s{2,}.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  return [...packageBlock.matchAll(/^\s*-\s*["']?([^"'\r\n]+)["']?\s*$/gm)].map((match) => match[1]);
};

const readPnpmAllowedBuilds = (source) => {
  const allowBuildsBlock = source.match(/^allowBuilds:\s*\r?\n((?:\s{2,}.*(?:\r?\n|$))*)/m)?.[1] ?? "";
  return [...allowBuildsBlock.matchAll(/^\s{2}([^:\r\n]+):\s*true\s*$/gm)].map((match) => match[1]);
};

export const checkPackageManagerArchitecture = async (workspace) => {
  const policy = workspace.architecture.packageManagement ?? {};
  const issues = [];
  const rootPackagePath = path.join(workspace.root, "package.json");
  const rootPackage = await readJsonFile(rootPackagePath);
  const expectedPackageManager = `${policy.manager}@${policy.packageManagerVersion}`;

  if (rootPackage.packageManager !== expectedPackageManager) {
    issues.push({ level: "error", message: `Root package.json must declare packageManager ${expectedPackageManager}.` });
  }
  if (rootPackage.workspaces !== undefined) {
    issues.push({ level: "error", message: "Root package.json contains a stale npm workspaces field; pnpm-workspace.yaml owns workspace discovery." });
  }
  for (const [name, command] of Object.entries(rootPackage.scripts ?? {})) {
    if (/\bnpm(?:\.cmd)?\b/.test(command)) {
      issues.push({ level: "error", message: `Root script ${name} contains a stale npm command.` });
    }
  }

  const workspaceFilePath = path.join(workspace.root, policy.workspaceFile ?? "pnpm-workspace.yaml");
  if (!(await pathExists(workspaceFilePath))) {
    issues.push({ level: "error", message: `Missing pnpm workspace file: ${policy.workspaceFile ?? "pnpm-workspace.yaml"}.` });
  } else {
    const workspaceSource = await readFile(workspaceFilePath, "utf8");
    const actualPatterns = readPnpmWorkspacePatterns(workspaceSource);
    const expectedPatterns = policy.workspacePatterns ?? [];
    if (actualPatterns.length !== expectedPatterns.length || expectedPatterns.some((pattern) => !actualPatterns.includes(pattern))) {
      issues.push({ level: "error", message: "pnpm-workspace.yaml patterns do not match architecture.packageManagement.workspacePatterns." });
    }
    const actualAllowedBuilds = readPnpmAllowedBuilds(workspaceSource);
    const expectedAllowedBuilds = policy.allowedBuildDependencies ?? [];
    if (actualAllowedBuilds.length !== expectedAllowedBuilds.length
      || expectedAllowedBuilds.some((dependency) => !actualAllowedBuilds.includes(dependency))) {
      issues.push({ level: "error", message: "pnpm-workspace.yaml allowBuilds does not match architecture.packageManagement.allowedBuildDependencies." });
    }
  }

  if (!(await pathExists(path.join(workspace.root, policy.lockfile ?? "pnpm-lock.yaml")))) {
    issues.push({ level: "error", message: `Missing pnpm lockfile: ${policy.lockfile ?? "pnpm-lock.yaml"}.` });
  }
  for (const lockfile of policy.forbiddenLockfiles ?? []) {
    if (await pathExists(path.join(workspace.root, lockfile))) {
      issues.push({ level: "error", message: `Conflicting package-manager lockfile exists: ${lockfile}.` });
    }
  }

  const packageMetadata = new Map();
  for (const project of workspace.projects) {
    const packagePath = path.join(workspace.root, project.root, "package.json");
    if (await pathExists(packagePath)) packageMetadata.set(project.name, await readJsonFile(packagePath));
    for (const task of project.tasks ?? []) {
      if (task.command && !task.command.startsWith("pnpm ")) {
        issues.push({ level: "error", message: `${project.name}:${task.name} must execute through pnpm.` });
      }
    }
  }

  const packageNameByProject = new Map([...packageMetadata].flatMap(([projectName, packageJson]) =>
    typeof packageJson.name === "string" ? [[projectName, packageJson.name]] : []));
  for (const project of workspace.projects) {
    const packageJson = packageMetadata.get(project.name);
    if (!packageJson) continue;
    const dependencyEntries = Object.assign(
      {},
      packageJson.dependencies ?? {},
      packageJson.devDependencies ?? {},
      packageJson.optionalDependencies ?? {}
    );
    for (const dependencyProject of project.internalDependencies ?? []) {
      const dependencyPackageName = packageNameByProject.get(dependencyProject);
      const version = dependencyPackageName ? dependencyEntries[dependencyPackageName] : undefined;
      if (typeof version !== "string" || !version.startsWith(policy.internalDependencyProtocol ?? "workspace:")) {
        issues.push({
          level: "error",
          message: `${project.name} must declare internal dependency ${dependencyPackageName ?? dependencyProject} using ${policy.internalDependencyProtocol ?? "workspace:"}.`
        });
      }
    }
  }

  return issues;
};

const typeScriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const explicitAnyPatterns = [
  /:\s*any\b/,
  /\bas\s+any\b/,
  /=\s*any\b/,
  /<\s*any\s*>/,
  /\bany\s*\[\s*\]/,
  /\b(?:Array|Promise|ReadonlyArray|Record)\s*<[^>\n]*\bany\b/
];

export const checkTypeScriptConfiguration = async (workspace) => {
  const policy = workspace.architecture.typescript ?? {};
  const requiredOptions = policy.requiredCompilerOptions ?? [];
  const forbiddenOptions = policy.forbiddenCompilerOptions ?? [];
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const sharedConfigProjectName = policy.sharedConfigProject;
  const sharedConfigProject = workspace.projects.find((project) => project.name === sharedConfigProjectName);
  const usesSharedPolicy = typeof sharedConfigProjectName === "string";
  const sharedIssues = [];

  if (usesSharedPolicy && (!sharedConfigProject || sharedConfigProject.type !== "config")) {
    sharedIssues.push({ level: "error", message: `TypeScript shared config project ${sharedConfigProjectName} must be registered as type config.` });
  }
  if (sharedConfigProject) {
    const sharedConfigRoot = path.join(workspace.root, sharedConfigProject.root);
    const policyConfigFile = policy.policyConfigFile ?? "base.json";
    const policyConfigPath = path.join(sharedConfigRoot, policyConfigFile);
    if (!(await pathExists(policyConfigPath))) {
      sharedIssues.push({ level: "error", message: `TypeScript policy config is missing: ${path.relative(workspace.root, policyConfigPath).split(path.sep).join("/")}.` });
    } else {
      const policyConfig = await readJsonFile(policyConfigPath);
      const compilerOptions = policyConfig.compilerOptions ?? {};
      for (const option of requiredOptions) {
        if (compilerOptions[option] !== true) {
          sharedIssues.push({ level: "error", message: `Shared TypeScript policy must enable compilerOptions.${option}.` });
        }
      }
      for (const option of forbiddenOptions) {
        if (compilerOptions[option] !== undefined) {
          sharedIssues.push({ level: "error", message: `Shared TypeScript policy must not set compilerOptions.${option}.` });
        }
      }
    }
    for (const presetFile of policy.presetConfigFiles ?? []) {
      const presetPath = path.join(sharedConfigRoot, presetFile);
      if (!(await pathExists(presetPath))) {
        sharedIssues.push({ level: "error", message: `Shared TypeScript preset is missing: ${presetFile}.` });
        continue;
      }
      const preset = await readJsonFile(presetPath);
      if (preset.extends !== `./${policyConfigFile}`) {
        sharedIssues.push({ level: "error", message: `Shared TypeScript preset ${presetFile} must extend ./${policyConfigFile}.` });
      }
      for (const option of forbiddenOptions) {
        if (preset.compilerOptions?.[option] !== undefined) {
          sharedIssues.push({ level: "error", message: `Shared TypeScript preset ${presetFile} must not set compilerOptions.${option}.` });
        }
      }
    }
  }

  const projectResults = await Promise.all(workspace.projects.map(async (project) => {
    const projectRoot = path.join(workspace.root, project.root);
    const files = await walkFiles(projectRoot, { ignoredDirectories });
    const hasTypeScript = files.some((file) => typeScriptExtensions.has(path.extname(file)));
    if (!hasTypeScript) return [];

    const tsconfigPath = path.join(projectRoot, "tsconfig.json");
    if (!(await pathExists(tsconfigPath))) {
      return [{ level: "error", message: `${project.name} contains TypeScript but has no tsconfig.json.` }];
    }

    const tsconfig = await readJsonFile(tsconfigPath);
    const compilerOptions = tsconfig.compilerOptions ?? {};
    const expectedExtends = policy.approvedExtendsByProjectType?.[project.type];
    const inheritanceIssues = usesSharedPolicy && expectedExtends && tsconfig.extends !== expectedExtends
      ? [{ level: "error", message: `${project.name} tsconfig.json must extend ${expectedExtends}.` }]
      : [];
    const requiredOptionIssues = requiredOptions
      .filter((option) => usesSharedPolicy ? compilerOptions[option] === false : compilerOptions[option] !== true)
      .map((option) => ({
        level: "error",
        message: usesSharedPolicy
          ? `${project.name} tsconfig.json must not disable compilerOptions.${option}.`
          : `${project.name} tsconfig.json must explicitly enable compilerOptions.${option}.`
      }));
    const forbiddenOptionIssues = forbiddenOptions
      .filter((option) => compilerOptions[option] !== undefined)
      .map((option) => ({
        level: "error",
        message: `${project.name} tsconfig.json must not set compilerOptions.${option}.`
      }));
    return [...inheritanceIssues, ...requiredOptionIssues, ...forbiddenOptionIssues];
  }));

  return [...sharedIssues, ...projectResults.flat()];
};

export const checkUiRegistryWorkflow = async (workspace) => {
  const policy = workspace.architecture.uiComposition ?? {};
  const project = workspace.projects.find((candidate) => candidate.name === policy.packageProject);
  if (!project) return [{ level: "error", message: `UI package project ${policy.packageProject ?? "(missing)"} is not registered.` }];

  const issues = [];
  const packageRoot = path.join(workspace.root, project.root);
  const packageJson = await readJsonFile(path.join(packageRoot, "package.json"));
  const rootPackageJson = await readJsonFile(path.join(workspace.root, "package.json"));
  const configPath = path.join(packageRoot, policy.registryConfig ?? "components.json");
  const addScript = policy.registryAddScript ?? "ui:add";
  const addAllScript = policy.registryAddAllScript ?? "ui:add:all";
  const cliPackage = policy.registryCliPackage ?? "shadcn";
  const catalogItems = policy.registryCatalogItems ?? [];
  const catalogCommand = `${cliPackage} add ${catalogItems.join(" ")} --yes --overwrite && node scripts/reconcile-registry.mjs`;

  if (!(await pathExists(configPath))) {
    issues.push({ level: "error", message: `UI registry configuration is missing: ${path.relative(workspace.root, configPath).split(path.sep).join("/")}.` });
  } else {
    const config = await readJsonFile(configPath);
    for (const [alias, target] of Object.entries(policy.registryAliases ?? {})) {
      if (config.aliases?.[alias] !== target) {
        issues.push({ level: "error", message: `UI registry alias ${alias} must target ${target}.` });
      }
    }
  }
  if (packageJson.devDependencies?.[cliPackage] !== policy.registryCliVersion) {
    issues.push({ level: "error", message: `${project.name} must pin ${cliPackage} to ${policy.registryCliVersion}.` });
  }
  if (packageJson.scripts?.[addScript] !== `${cliPackage} add`) {
    issues.push({ level: "error", message: `${project.name} script ${addScript} must use the official ${cliPackage} add workflow.` });
  }
  if (packageJson.scripts?.[addAllScript] !== catalogCommand) {
    issues.push({ level: "error", message: `${project.name} script ${addAllScript} must install the official registry catalog.` });
  }
  if (rootPackageJson.scripts?.[addScript] !== `pnpm --dir ${project.root} run ${addScript}`) {
    issues.push({ level: "error", message: `Root script ${addScript} must delegate to the UI package.` });
  }
  if (rootPackageJson.scripts?.[addAllScript] !== `pnpm --dir ${project.root} run ${addAllScript}`) {
    issues.push({ level: "error", message: `Root script ${addAllScript} must delegate to the UI package.` });
  }
  for (const item of catalogItems) {
    const componentPath = path.join(packageRoot, policy.primitiveRoot ?? "src/primitives", `${item}.tsx`);
    if (!(await pathExists(componentPath))) {
      issues.push({ level: "error", message: `UI registry catalog item ${item} is not installed under the primitive root.` });
    }
  }
  return issues;
};

export const checkTypeScriptTaskCoverage = async (workspace) => {
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const projectResults = await Promise.all(workspace.projects.map(async (project) => {
    const projectRoot = path.join(workspace.root, project.root);
    const files = await walkFiles(projectRoot, { ignoredDirectories });
    const hasTypeScript = files.some((file) => typeScriptExtensions.has(path.extname(file)));
    if (!hasTypeScript) return [];

    const issues = [];
    for (const taskName of ["lint", "typecheck"]) {
      if (!project.tasks?.some((task) => task.name === taskName)) {
        issues.push({ level: "error", message: `${project.name} contains TypeScript but has no ${taskName} task.` });
      }
    }
    if (!(await pathExists(path.join(projectRoot, "eslint.config.mjs")))) {
      issues.push({ level: "error", message: `${project.name} contains TypeScript but has no eslint.config.mjs.` });
    }
    return issues;
  }));

  return projectResults.flat();
};

export const checkTypeScriptArchitecture = async (workspace) => {
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const typeBoundaryProjectTypes = workspace.architecture.typescript?.requiredTypeBoundaryProjectTypes ?? [];
  const disallowExplicitAny = workspace.architecture.typescript?.disallowExplicitAny === true;
  const configurationPolicy = workspace.architecture.configuration ?? {};
  const projectResults = await Promise.all(workspace.projects.map(async (project) => {
    const projectRoot = path.join(workspace.root, project.root);
    const files = (await walkFiles(projectRoot, { ignoredDirectories }))
      .filter((file) => typeScriptExtensions.has(path.extname(file)));
    if (files.length === 0) return [];

    const issues = [];
    if (typeBoundaryProjectTypes.includes(project.type)) {
      const typeIndex = path.join(projectRoot, "types", "index.ts");
      if (!(await pathExists(typeIndex))) {
        issues.push({ level: "error", message: `${project.name} requires a types/index.ts architectural type boundary.` });
      }
    }

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const relative = path.relative(workspace.root, file).split(path.sep).join("/");
      if (disallowExplicitAny && explicitAnyPatterns.some((pattern) => pattern.test(source))) {
        issues.push({ level: "error", message: `${relative} uses an explicit any type.` });
      }

      const projectRelative = path.relative(projectRoot, file).split(path.sep).join("/");
      if (projectRelative === configurationPolicy.environmentValidationFile
        && configurationPolicy.forbidDefaultsInEnvironmentValidation === true
        && /\.default\s*\(/.test(source)) {
        issues.push({ level: "error", message: `${relative} embeds a default in environment validation; runtime values must come from the environment.` });
      }

      const isConfigFile = projectRelative.startsWith("config/");
      const importsValidationPackage = (configurationPolicy.validationPackages ?? [])
        .some((packageName) => new RegExp(`from\\s+["']${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(source));
      if (isConfigFile && importsValidationPackage) {
        issues.push({ level: "error", message: `${relative} owns runtime validation inside config; move schemas to validation/.` });
      }
    }

    return issues;
  }));

  return projectResults.flat();
};

export const checkServerFeatureArchitecture = async (workspace) => {
  const policy = workspace.architecture.featureModel ?? {};
  const featureRoot = policy.serverFeatureRoot ?? "features";
  const registrationFile = policy.serverFeatureRegistrationFile ?? "bootstrap/create-app.ts";
  const routeSuffix = policy.serverRouteFileSuffix ?? ".route.ts";
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const issues = [];

  for (const project of workspace.projects.filter((candidate) => candidate.type === "server")) {
    const projectRoot = path.join(workspace.root, project.root);
    const files = await walkFiles(projectRoot, { ignoredDirectories });
    const routeFiles = files.filter((file) => file.endsWith(routeSuffix));
    const registrationPath = path.join(projectRoot, registrationFile);
    const registrationSource = await pathExists(registrationPath) ? await readFile(registrationPath, "utf8") : "";

    if (!registrationSource) {
      issues.push({ level: "error", message: `${project.name} is missing its server feature registration file ${registrationFile}.` });
    } else if (/\bapp\.(?:get|post|put|patch|delete|options|head)\s*\(/.test(registrationSource)) {
      issues.push({ level: "error", message: `${project.name} registers an HTTP route inline in ${registrationFile}; routes belong to feature routers.` });
    }

    for (const routeFile of routeFiles) {
      const relative = path.relative(projectRoot, routeFile).split(path.sep).join("/");
      const segments = relative.split("/");
      if (segments.length !== 4 || segments[0] !== featureRoot || segments[2] !== "routes") {
        issues.push({ level: "error", message: `${project.name} route ${relative} must live at ${featureRoot}/<feature>/routes/<name>${routeSuffix}.` });
        continue;
      }

      const featureName = segments[1];
      const source = await readFile(routeFile, "utf8");
      const factoryName = source.match(/export\s+const\s+(create[A-Z][A-Za-z0-9]*Routes)\s*=/)?.[1];
      if (!factoryName) {
        issues.push({ level: "error", message: `${project.name} route ${relative} must export a deterministic create*Routes factory.` });
        continue;
      }
      if (/\b(?:response|res)\.(?:json|send|status)\s*\(/.test(source)) {
        issues.push({ level: "error", message: `${project.name} route ${relative} contains HTTP response logic; delegate response orchestration to a controller.` });
      }

      const routeIndexPath = path.join(projectRoot, featureRoot, featureName, "routes", "index.ts");
      const routeIndexSource = await pathExists(routeIndexPath) ? await readFile(routeIndexPath, "utf8") : "";
      if (!routeIndexSource.includes(factoryName)) {
        issues.push({ level: "error", message: `${project.name} feature ${featureName} routes must expose ${factoryName} from routes/index.ts.` });
      }
      const indexPath = path.join(projectRoot, featureRoot, featureName, "index.ts");
      const indexSource = await pathExists(indexPath) ? await readFile(indexPath, "utf8") : "";
      if (!indexSource.includes(factoryName)) {
        issues.push({ level: "error", message: `${project.name} feature ${featureName} must expose ${factoryName} from its index.ts.` });
      }
      const publicImport = `../${featureRoot}/${featureName}/index.js`;
      if (!registrationSource.includes(publicImport) || !registrationSource.includes(`${factoryName}(`)) {
        issues.push({ level: "error", message: `${project.name} feature ${featureName} must be explicitly registered through ${publicImport}.` });
      }
    }
  }

  return issues;
};

export const checkPackageLocalMaintenanceScripts = async (workspace) => {
  const policies = workspace.architecture.maintenanceScripts?.packageLocal ?? [];
  const issues = [];
  const forbiddenBehavior = /(?:apps|servers|prebuilt|codebase|enablers|\.agent|\.project)[\\/]|architecture\.yaml|\.\.\s*[\\/]\s*\.\.|node:child_process|\b(?:fetch|process\.cwd|Math\.random|Date\.now)\b/;

  for (const policy of policies) {
    const project = workspace.projects.find((candidate) => candidate.name === policy.project);
    if (!project) {
      issues.push({ level: "error", message: `Maintenance script project ${policy.project} is not registered.` });
      continue;
    }
    const projectRoot = path.resolve(workspace.root, project.root);
    const scriptPath = path.resolve(projectRoot, policy.path);
    const relative = path.relative(projectRoot, scriptPath);
    if (relative.startsWith("..") || path.isAbsolute(relative) || !(await pathExists(scriptPath))) {
      issues.push({ level: "error", message: `${project.name} maintenance script must exist inside its owning package: ${policy.path}.` });
      continue;
    }
    const source = await readFile(scriptPath, "utf8");
    if (!source.includes("packageRoot") || forbiddenBehavior.test(source)) {
      issues.push({ level: "error", message: `${project.name} maintenance script ${policy.path} violates package-local deterministic scope.` });
    }
    const packageJson = await readJsonFile(path.join(projectRoot, "package.json"));
    if (!packageJson.scripts?.[policy.packageScript]?.includes(policy.path)) {
      issues.push({ level: "error", message: `${project.name} package script ${policy.packageScript} must invoke ${policy.path}.` });
    }
  }

  return issues;
};

export const checkTaskGraph = (workspace) => {
  const graph = createDependencyGraph(workspace.projects);
  const tasks = listTasks(workspace.projects);
  const messages = new Set();
  for (const task of tasks) {
    try {
      createExecutionPlan({ graph, projects: workspace.projects, tasks, taskName: task.id });
    } catch (error) {
      messages.add(error instanceof Error ? error.message : String(error));
    }
  }
  return [...messages].map((message) => ({ level: "error", message }));
};

export const runWorkspaceChecks = async (workspace) => [
  ...validateArchitectureConfiguration(workspace.architecture),
  ...(await checkWorkspaceStructure(workspace)),
  ...(await checkMissingProjectManifests(workspace)),
  ...checkProjectManifests(workspace),
  ...checkProjectRegistry(workspace),
  ...checkDependencyGraph(workspace),
  ...checkTaskGraph(workspace),
  ...(await checkReservedControlPlaneDependencies(workspace)),
  ...(await checkPackageManagerArchitecture(workspace)),
  ...(await checkGitGovernance(workspace)),
  ...(await checkTypeScriptConfiguration(workspace)),
  ...(await checkUiRegistryWorkflow(workspace)),
  ...(await checkTypeScriptTaskCoverage(workspace)),
  ...(await checkTypeScriptArchitecture(workspace)),
  ...(await checkServerFeatureArchitecture(workspace)),
  ...(await checkPackageLocalMaintenanceScripts(workspace)),
  ...(await validateArchitectureBoundaries(workspace))
];

export const requiredProjectManifestPath = (project) => `${project.root}/${projectManifestFileName}`;

export { workspaceRoots };
