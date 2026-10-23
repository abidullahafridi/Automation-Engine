import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cli = path.resolve("codebase/cli/repo.mjs");

test("emits stable JSON for affected analysis", () => {
  const result = spawnSync(process.execPath, [cli, "affected", "--changed", "architecture.yaml", "--json"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.globalChange, true);
  assert.deepEqual(output.changedFiles, [{ path: "architecture.yaml", owner: null }]);
});

test("emits structured JSON errors and a failing exit code", () => {
  const result = spawnSync(process.execPath, [cli, "missing", "--json"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { kind: "error", ok: false, error: { message: "Unknown command: missing" } });
});
