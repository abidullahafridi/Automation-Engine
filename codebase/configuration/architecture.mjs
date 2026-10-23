import path from "node:path";
import { readJsonFile } from "../utilities/fs.mjs";

export const architectureFileName = "architecture.yaml";

export const readArchitecture = async (workspaceRoot) => {
  const filePath = path.join(workspaceRoot, architectureFileName);

  try {
    return await readJsonFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load architecture policy: ${message}`);
  }
};

export const createArchitectureContext = (architecture) => {
  const foundation = architecture?.foundation ?? {};
  const asArray = (value) => Array.isArray(value) ? value : [];
  const projectRootConfiguration = foundation.projectRoots && typeof foundation.projectRoots === "object" && !Array.isArray(foundation.projectRoots)
    ? foundation.projectRoots
    : {};
  return {
    ignoredDirectories: new Set(asArray(foundation.ignoredDirectories)),
    projectTypeByRoot: projectRootConfiguration,
    projectRoots: Object.keys(projectRootConfiguration),
    requiredRoots: asArray(foundation.requiredRoots),
    requiredFiles: asArray(foundation.requiredFiles)
  };
};

export const validateArchitectureConfiguration = (architecture) => {
  const issues = [];
  if (!architecture || typeof architecture !== "object") {
    return [{ level: "error", message: "Architecture policy must be an object." }];
  }
  if (!Number.isInteger(architecture.version) || architecture.version < 1) {
    issues.push({ level: "error", message: "Architecture policy requires a positive integer version." });
  }
  if (!architecture.foundation || typeof architecture.foundation !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing foundation configuration." });
    return issues;
  }
  const roots = architecture.foundation.projectRoots;
  if (!roots || typeof roots !== "object" || Array.isArray(roots)) {
    issues.push({ level: "error", message: "Architecture policy requires a projectRoots object." });
  } else {
    for (const [root, type] of Object.entries(roots)) {
      if (!root || root.includes("..") || path.isAbsolute(root)) {
        issues.push({ level: "error", message: `Invalid workspace unit root: ${root || "(empty)"}.` });
      }
      if (!["app", "server", "package", "prebuilt", "config"].includes(type)) {
        issues.push({ level: "error", message: `Workspace unit root ${root} has invalid type ${type}.` });
      }
    }
  }
  const allowedProjectTypesByRoot = architecture.foundation.allowedProjectTypesByRoot;
  if (!allowedProjectTypesByRoot || typeof allowedProjectTypesByRoot !== "object" || Array.isArray(allowedProjectTypesByRoot)) {
    issues.push({ level: "error", message: "Architecture policy requires an allowedProjectTypesByRoot object." });
  } else {
    for (const [root, types] of Object.entries(allowedProjectTypesByRoot)) {
      if (!Array.isArray(types) || types.length === 0
        || types.some((type) => !["app", "server", "package", "prebuilt", "config"].includes(type))) {
        issues.push({ level: "error", message: `Workspace unit root ${root} has invalid allowed project types.` });
      }
    }
  }
  for (const field of ["requiredRoots", "requiredFiles", "ignoredDirectories", "disallowedOrchestrators"]) {
    const value = architecture.foundation[field];
    if (value !== undefined && !Array.isArray(value)) {
      issues.push({ level: "error", message: `Architecture foundation.${field} must be an array.` });
    }
  }
  if (!architecture.boundaries || typeof architecture.boundaries !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing boundary configuration." });
  }
  const toolingModel = architecture.toolingModel;
  if (!toolingModel || toolingModel.principle !== "custom-orchestration-standard-engines") {
    issues.push({ level: "error", message: "Architecture policy must separate custom repository orchestration from standard technical engines." });
  } else {
    for (const [capability, engine] of Object.entries({
      packageManagement: "pnpm",
      typescript: "tsc",
      lint: "eslint",
      tests: "project-declared-runner",
      dependencySecurity: "pnpm-audit",
      secretDetection: "trufflehog"
    })) {
      if (toolingModel.standardEngines?.[capability] !== engine) {
        issues.push({ level: "error", message: `Architecture tooling model must delegate ${capability} to ${engine}.` });
      }
    }
  }
  if (!Array.isArray(architecture.typescript?.requiredCompilerOptions)) {
    issues.push({ level: "error", message: "Architecture policy requires a typescript.requiredCompilerOptions array." });
  }
  if (!Array.isArray(architecture.typescript?.forbiddenCompilerOptions)) {
    issues.push({ level: "error", message: "Architecture policy requires a typescript.forbiddenCompilerOptions array." });
  }
  if (!Array.isArray(architecture.typescript?.requiredTypeBoundaryProjectTypes)) {
    issues.push({ level: "error", message: "Architecture policy requires a typescript.requiredTypeBoundaryProjectTypes array." });
  }
  if (typeof architecture.typescript?.sharedConfigProject !== "string"
    || typeof architecture.typescript?.policyConfigFile !== "string"
    || !Array.isArray(architecture.typescript?.presetConfigFiles)
    || !architecture.typescript?.approvedExtendsByProjectType
    || typeof architecture.typescript.approvedExtendsByProjectType !== "object"
    || Array.isArray(architecture.typescript.approvedExtendsByProjectType)) {
    issues.push({ level: "error", message: "Architecture TypeScript policy must identify its shared config project, policy file, and approved inheritance." });
  }
  if (!architecture.configuration || typeof architecture.configuration !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing configuration-boundary rules." });
  } else {
    if (typeof architecture.configuration.environmentValidationFile !== "string") {
      issues.push({ level: "error", message: "Architecture configuration requires an environmentValidationFile path." });
    }
    if (!Array.isArray(architecture.configuration.validationPackages)) {
      issues.push({ level: "error", message: "Architecture configuration.validationPackages must be an array." });
    }
  }
  if (!architecture.uiComposition || typeof architecture.uiComposition !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing UI composition rules." });
  } else {
    for (const field of ["genericRoots", "genericFiles", "applicationRoots", "appForbiddenGenericRoots", "shadcnPrimitiveNames", "registryCatalogItems", "registryUnavailableItems"]) {
      if (!Array.isArray(architecture.uiComposition[field])) {
        issues.push({ level: "error", message: `Architecture uiComposition.${field} must be an array.` });
      }
    }
    if (typeof architecture.uiComposition.packageProject !== "string") {
      issues.push({ level: "error", message: "Architecture uiComposition.packageProject must identify the generic UI package." });
    }
    if (architecture.uiComposition.registryFirst !== true) {
      issues.push({ level: "error", message: "Architecture UI composition must require registry-first component creation." });
    }
    for (const field of ["registryConfig", "registryCliPackage", "registryCliVersion", "registryAddScript", "registryAddAllScript"]) {
      if (typeof architecture.uiComposition[field] !== "string") {
        issues.push({ level: "error", message: `Architecture uiComposition.${field} must be a string.` });
      }
    }
    if (!architecture.uiComposition.registryAliases || typeof architecture.uiComposition.registryAliases !== "object"
      || Array.isArray(architecture.uiComposition.registryAliases)) {
      issues.push({ level: "error", message: "Architecture uiComposition.registryAliases must be an object." });
    }
    const primitiveNames = new Set(architecture.uiComposition.shadcnPrimitiveNames ?? []);
    for (const item of architecture.uiComposition.registryCatalogItems ?? []) {
      if (!primitiveNames.has(item)) {
        issues.push({ level: "error", message: `Registry catalog item ${item} must be protected as a shadcn primitive name.` });
      }
    }
  }
  if (!architecture.integrations || typeof architecture.integrations !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing integration-boundary rules." });
  } else if (!Array.isArray(architecture.integrations.externalImplementationPackages)) {
    issues.push({ level: "error", message: "Architecture integrations.externalImplementationPackages must be an array." });
  }
  const maintenanceScripts = architecture.maintenanceScripts;
  if (!maintenanceScripts || !Array.isArray(maintenanceScripts.packageLocal)
    || maintenanceScripts.contract?.ownPackageOnly !== true
    || maintenanceScripts.contract?.deterministic !== true
    || maintenanceScripts.contract?.idempotent !== true
    || maintenanceScripts.contract?.mayOrchestrateRepository !== false
    || maintenanceScripts.contract?.mayChangeArchitecture !== false
    || maintenanceScripts.contract?.mayBypassPolicy !== false) {
    issues.push({ level: "error", message: "Architecture policy must define the package-local maintenance-script contract." });
  }
  if (!Array.isArray(architecture.moduleBoundaries)) {
    issues.push({ level: "error", message: "Architecture policy requires a moduleBoundaries array." });
  } else {
    for (const boundary of architecture.moduleBoundaries) {
      if (typeof boundary?.project !== "string" || typeof boundary?.root !== "string"
        || !Array.isArray(boundary?.categories) || !Array.isArray(boundary?.rootExports)) {
        issues.push({ level: "error", message: "Each module boundary requires project, root, categories, and rootExports fields." });
      }
    }
  }
  const packageManagement = architecture.packageManagement;
  if (!packageManagement || typeof packageManagement !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing package-management rules." });
  } else {
    if (packageManagement.manager !== "pnpm") {
      issues.push({ level: "error", message: "Architecture package manager must be pnpm." });
    }
    for (const field of ["workspacePatterns", "forbiddenLockfiles", "allowedBuildDependencies"]) {
      if (!Array.isArray(packageManagement[field])) {
        issues.push({ level: "error", message: `Architecture packageManagement.${field} must be an array.` });
      }
    }
    for (const field of ["packageManagerVersion", "workspaceFile", "lockfile", "internalDependencyProtocol"]) {
      if (typeof packageManagement[field] !== "string") {
        issues.push({ level: "error", message: `Architecture packageManagement.${field} must be a string.` });
      }
    }
  }
  const security = architecture.security;
  if (!security || typeof security !== "object") {
    issues.push({ level: "error", message: "Architecture policy is missing security tool orchestration rules." });
  } else {
    if (security.model !== "standard-engines-repository-policy") {
      issues.push({ level: "error", message: "Architecture security must separate standard engines from repository policy." });
    }
    if (security.dependencyAudit?.engine !== "pnpm-audit"
      || !["low", "moderate", "high", "critical"].includes(security.dependencyAudit?.minimumSeverity)) {
      issues.push({ level: "error", message: "Architecture dependency security must configure pnpm audit with a valid minimum severity." });
    }
    if (security.secretScan?.engine !== "trufflehog"
      || !/^\d+\.\d+\.\d+$/.test(security.secretScan?.version ?? "")
      || typeof security.secretScan?.configuration !== "string"
      || security.secretScan.configuration.length === 0
      || security.secretScan?.execution !== "managed-binary"
      || security.secretScan?.scanMode !== "filesystem"
      || !Array.isArray(security.secretScan?.resultClasses)
      || !["verified", "unknown", "unverified"].every((item) => security.secretScan.resultClasses.includes(item))) {
      issues.push({ level: "error", message: "Architecture secret security must configure pinned, managed TruffleHog filesystem scanning for every result class." });
    }
  }
  if (architecture.contractOwnership?.sharedTypesRoot !== "packages/types"
    || architecture.contractOwnership?.extractionRule !== "genuine-cross-boundary-reuse") {
    issues.push({ level: "error", message: "Architecture contract ownership must preserve categorized shared types and earned extraction." });
  }
  if (!Array.isArray(architecture.testingModel?.levels)
    || architecture.testingModel?.principle !== "behavior-and-boundaries-not-files") {
    issues.push({ level: "error", message: "Architecture testing model must define behavior-focused test levels." });
  }
  if (architecture.workspaceModel?.repositoryIsWorkspace !== true || architecture.workspaceModel?.mandatoryProjectNamespace !== false) {
    issues.push({ level: "error", message: "Architecture workspace model must define the repository as the workspace without a mandatory project namespace." });
  }
  if (architecture.featureModel?.ownership !== "feature-first" || architecture.featureModel?.serverLayout !== "flat-files-by-default"
    || typeof architecture.featureModel?.serverFeatureRoot !== "string"
    || typeof architecture.featureModel?.serverFeatureRegistrationFile !== "string"
    || typeof architecture.featureModel?.serverRouteFileSuffix !== "string"
    || architecture.featureModel?.serverFeatureLayers?.strategy !== "progressive-categorized-when-justified"
    || architecture.featureModel?.serverFeatureLayers?.publicEntry !== "index.ts"
    || !architecture.featureModel?.serverFeatureLayers?.optional
    || typeof architecture.featureModel.serverFeatureLayers.optional !== "object") {
    issues.push({ level: "error", message: "Architecture feature model must be feature-first with flat server files by default." });
  }
  const gitGovernance = architecture.gitGovernance;
  if (!gitGovernance
    || gitGovernance.hooks !== "husky"
    || gitGovernance.commitMessages !== "commitlint"
    || gitGovernance.commitConvention !== "conventional-commits"
    || gitGovernance.stagedFiles !== "lint-staged"
    || gitGovernance.defaultBranch !== "main"
    || gitGovernance.mergeStrategy !== "squash"
    || gitGovernance.requiredStatusCheck !== "validate"
    || gitGovernance.signedCommits !== "optional"
    || typeof gitGovernance.branchPattern !== "string"
    || !Array.isArray(gitGovernance.codeOwners)
    || !gitGovernance.tools || typeof gitGovernance.tools !== "object") {
    issues.push({ level: "error", message: "Architecture Git governance must define the Husky, Commitlint, lint-staged, review, and main-branch contract." });
  } else {
    try {
      new RegExp(gitGovernance.branchPattern);
    } catch {
      issues.push({ level: "error", message: "Architecture Git governance branchPattern must be a valid regular expression." });
    }
  }
  if (architecture.growthModel?.categorizationRule !== "meaningful-ownership-or-growth"
    || architecture.growthModel?.commonFileCountHeuristic !== 3
    || architecture.growthModel?.fileCountIsMandatoryThreshold !== false) {
    issues.push({ level: "error", message: "Architecture growth model must treat file count as a heuristic, not a mandatory category threshold." });
  }
  return issues;
};
