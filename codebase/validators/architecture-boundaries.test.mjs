import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { validateArchitectureBoundaries } from "./architecture-boundaries.mjs";

test("rejects a package importing application code", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "packages", "ui", "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "button.ts"), "import '../../../apps/store/private.js';\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {
        packagesCannotImport: ["apps", "servers", "prebuilt"],
        domainCannotImportSegments: ["controllers", "routes", "models"],
        domainCannotImportPackages: ["express", "mongoose", "next", "redis"],
        uiSegments: ["components", "ui"],
        persistenceSegments: ["models", "persistence", "repositories"]
      }
    },
    projects: [{ name: "ui", type: "package", root: "packages/ui" }]
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "packages-dependency-direction");
});

test("rejects a server importing application code", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-server-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "servers", "api", "src");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "service.ts"), "import '../../../apps/web/private.js';\n", "utf8");
  const findings = await validateArchitectureBoundaries({
    root,
    architecture: { foundation: { ignoredDirectories: [] }, boundaries: {} },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });
  assert.equal(findings[0].rule, "server-dependency-direction");
});

test("rejects observability implementation owned by a server", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-server-observability-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "servers", "api", "observability");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(sourceRoot, "logger.ts"), "export {};\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: { serverDisallowedSegments: ["observability"] }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "server-operational-observability");
});

test("enforces domain isolation for flat feature file roles", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-flat-domain-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const featureRoot = path.join(root, "servers", "api", "orders");
  await mkdir(path.join(featureRoot, "domain"), { recursive: true });
  await writeFile(path.join(featureRoot, "domain", "orders.rules.ts"), "import '../orders.model.ts';\n", "utf8");
  await writeFile(path.join(featureRoot, "orders.model.ts"), "export {};\n", "utf8");
  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: { domainCannotImportFileRoles: ["route", "controller", "service", "repository", "validation", "model", "integration"] }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "domain-isolation");
});

test("allows services to compose repositories but not controllers in flat features", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-flat-service-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const featureRoot = path.join(root, "servers", "api", "orders");
  await mkdir(featureRoot, { recursive: true });
  await writeFile(path.join(featureRoot, "orders.service.ts"), "import './orders.repository.ts';\nimport './orders.controller.ts';\n", "utf8");
  await writeFile(path.join(featureRoot, "orders.repository.ts"), "export {};\n", "utf8");
  await writeFile(path.join(featureRoot, "orders.controller.ts"), "export {};\n", "utf8");
  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: { serviceCannotImportFileRoles: ["route", "controller", "model"] }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "service-isolation");
});

test("rejects generic UI importing application UI through an app alias", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-ui-direction-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const genericRoot = path.join(root, "apps", "web", "components", "layout");
  const applicationRoot = path.join(root, "apps", "web", "components", "workspace");
  await mkdir(genericRoot, { recursive: true });
  await mkdir(applicationRoot, { recursive: true });
  await writeFile(path.join(genericRoot, "shell.tsx"), "import '@/components/workspace/status';\n", "utf8");
  await writeFile(path.join(applicationRoot, "status.tsx"), "export {};\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      uiComposition: {
        primitiveRoot: "components/ui",
        genericRoots: ["components/layout"],
        genericFiles: [],
        applicationRoots: ["components/workspace"],
        featureRoot: "features",
        shadcnPrimitiveNames: []
      }
    },
    projects: [{ name: "web", type: "app", root: "apps/web" }]
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "ui-composition-direction");
});

test("rejects named shadcn replacements outside the primitive root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-shadcn-ownership-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const componentRoot = path.join(root, "apps", "web", "components");
  await mkdir(componentRoot, { recursive: true });
  await writeFile(path.join(componentRoot, "button.tsx"), "export {};\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      uiComposition: {
        primitiveRoot: "components/ui",
        genericRoots: [],
        genericFiles: [],
        applicationRoots: [],
        featureRoot: "features",
        shadcnPrimitiveNames: ["button"]
      }
    },
    projects: [{ name: "web", type: "app", root: "apps/web" }]
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "shadcn-primitive-ownership");
});

test("rejects generic and feature UI outside their owners", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-ui-ownership-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = path.join(root, "apps", "web");
  const packageRoot = path.join(root, "packages", "ui");
  await mkdir(path.join(appRoot, "components", "layout"), { recursive: true });
  await mkdir(path.join(packageRoot, "src", "features", "orders"), { recursive: true });
  await writeFile(path.join(appRoot, "components", "layout", "shell.tsx"), "export {}\n", "utf8");
  await writeFile(path.join(packageRoot, "src", "features", "orders", "order-card.tsx"), "export {}\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      uiComposition: {
        packageProject: "ui",
        primitiveRoot: "src/primitives",
        genericRoots: ["src/components", "src/compositions"],
        genericFiles: [],
        applicationRoots: ["components/workspace"],
        appForbiddenGenericRoots: ["components/layout"],
        featureRoot: "features",
        shadcnPrimitiveNames: []
      }
    },
    projects: [
      { name: "web", type: "app", root: "apps/web" },
      { name: "ui", type: "package", root: "packages/ui" }
    ]
  });

  assert.equal(findings.filter(({ rule }) => rule === "generic-ui-ownership").length, 1);
  assert.equal(findings.filter(({ rule }) => rule === "feature-ui-ownership").length, 1);
});

test("rejects flat constants dumping grounds", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-constants-dumping-ground-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const constantsRoot = path.join(root, "servers", "api", "constants");
  await mkdir(constantsRoot, { recursive: true });
  await writeFile(path.join(constantsRoot, "errors.ts"), "export {}\n", "utf8");
  await writeFile(path.join(constantsRoot, "http.ts"), "export {}\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: { foundation: { ignoredDirectories: [] }, boundaries: {} },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.equal(findings.filter(({ rule }) => rule === "constants-dumping-ground").length, 1);
});

test("rejects external implementations hidden outside server integrations", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-integration-boundary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "servers", "api", "config");
  await mkdir(configRoot, { recursive: true });
  await writeFile(path.join(configRoot, "database.ts"), "import mongoose from 'mongoose';\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      integrations: { serverDirectory: "integrations", externalImplementationPackages: ["mongoose"] }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "external-integration-boundary");
});

test("allows a server-owned external implementation inside its integration boundary", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-reusable-integration-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const integrationRoot = path.join(root, "servers", "api", "integrations", "mongodb");
  await mkdir(integrationRoot, { recursive: true });
  await writeFile(path.join(integrationRoot, "client.ts"), "import mongoose from 'mongoose';\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      integrations: {
        serverDirectory: "integrations",
        externalImplementationPackages: ["mongoose"]
      }
    },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.equal(findings.length, 0);
});

test("requires categorized modules to expose indexes without root dumping-ground files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-module-surface-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const typesRoot = path.join(root, "apps", "web", "types");
  await mkdir(path.join(typesRoot, "configuration"), { recursive: true });
  await writeFile(path.join(typesRoot, "misc.ts"), "export type Misc = string;\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      moduleBoundaries: [{ project: "web", root: "types", categories: ["configuration"] }]
    },
    projects: [{ name: "web", type: "app", root: "apps/web" }]
  });

  assert.equal(findings.filter(({ rule }) => rule === "module-public-surface").length, 2);
  assert.equal(findings.filter(({ rule }) => rule === "module-dumping-ground").length, 1);
});

test("rejects consumers bypassing a categorized module public index", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-module-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "apps", "web");
  await mkdir(path.join(projectRoot, "components", "feedback"), { recursive: true });
  await mkdir(path.join(projectRoot, "app"), { recursive: true });
  await writeFile(path.join(projectRoot, "components", "index.ts"), "export * from './feedback';\n", "utf8");
  await writeFile(path.join(projectRoot, "components", "feedback", "index.ts"), "export * from './message';\n", "utf8");
  await writeFile(path.join(projectRoot, "components", "feedback", "message.tsx"), "export const Message = () => null;\n", "utf8");
  await writeFile(path.join(projectRoot, "app", "page.tsx"), "import '@/components/feedback/message';\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      moduleBoundaries: [{ project: "web", root: "components", categories: ["feedback"] }]
    },
    projects: [{ name: "web", type: "app", root: "apps/web" }]
  });

  assert.equal(findings.filter(({ rule }) => rule === "module-public-import").length, 1);
});

test("rejects deep imports that bypass a workspace package public root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-package-public-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "packages", "types");
  const appRoot = path.join(root, "apps", "web");
  await mkdir(path.join(packageRoot, "src", "api"), { recursive: true });
  await mkdir(appRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@workspace/types" }), "utf8");
  await writeFile(path.join(packageRoot, "src", "index.ts"), "export * from './api';\n", "utf8");
  await writeFile(path.join(packageRoot, "src", "api", "index.ts"), "export type Health = 'ok';\n", "utf8");
  await writeFile(path.join(appRoot, "page.ts"), "import type { Health } from '@workspace/types/api';\nexport const status: Health = 'ok';\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: {
      foundation: { ignoredDirectories: [] },
      boundaries: {},
      moduleBoundaries: [{ project: "types", root: "src", categories: ["api"] }]
    },
    projects: [
      { name: "web", type: "app", root: "apps/web" },
      { name: "types", type: "package", root: "packages/types" }
    ]
  });

  assert.equal(findings.filter(({ rule }) => rule === "module-public-import").length, 1);
});

test("rejects server consumers that bypass a feature root public API", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-feature-public-import-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const serverRoot = path.join(root, "servers", "api");
  await mkdir(path.join(serverRoot, "bootstrap"), { recursive: true });
  await mkdir(path.join(serverRoot, "features", "health", "routes"), { recursive: true });
  await writeFile(path.join(serverRoot, "features", "health", "index.ts"), "export * from './routes/index.js';\n", "utf8");
  await writeFile(path.join(serverRoot, "features", "health", "routes", "index.ts"), "export * from './health.route.js';\n", "utf8");
  await writeFile(path.join(serverRoot, "features", "health", "routes", "health.route.ts"), "export const createHealthRoutes = () => undefined;\n", "utf8");
  await writeFile(path.join(serverRoot, "bootstrap", "create-app.ts"), "import { createHealthRoutes } from '../features/health/routes/index.js';\nexport const app = createHealthRoutes();\n", "utf8");

  const findings = await validateArchitectureBoundaries({
    root,
    architecture: { foundation: { ignoredDirectories: [] }, boundaries: {}, moduleBoundaries: [] },
    projects: [{ name: "api", type: "server", root: "servers/api" }]
  });

  assert.equal(findings.filter(({ rule }) => rule === "feature-public-import").length, 1);
});
