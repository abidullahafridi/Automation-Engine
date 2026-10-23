import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists, toPosixPath, walkFiles } from "../utilities/fs.mjs";

const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)|import\(\s*["']([^"']+)["']\s*\)/g;

const getImports = (source) => [...source.matchAll(importPattern)].map((match) => match[1] ?? match[2] ?? match[3]);
const segmentsOf = (value) => toPosixPath(value).split("/").filter(Boolean);
const includesSegment = (segments, candidates) => segments.some((segment) => candidates.includes(segment));
const fileRole = (filePath) => {
  const match = path.basename(filePath).match(/\.([a-z]+)(?:\.[cm]?[jt]sx?)?$/i);
  return match?.[1]?.toLowerCase();
};

const resolveWorkspaceImport = ({ workspaceRoot, projectRoot, sourceFile, specifier }) => {
  if (specifier.startsWith(".")) return path.resolve(path.dirname(sourceFile), specifier);
  if (specifier.startsWith("@/")) return path.resolve(workspaceRoot, projectRoot, specifier.slice(2));
  const firstSegment = specifier.split("/")[0];
  if (["apps", "servers", "packages", "prebuilt"].includes(firstSegment)) {
    return path.resolve(workspaceRoot, specifier);
  }
  return undefined;
};

const startsWithPath = (value, prefix) => value === prefix || value.startsWith(`${prefix}/`);

const uiLayer = (projectRelativePath, policy) => {
  if (startsWithPath(projectRelativePath, policy.primitiveRoot ?? "components/ui")) return "primitive";
  if ((policy.genericRoots ?? []).some((root) => startsWithPath(projectRelativePath, root))
    || (policy.genericFiles ?? []).includes(projectRelativePath)) return "generic";
  if (startsWithPath(projectRelativePath, policy.featureRoot ?? "features")) return "feature";
  if ((policy.applicationRoots ?? []).some((root) => startsWithPath(projectRelativePath, root))) return "application";
  return undefined;
};

const featureIdentity = (segments) => {
  const index = segments.indexOf("features");
  return index >= 0 && segments[index + 1]
    ? { name: segments[index + 1], index }
    : undefined;
};

const issue = (workspaceRoot, sourceFile, specifier, rule, detail) => ({
  level: "error",
  rule,
  file: toPosixPath(path.relative(workspaceRoot, sourceFile)),
  message: `${toPosixPath(path.relative(workspaceRoot, sourceFile))} imports "${specifier}": ${detail}`
});

const localIssue = (workspaceRoot, sourceFile, rule, detail) => ({
  level: "error",
  rule,
  file: toPosixPath(path.relative(workspaceRoot, sourceFile)),
  message: `${toPosixPath(path.relative(workspaceRoot, sourceFile))}: ${detail}`
});

export const validateArchitectureBoundaries = async (workspace) => {
  const policy = workspace.architecture.boundaries ?? {};
  const uiPolicy = workspace.architecture.uiComposition ?? {};
  const integrationPolicy = workspace.architecture.integrations ?? {};
  const dependencyDirection = {
    app: ["servers", "prebuilt"],
    server: ["apps", "prebuilt"],
    package: policy.packagesCannotImport ?? ["apps", "servers", "prebuilt"],
    ...(policy.workspaceUnitCannotImport ?? {})
  };
  const ignoredDirectories = new Set(workspace.architecture.foundation?.ignoredDirectories ?? []);
  const projectFiles = await Promise.all(workspace.projects.map(async (project) => {
    const root = path.resolve(workspace.root, project.root);
    const files = await walkFiles(root, { ignoredDirectories });
    return files
      .filter((filePath) => sourceExtensions.has(path.extname(filePath)))
      .map((filePath) => ({ project, filePath }));
  }));
  const findings = [];
  const moduleBoundaries = (workspace.architecture.moduleBoundaries ?? []).flatMap((boundary) => {
    const project = workspace.projects.find(({ name }) => name === boundary.project);
    return project ? [{ ...boundary, project }] : [];
  });
  const packageModuleSpecifiers = new Map();

  if (typeof uiPolicy.packageProject === "string"
    && !workspace.projects.some(({ name }) => name === uiPolicy.packageProject)) {
    findings.push({
      level: "error",
      rule: "generic-ui-ownership",
      file: "architecture.yaml",
      message: `Configured generic UI package ${uiPolicy.packageProject} is not a discovered workspace project.`
    });
  }

  for (const boundary of moduleBoundaries.filter(({ project }) => project.type === "package")) {
    const packageJsonPath = path.resolve(workspace.root, boundary.project.root, "package.json");
    if (await pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (typeof packageJson.name === "string") {
        packageModuleSpecifiers.set(packageJson.name, Object.keys(packageJson.exports ?? { ".": true }));
      }
    }
  }

  for (const boundary of moduleBoundaries) {
    const moduleRoot = path.resolve(workspace.root, boundary.project.root, boundary.root);
    const moduleIndex = path.join(moduleRoot, "index.ts");
    const moduleIndexSource = await pathExists(moduleIndex) ? await readFile(moduleIndex, "utf8") : "";
    if (!(await pathExists(moduleIndex))) {
      findings.push(localIssue(workspace.root, moduleRoot, "module-public-surface", `module ${boundary.root} requires an index.ts public surface.`));
    }
    for (const category of boundary.categories) {
      const categoryRoot = path.join(moduleRoot, category);
      const categoryIndex = path.join(categoryRoot, "index.ts");
      if (!(await pathExists(categoryIndex))) {
        findings.push(localIssue(workspace.root, categoryRoot, "module-public-surface", `category ${boundary.root}/${category} requires an index.ts public surface.`));
      }
    }
    for (const category of boundary.rootExports ?? []) {
      if (!new RegExp(`["']\\./${category}(?:/index(?:\\.js)?)?["']`).test(moduleIndexSource)) {
        findings.push(localIssue(workspace.root, moduleIndex, "module-public-export", `module ${boundary.root} must re-export the ${category} category public surface.`));
      }
    }
    const moduleFiles = await walkFiles(moduleRoot, { ignoredDirectories });
    for (const file of moduleFiles) {
      const relative = toPosixPath(path.relative(moduleRoot, file));
      if (!relative.includes("/") && sourceExtensions.has(path.extname(file)) && relative !== "index.ts") {
        findings.push(localIssue(workspace.root, file, "module-dumping-ground", `categorized module ${boundary.root} may only expose source from its root index.ts.`));
      }
    }
  }

  for (const project of workspace.projects) {
    for (const area of ["constants", "types"]) {
      const areaRoot = path.resolve(workspace.root, project.root, area);
      const directSourceFiles = (await walkFiles(areaRoot, { ignoredDirectories })).filter((file) => {
        const relative = toPosixPath(path.relative(areaRoot, file));
        return !relative.includes("/") && relative !== "index.ts" && sourceExtensions.has(path.extname(file));
      });
      if (directSourceFiles.length > 1) {
        findings.push(localIssue(
          workspace.root,
          areaRoot,
          `${area}-dumping-ground`,
          `${area}/ contains multiple unrelated root source files; categorize them behind meaningful public modules.`
        ));
      }
    }
  }

  for (const { project, filePath } of projectFiles.flat()) {
    const source = await readFile(filePath, "utf8");
    const sourceSegments = segmentsOf(path.relative(workspace.root, filePath));
    const projectRelativePath = toPosixPath(path.relative(path.resolve(workspace.root, project.root), filePath));
    const sourceFeature = featureIdentity(sourceSegments);
    const usesUiPackageModel = typeof uiPolicy.packageProject === "string";
    const isUiPackage = project.name === uiPolicy.packageProject;
    const sourceUiLayer = isUiPackage || (!usesUiPackageModel && project.type === "app")
      ? uiLayer(projectRelativePath, uiPolicy)
      : project.type === "app" && (uiPolicy.applicationRoots ?? []).some((root) => startsWithPath(projectRelativePath, root))
        ? "application"
        : project.type === "app" && startsWithPath(projectRelativePath, uiPolicy.featureRoot ?? "features")
          ? "feature"
          : undefined;

    if ((isUiPackage || project.type === "app") && projectRelativePath.includes("/")) {
      const componentName = path.basename(filePath, path.extname(filePath));
      const isPrimitive = isUiPackage && startsWithPath(projectRelativePath, uiPolicy.primitiveRoot ?? "components/ui");
      const isLegacyPrimitive = !usesUiPackageModel && project.type === "app"
        && startsWithPath(projectRelativePath, uiPolicy.primitiveRoot ?? "components/ui");
      if (!isPrimitive && !isLegacyPrimitive && (uiPolicy.shadcnPrimitiveNames ?? []).includes(componentName)) {
        findings.push(localIssue(
          workspace.root,
          filePath,
          "shadcn-primitive-ownership",
          `${componentName} duplicates a named shadcn primitive outside ${uiPolicy.primitiveRoot ?? "components/ui"}.`
        ));
      }
    }

    if (usesUiPackageModel && project.type === "app"
      && (uiPolicy.appForbiddenGenericRoots ?? []).some((root) => startsWithPath(projectRelativePath, root))) {
      findings.push(localIssue(
        workspace.root,
        filePath,
        "generic-ui-ownership",
        `generic UI belongs in the ${uiPolicy.packageProject} package, not an application-local generic UI root.`
      ));
    }

    if (isUiPackage && sourceSegments.includes("features")) {
      findings.push(localIssue(
        workspace.root,
        filePath,
        "feature-ui-ownership",
        "feature-specific UI must remain in its owning application feature."
      ));
    }

    if (project.type === "server" && includesSegment(sourceSegments, policy.serverDisallowedSegments ?? [])) {
      findings.push(localIssue(
        workspace.root,
        filePath,
        "server-operational-observability",
        "server-local observability is prohibited; use packages/logging for implementation and enablers/observability for operational ownership."
      ));
    }

    for (const specifier of getImports(source)) {
      for (const [packageName, exportKeys] of packageModuleSpecifiers) {
        if (specifier.startsWith(`${packageName}/`)) {
          const subpath = `./${specifier.slice(packageName.length + 1)}`;
          const isExported = exportKeys.some((key) => key === subpath
            || (key.endsWith("/*") && subpath.startsWith(key.slice(0, -1))));
          if (!isExported) {
            findings.push(issue(
              workspace.root,
              filePath,
              specifier,
              "module-public-import",
              `consumers must use an exported ${packageName} public surface.`
            ));
          }
        }
      }
      const targetPath = resolveWorkspaceImport({
        workspaceRoot: workspace.root,
        projectRoot: project.root,
        sourceFile: filePath,
        specifier
      });
      const targetSegments = targetPath ? segmentsOf(path.relative(workspace.root, targetPath)) : [];
      const targetFileRole = targetPath ? fileRole(targetPath) : undefined;

      if (project.type === "server") {
        const externalRoot = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        const isIntegrationFile = sourceSegments.includes(integrationPolicy.serverDirectory ?? "integrations");
        if ((integrationPolicy.externalImplementationPackages ?? []).includes(externalRoot) && !isIntegrationFile) {
          findings.push(issue(
            workspace.root,
            filePath,
            specifier,
            "external-integration-boundary",
            `server code must access ${externalRoot} through an integrations/ boundary or reusable package.`
          ));
        }
      }

      if (targetPath) {
        const normalizedTarget = toPosixPath(path.relative(path.resolve(workspace.root, project.root), targetPath))
          .replace(/\.[^/.]+$/, "")
          .replace(/\/index$/, "");
        for (const boundary of moduleBoundaries.filter(({ project: owner }) => owner.name === project.name)) {
          for (const category of boundary.categories) {
            const categoryRoot = `${boundary.root}/${category}`;
            const sourcePath = projectRelativePath.replace(/\.[^/.]+$/, "");
            const importsCategoryInternal = normalizedTarget.startsWith(`${categoryRoot}/`);
            const sourceOwnsCategory = sourcePath.startsWith(`${categoryRoot}/`);
            if (importsCategoryInternal && !sourceOwnsCategory) {
              findings.push(issue(
                workspace.root,
                filePath,
                specifier,
                "module-public-import",
                `consumers outside ${categoryRoot} must import its public index.`
              ));
            }
          }
        }
      }

      if (sourceUiLayer && targetPath) {
        const targetProjectRelativePath = toPosixPath(path.relative(path.resolve(workspace.root, project.root), targetPath));
        const targetUiLayer = uiLayer(targetProjectRelativePath, uiPolicy);
        const reversesPrimitive = sourceUiLayer === "primitive" && ["generic", "feature", "application"].includes(targetUiLayer);
        const reversesGeneric = sourceUiLayer === "generic" && ["feature", "application"].includes(targetUiLayer);
        if (reversesPrimitive || reversesGeneric) {
          findings.push(issue(
            workspace.root,
            filePath,
            specifier,
            "ui-composition-direction",
            `${sourceUiLayer} UI cannot depend on ${targetUiLayer} UI.`
          ));
        }
      }

      const forbiddenRoots = dependencyDirection[project.type] ?? [];
      if (targetSegments.length > 0 && forbiddenRoots.includes(targetSegments[0])) {
        const rule = project.type === "package" ? "packages-dependency-direction" : `${project.type}-dependency-direction`;
        findings.push(issue(workspace.root, filePath, specifier, rule, `${project.type} workspace units cannot import ${targetSegments[0]} workspace units.`));
      }

      if (sourceSegments.includes("domain")) {
        const externalRoot = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        const importsForbiddenRole = (policy.domainCannotImportFileRoles ?? []).includes(targetFileRole);
        if ((policy.domainCannotImportPackages ?? []).includes(externalRoot) || includesSegment(targetSegments, policy.domainCannotImportSegments ?? []) || importsForbiddenRole) {
          findings.push(issue(workspace.root, filePath, specifier, "domain-isolation", "domain code cannot depend on protocol, persistence-model, or infrastructure implementation details."));
        }
      }

      if (includesSegment(sourceSegments, policy.uiSegments ?? []) && (includesSegment(targetSegments, policy.persistenceSegments ?? []) || (policy.persistenceFileRoles ?? []).includes(targetFileRole))) {
        findings.push(issue(workspace.root, filePath, specifier, "ui-persistence-boundary", "UI code cannot import persistence implementation directly."));
      }

      const sourceIsService = sourceSegments.includes("services") || fileRole(filePath) === "service";
      const serviceImportsForbiddenRole = (policy.serviceCannotImportFileRoles ?? []).includes(targetFileRole);
      if (sourceIsService && (includesSegment(targetSegments, policy.serviceCannotImportSegments ?? ["routes", "controllers", "ui", "components"]) || serviceImportsForbiddenRole)) {
        findings.push(issue(workspace.root, filePath, specifier, "service-isolation", "service code cannot depend on delivery or UI layers."));
      }

      const targetFeature = featureIdentity(targetSegments);
      if (!sourceFeature && targetFeature && project.type === "server") {
        const targetRemainder = targetSegments.slice(targetFeature.index + 2);
        const targetsFeaturePublicApi = targetRemainder.length === 1 && /^index(?:\.[^.]+)?$/.test(targetRemainder[0]);
        if (!targetsFeaturePublicApi) {
          findings.push(issue(
            workspace.root,
            filePath,
            specifier,
            "feature-public-import",
            `server consumers outside feature ${targetFeature.name} must import its root public API.`
          ));
        }
      }
      if (sourceFeature && targetFeature && sourceFeature.name !== targetFeature.name) {
        const targetRemainder = targetSegments.slice(targetFeature.index + 2);
        const targetsPublicModule = targetRemainder.length === 1 && /^public(?:\.[^.]+)?$/.test(targetRemainder[0]);
        if (!targetsPublicModule) {
          findings.push(issue(workspace.root, filePath, specifier, "feature-private-import", `feature ${sourceFeature.name} cannot import private internals of feature ${targetFeature.name}; expose an explicit public module.`));
        }
      }
    }
  }

  return findings;
};
