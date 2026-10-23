import test from "node:test";
import assert from "node:assert/strict";
import { runDependencyScan } from "./dependency-scan.mjs";

test("normalizes a clean pnpm audit report", async () => {
  const scan = await runDependencyScan({
    workspaceRoot: process.cwd(),
    commandRunner: async ({ command, args }) => {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["audit", "--json", "--audit-level", "high"]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: { total: 0 } } }),
        stderr: "",
        durationMs: 4
      };
    }
  });

  assert.equal(scan.result.status, "passed");
  assert.equal(scan.result.findingCount, 0);
  assert.deepEqual(scan.issues, []);
});

test("turns pnpm advisories into repository policy failures", async () => {
  const scan = await runDependencyScan({
    workspaceRoot: process.cwd(),
    commandRunner: async () => ({
      exitCode: 1,
      stdout: JSON.stringify({
        advisories: {
          100: {
            id: 100,
            github_advisory_id: "GHSA-test-test-test",
            module_name: "fixture-package",
            severity: "critical"
          }
        }
      }),
      stderr: "",
      durationMs: 5
    })
  });

  assert.equal(scan.result.status, "failed");
  assert.equal(scan.issues[0].rule, "dependency-vulnerability");
  assert.match(scan.issues[0].message, /GHSA-test-test-test/);
});

test("fails closed when pnpm audit cannot produce a report", async () => {
  const scan = await runDependencyScan({
    workspaceRoot: process.cwd(),
    commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "registry unavailable", durationMs: 3 })
  });

  assert.equal(scan.result.status, "failed");
  assert.equal(scan.issues[0].rule, "security-tool-failure");
});
