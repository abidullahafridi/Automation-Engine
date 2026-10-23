import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { discoverWorkspace } from "../workspace/discovery.mjs";
import { checkGitGovernance } from "./git-governance.mjs";

const commitlintCli = path.resolve("node_modules", "@commitlint", "cli", "cli.js");
const lintStagedCli = path.resolve("node_modules", "lint-staged", "bin", "lint-staged.js");
const run = (command, args, options = {}) => spawnSync(command, args, {
  cwd: process.cwd(),
  encoding: "utf8",
  ...options
});

test("repository Git governance files satisfy the control-plane contract", async () => {
  assert.deepEqual(await checkGitGovernance(await discoverWorkspace()), []);
});

for (const [message, valid] of [
  ["feat(auth): add session creation", true],
  ["feature(auth): add session creation", false],
  ["fix:", false],
  ["not a conventional commit", false],
  ["feat(api)!: change authentication contract", true]
]) {
  test(`Commitlint ${valid ? "accepts" : "rejects"} ${JSON.stringify(message)}`, () => {
    const result = run(process.execPath, [commitlintCli], { input: `${message}\n` });
    assert.equal(result.status === 0, valid, `${result.stdout}\n${result.stderr}`);
  });
}

test("lint-staged selects staged supported files and propagates command failures", async (context) => {
  const root = await mkdtemp(path.join(process.cwd(), ".lint-staged-governance-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: root,
    XDG_CONFIG_HOME: root
  };
  const commandLog = path.join(root, "processed.txt");
  await writeFile(path.join(root, "task.mjs"), `
import { appendFileSync } from "node:fs";
import path from "node:path";
const files = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, files.map((file) => path.basename(file)).join("\\n") + "\\n");
if (files.some((file) => path.basename(file) === "blocked.txt")) process.exit(7);
`, "utf8");
  const configPath = path.join(root, "lint-staged.config.cjs");
  await writeFile(configPath, "module.exports = { \"*.txt\": \"node task.mjs\" };\n", "utf8");
  await writeFile(path.join(root, "supported.txt"), "staged\n", "utf8");
  await writeFile(path.join(root, "irrelevant.md"), "unstaged\n", "utf8");
  assert.equal(run("git", ["init"], { cwd: root, env: gitEnv }).status, 0);
  assert.equal(run("git", ["add", "supported.txt"], { cwd: root, env: gitEnv }).status, 0);

  const selected = run(process.execPath, [lintStagedCli, "--cwd", root, "--config", configPath], { env: gitEnv });
  assert.equal(selected.status, 0, `${selected.stdout}\n${selected.stderr}`);
  const processed = await readFile(commandLog, "utf8");
  assert.match(processed, /supported\.txt/);
  assert.doesNotMatch(processed, /irrelevant\.md/);

  await writeFile(path.join(root, "blocked.txt"), "staged and rejected\n", "utf8");
  assert.equal(run("git", ["add", "blocked.txt"], { cwd: root, env: gitEnv }).status, 0);
  const blocked = run(process.execPath, [lintStagedCli, "--cwd", root, "--config", configPath], { env: gitEnv });
  assert.notEqual(blocked.status, 0);
});
