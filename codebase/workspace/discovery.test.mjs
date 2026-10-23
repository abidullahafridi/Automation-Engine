import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverWorkspace } from "./discovery.mjs";

test("discovers projects nested below an ownership group", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-discovery-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const architecture = {
    version: 1,
    foundation: {
      projectRoots: { apps: "app" },
      requiredRoots: ["apps"],
      requiredFiles: [],
      ignoredDirectories: ["node_modules"]
    },
    boundaries: {}
  };
  const projectRoot = path.join(root, "apps", "store", "web");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(path.join(root, "architecture.yaml"), JSON.stringify(architecture), "utf8");
  await writeFile(path.join(projectRoot, "project.json"), JSON.stringify({
    name: "store-web",
    type: "app",
    tasks: {}
  }), "utf8");

  const workspace = await discoverWorkspace({ workspaceRoot: root });
  assert.equal(workspace.projects.length, 1);
  assert.equal(workspace.projects[0].root, "apps/store/web");
});

test("discovers custom app and server names directly beneath workspace roots", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-direct-units-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const architecture = {
    version: 1,
    foundation: {
      projectRoots: { apps: "app", servers: "server" },
      requiredRoots: ["apps", "servers"],
      requiredFiles: [],
      ignoredDirectories: []
    },
    boundaries: {}
  };
  await mkdir(path.join(root, "apps", "portal"), { recursive: true });
  await mkdir(path.join(root, "servers", "gateway"), { recursive: true });
  await writeFile(path.join(root, "architecture.yaml"), JSON.stringify(architecture), "utf8");
  await writeFile(path.join(root, "apps", "portal", "project.json"), JSON.stringify({ name: "portal", type: "app", tasks: {} }), "utf8");
  await writeFile(path.join(root, "servers", "gateway", "project.json"), JSON.stringify({ name: "gateway", type: "server", tasks: {} }), "utf8");
  const workspace = await discoverWorkspace({ workspaceRoot: root });
  assert.deepEqual(workspace.projects.map(({ name, root: unitRoot }) => [name, unitRoot]), [
    ["gateway", "servers/gateway"],
    ["portal", "apps/portal"]
  ]);
});
