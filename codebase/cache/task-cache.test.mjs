import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fingerprintTask, getTaskCachePath, hasReusableTaskResult } from "./task-cache.mjs";

const fixture = async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "packages", "unit", "dist"), { recursive: true });
  await writeFile(path.join(root, "packages", "unit", "source.txt"), "one", "utf8");
  await writeFile(path.join(root, "packages", "unit", "dist", "result.txt"), "ok", "utf8");
  return root;
};

const task = {
  id: "unit:build", projectRoot: "packages/unit", command: "build", inputs: ["source.txt"],
  outputs: ["dist"], cache: true, taskDependencies: ["base:build"], environment: ["BUILD_MODE"]
};
const fingerprint = (root, options = {}) => fingerprintTask({
  workspaceRoot: root, task, dependencyFingerprints: new Map([["base:build", options.dependency ?? "one"]]),
  ignoredDirectories: new Set(["dist"]), workspaceConfiguration: options.configuration ?? { version: 1 },
  environment: { BUILD_MODE: options.environment ?? "dev" }
});

test("invalidates task fingerprints for source, dependency, configuration, and environment changes", async (context) => {
  const root = await fixture(context);
  const initial = await fingerprint(root);
  await writeFile(path.join(root, "packages", "unit", "source.txt"), "two", "utf8");
  assert.notEqual(await fingerprint(root), initial);
  await writeFile(path.join(root, "packages", "unit", "source.txt"), "one", "utf8");
  assert.notEqual(await fingerprint(root, { dependency: "two" }), initial);
  assert.notEqual(await fingerprint(root, { configuration: { version: 2 } }), initial);
  assert.notEqual(await fingerprint(root, { environment: "production" }), initial);
});

test("ignores corrupt cache entries", async (context) => {
  const root = await fixture(context);
  const value = await fingerprint(root);
  const cachePath = getTaskCachePath(root, task);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, "not json", "utf8");
  assert.equal(await hasReusableTaskResult({ workspaceRoot: root, task, fingerprint: value }), false);
});
