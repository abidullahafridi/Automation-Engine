import test from "node:test";
import assert from "node:assert/strict";
import { findAffectedWorkspaceUnits, findOwningWorkspaceUnit } from "./affected-units.mjs";

const project = (name, root, internalDependencies = []) => ({ name, root, type: "package", internalDependencies });

test("finds the most specific owning workspace unit", () => {
  const projects = [project("store", "apps/store"), project("store-web", "apps/store/web")];
  assert.equal(findOwningWorkspaceUnit({ projects, filePath: "apps/store/web/src/page.ts" }).name, "store-web");
});

test("propagates affected units through reverse dependencies in dependency order", () => {
  const workspace = {
    root: process.cwd(),
    projects: [
      project("web", "apps/web", ["api"]),
      project("core", "packages/core"),
      project("api", "servers/api", ["core"]),
      project("other", "packages/other")
    ]
  };
  const result = findAffectedWorkspaceUnits({ workspace, changedFiles: ["packages/core/src/index.ts"] });
  assert.deepEqual(result.units, ["core", "api", "web"]);
  assert.deepEqual(result.changedFiles, [{ path: "packages/core/src/index.ts", owner: "core" }]);
});

test("treats control-plane changes as workspace-wide", () => {
  const workspace = { root: process.cwd(), projects: [project("one", "packages/one"), project("two", "packages/two")] };
  const result = findAffectedWorkspaceUnits({ workspace, changedFiles: ["architecture.yaml"] });
  assert.equal(result.globalChange, true);
  assert.deepEqual(result.units, ["one", "two"]);
});
