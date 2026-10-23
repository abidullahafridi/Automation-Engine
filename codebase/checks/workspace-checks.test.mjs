import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  checkMissingProjectManifests,
  checkPackageManagerArchitecture,
  checkPackageLocalMaintenanceScripts,
  checkProjectRegistry,
  checkServerFeatureArchitecture,
  checkTypeScriptArchitecture,
  checkTypeScriptConfiguration,
  checkTypeScriptTaskCoverage,
  checkUiRegistryWorkflow
} from "./workspace-checks.mjs";

test("allows config projects only in architecture-approved roots", () => {
  const architecture = {
    foundation: {
      projectRoots: { apps: "app", packages: "package" },
      allowedProjectTypesByRoot: { apps: ["app"], packages: ["package", "config"] }
    }
  };
  const validIssues = checkProjectRegistry({
    architecture,
    projects: [{ name: "tsconfig", type: "config", root: "packages/tsconfig", internalDependencies: [], externalDependencies: [], capabilities: [], tasks: [] }]
  });
  const invalidIssues = checkProjectRegistry({
    architecture,
    projects: [{ name: "tsconfig", type: "config", root: "apps/tsconfig", internalDependencies: [], externalDependencies: [], capabilities: [], tasks: [] }]
  });

  assert.deepEqual(validIssues, []);
  assert.ok(invalidIssues.some((issue) => issue.message.includes("allows app")));
});

test("rejects stale npm workspace metadata and non-workspace internal dependencies", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-package-manager-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await mkdir(path.join(root, "packages", "ui"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    packageManager: "pnpm@11.19.0",
    workspaces: ["apps/*"],
    scripts: { test: "npm test" }
  }), "utf8");
  await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - \"apps/*\"\n  - \"packages/*\"\nallowBuilds:\n  esbuild: true\n", "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  await writeFile(path.join(root, "apps", "web", "package.json"), JSON.stringify({
    name: "@workspace/web",
    dependencies: { "@workspace/ui": "0.1.0" }
  }), "utf8");
  await writeFile(path.join(root, "packages", "ui", "package.json"), JSON.stringify({ name: "@workspace/ui" }), "utf8");

  const issues = await checkPackageManagerArchitecture({
    root,
    architecture: {
      packageManagement: {
        manager: "pnpm",
        packageManagerVersion: "11.19.0",
        workspaceFile: "pnpm-workspace.yaml",
        workspacePatterns: ["apps/*", "packages/*"],
        allowedBuildDependencies: ["esbuild", "unrs-resolver"],
        lockfile: "pnpm-lock.yaml",
        forbiddenLockfiles: ["package-lock.json"],
        internalDependencyProtocol: "workspace:"
      }
    },
    projects: [
      { name: "web", root: "apps/web", internalDependencies: ["ui"], tasks: [{ name: "test", command: "npm test" }] },
      { name: "ui", root: "packages/ui", internalDependencies: [], tasks: [] }
    ]
  });

  assert.ok(issues.some((issue) => issue.message.includes("stale npm workspaces")));
  assert.ok(issues.some((issue) => issue.message.includes("stale npm command")));
  assert.ok(issues.some((issue) => issue.message.includes("must execute through pnpm")));
  assert.ok(issues.some((issue) => issue.message.includes("workspace:")));
  assert.ok(issues.some((issue) => issue.message.includes("allowBuilds")));
});

test("reports package-defined workspace units without a project manifest", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-missing-manifest-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await writeFile(path.join(root, "apps", "web", "package.json"), "{}", "utf8");
  const issues = await checkMissingProjectManifests({
    root,
    architecture: { foundation: { projectRoots: { apps: "app" }, ignoredDirectories: [] } },
    projects: []
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /apps\/web\/package.json has no project.json/);
});

test("requires configured strict TypeScript options in TypeScript workspace units", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-typescript-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "apps", "web");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }), "utf8");

  const issues = await checkTypeScriptConfiguration({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      typescript: { requiredCompilerOptions: ["strict", "noImplicitAny"] }
    },
    projects: [{ name: "web", root: "apps/web" }]
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /compilerOptions\.noImplicitAny/);
});

test("rejects forbidden TypeScript compiler options", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-typescript-forbidden-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "packages", "ui");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(projectRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, baseUrl: ".", ignoreDeprecations: "6.0" }
  }), "utf8");

  const issues = await checkTypeScriptConfiguration({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      typescript: { requiredCompilerOptions: ["strict"], forbiddenCompilerOptions: ["baseUrl", "ignoreDeprecations"] }
    },
    projects: [{ name: "ui", root: "packages/ui" }]
  });

  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.message.includes("compilerOptions.baseUrl")));
  assert.ok(issues.some((issue) => issue.message.includes("compilerOptions.ignoreDeprecations")));
});

test("requires approved shared TypeScript config inheritance", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-typescript-inheritance-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "apps", "web"), { recursive: true });
  await mkdir(path.join(root, "packages", "tsconfig"), { recursive: true });
  await writeFile(path.join(root, "apps", "web", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(path.join(root, "apps", "web", "tsconfig.json"), JSON.stringify({ extends: "./local.json" }), "utf8");
  await writeFile(path.join(root, "packages", "tsconfig", "base.json"), JSON.stringify({
    compilerOptions: { strict: true, noImplicitAny: true }
  }), "utf8");

  const issues = await checkTypeScriptConfiguration({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      typescript: {
        sharedConfigProject: "tsconfig",
        policyConfigFile: "base.json",
        presetConfigFiles: [],
        approvedExtendsByProjectType: { app: "@workspace/tsconfig/next.json" },
        requiredCompilerOptions: ["strict", "noImplicitAny"],
        forbiddenCompilerOptions: ["baseUrl", "ignoreDeprecations"]
      }
    },
    projects: [
      { name: "web", type: "app", root: "apps/web" },
      { name: "tsconfig", type: "config", root: "packages/tsconfig" }
    ]
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /must extend @workspace\/tsconfig\/next\.json/);
});

test("rejects misplaced and unregistered server feature routes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-server-features-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const serverRoot = path.join(root, "servers", "api");
  await mkdir(path.join(serverRoot, "bootstrap"), { recursive: true });
  await mkdir(path.join(serverRoot, "routes"), { recursive: true });
  await mkdir(path.join(serverRoot, "features", "status", "routes"), { recursive: true });
  await writeFile(path.join(serverRoot, "bootstrap", "create-app.ts"), "export const createApp = () => undefined;\n", "utf8");
  await writeFile(path.join(serverRoot, "routes", "legacy.route.ts"), "export const createLegacyRoutes = () => undefined;\n", "utf8");
  await writeFile(path.join(serverRoot, "features", "status", "routes", "status.route.ts"), "export const createStatusRoutes = (_request, response) => response.status(200).json({});\n", "utf8");
  await writeFile(path.join(serverRoot, "features", "status", "routes", "index.ts"), "export { createStatusRoutes } from './status.route.js';\n", "utf8");
  await writeFile(path.join(serverRoot, "features", "status", "index.ts"), "export { createStatusRoutes } from './routes/index.js';\n", "utf8");

  const issues = await checkServerFeatureArchitecture({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      featureModel: {
        serverFeatureRoot: "features",
        serverFeatureRegistrationFile: "bootstrap/create-app.ts",
        serverRouteFileSuffix: ".route.ts"
      }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.ok(issues.some((issue) => issue.message.includes("routes/legacy.route.ts must live")));
  assert.ok(issues.some((issue) => issue.message.includes("delegate response orchestration to a controller")));
  assert.ok(issues.some((issue) => issue.message.includes("feature status must be explicitly registered")));
});

test("rejects package maintenance scripts that reach outside their owner", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-maintenance-script-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "packages", "ui");
  await mkdir(path.join(packageRoot, "scripts"), { recursive: true });
  await writeFile(path.join(packageRoot, "scripts", "reconcile.mjs"), "const packageRoot = '..';\nawait writeFile('../../architecture.yaml', 'x');\n", "utf8");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ scripts: { reconcile: "node scripts/reconcile.mjs" } }), "utf8");

  const issues = await checkPackageLocalMaintenanceScripts({
    root,
    architecture: { maintenanceScripts: { packageLocal: [{ project: "ui", path: "scripts/reconcile.mjs", packageScript: "reconcile" }] } },
    projects: [{ name: "ui", root: "packages/ui" }]
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /violates package-local deterministic scope/);
});

test("requires the pinned official shadcn registry workflow", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-ui-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "packages", "ui");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: {} }), "utf8");
  await writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    scripts: { "ui:add": "custom-generator add" },
    devDependencies: { shadcn: "^4.20.0" }
  }), "utf8");

  const issues = await checkUiRegistryWorkflow({
    root,
    architecture: {
      uiComposition: {
        packageProject: "ui",
        registryConfig: "components.json",
        registryCliPackage: "shadcn",
        registryCliVersion: "4.20.0",
        registryAddScript: "ui:add",
        registryAddAllScript: "ui:add:all"
      }
    },
    projects: [{ name: "ui", root: "packages/ui" }]
  });

  assert.equal(issues.length, 6);
  assert.ok(issues.some((issue) => issue.message.includes("registry configuration")));
  assert.ok(issues.some((issue) => issue.message.includes("must pin shadcn")));
  assert.ok(issues.some((issue) => issue.message.includes("official shadcn add workflow")));
});

test("requires a tsconfig for TypeScript workspace units", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-typescript-missing-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "packages", "shared");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "index.ts"), "export {};\n", "utf8");

  const issues = await checkTypeScriptConfiguration({
    root,
    architecture: { foundation: { ignoredDirectories: [] }, typescript: { requiredCompilerOptions: ["strict"] } },
    projects: [{ name: "shared", root: "packages/shared" }]
  });

  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /has no tsconfig\.json/);
});

test("requires lint and typecheck tasks plus ESLint configuration for TypeScript workspace units", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-typescript-task-coverage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "apps", "web");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(projectRoot, "index.ts"), "export const value = 1;\n", "utf8");

  const issues = await checkTypeScriptTaskCoverage({
    root,
    architecture: { foundation: { ignoredDirectories: [] } },
    projects: [{ name: "web", root: "apps/web", tasks: [{ name: "lint", command: "eslint ." }] }]
  });

  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.message.includes("typecheck task")));
  assert.ok(issues.some((issue) => issue.message.includes("eslint.config.mjs")));
});

test("rejects explicit any and environment defaults in TypeScript workspace units", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-typescript-architecture-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "apps", "web");
  await mkdir(path.join(projectRoot, "validation"), { recursive: true });
  await mkdir(path.join(projectRoot, "types"), { recursive: true });
  await writeFile(path.join(projectRoot, "types", "index.ts"), "export type Value = any;\n", "utf8");
  await writeFile(path.join(projectRoot, "validation", "env.validation.ts"), "const port = z.number().default(4000);\n", "utf8");

  const issues = await checkTypeScriptArchitecture({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      typescript: { disallowExplicitAny: true, requiredTypeBoundaryProjectTypes: ["app"] },
      configuration: {
        environmentValidationFile: "validation/env.validation.ts",
        forbidDefaultsInEnvironmentValidation: true,
        validationPackages: ["zod"]
      }
    },
    projects: [{ name: "web", type: "app", root: "apps/web" }]
  });

  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.message.includes("explicit any")));
  assert.ok(issues.some((issue) => issue.message.includes("embeds a default")));
});

test("requires type boundaries and keeps runtime schemas outside config", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-type-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "servers", "api");
  await mkdir(path.join(projectRoot, "config"), { recursive: true });
  await writeFile(path.join(projectRoot, "config", "env.ts"), "import { z } from 'zod';\nexport const schema = z.object({});\n", "utf8");

  const issues = await checkTypeScriptArchitecture({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      typescript: { disallowExplicitAny: true, requiredTypeBoundaryProjectTypes: ["server"] },
      configuration: {
        environmentValidationFile: "validation/env.validation.ts",
        forbidDefaultsInEnvironmentValidation: true,
        validationPackages: ["zod"]
      }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.equal(issues.length, 2);
  assert.ok(issues.some((issue) => issue.message.includes("types/index.ts")));
  assert.ok(issues.some((issue) => issue.message.includes("inside config")));
});
