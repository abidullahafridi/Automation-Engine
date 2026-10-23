import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathExists, readJsonFile } from "../utilities/fs.mjs";

const issue = (message) => ({ level: "error", message });

const readSource = async (workspaceRoot, relativePath) => {
  const filePath = path.join(workspaceRoot, relativePath);
  return await pathExists(filePath) ? readFile(filePath, "utf8") : "";
};

export const checkGitGovernance = async (workspace) => {
  const policy = workspace.architecture.gitGovernance ?? {};
  const issues = [];
  const packageJson = await readJsonFile(path.join(workspace.root, "package.json"));

  for (const [name, version] of Object.entries(policy.tools ?? {})) {
    if (packageJson.devDependencies?.[name] !== version) {
      issues.push(issue(`Root package.json must pin Git governance tool ${name} to ${version}.`));
    }
  }

  const expectedScripts = {
    prepare: "husky",
    commitlint: "commitlint",
    "lint:staged": "lint-staged"
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (packageJson.scripts?.[name] !== command) {
      issues.push(issue(`Root script ${name} must delegate to ${command}.`));
    }
  }

  const expectedHooks = {
    "pre-commit": "pnpm run lint:staged && pnpm run scan",
    "commit-msg": "pnpm run commitlint --edit \"$1\"",
    "pre-push": "pnpm run check"
  };
  for (const [name, expected] of Object.entries(expectedHooks)) {
    const source = (await readSource(workspace.root, `.husky/${name}`)).trim();
    if (source !== expected) issues.push(issue(`.husky/${name} must remain a thin delegation to repository scripts.`));
  }

  const commitlint = await readSource(workspace.root, "commitlint.config.mjs");
  if (!commitlint.includes("@commitlint/config-conventional")) {
    issues.push(issue("Commitlint must extend the Conventional Commits configuration."));
  }
  const lintStaged = await readSource(workspace.root, "lint-staged.config.mjs");
  for (const root of ["apps/web", "servers/api", "packages/logging", "packages/types", "packages/ui"]) {
    if (!lintStaged.includes(root) || !lintStaged.includes("eslint")) {
      issues.push(issue(`lint-staged must route ${root} TypeScript files to its existing ESLint configuration.`));
    }
  }

  const workflow = await readSource(workspace.root, ".github/workflows/control-plane.yml");
  for (const contract of ["permissions:\n  contents: read", "fetch-depth: 0", "pnpm run commitlint"]) {
    if (!workflow.includes(contract)) issues.push(issue(`Control Plane workflow is missing governance contract: ${contract}.`));
  }
  const requiredCiJobs = ["architecture", "quality", "automation-suite", "security", "build"];
  for (const jobName of requiredCiJobs) {
    if (!new RegExp(`^  ${jobName}:`, "m").test(workflow)) {
      issues.push(issue(`Control Plane workflow is missing required CI job ${jobName}.`));
    }
  }
  for (const contract of [
    "pnpm run node:check",
    "pnpm run check",
    "pnpm run lint",
    "pnpm run typecheck",
    "pnpm test",
    "pnpm run scan",
    "pnpm run build",
    "needs: [architecture, quality, automation-suite, security, build, commit-message]",
    "if: ${{ always() }}",
    'test "$SECURITY_RESULT" = success',
    'test "$COMMIT_MESSAGE_RESULT" = success'
  ]) {
    if (!workflow.includes(contract)) issues.push(issue(`Control Plane workflow is missing required CI contract: ${contract}.`));
  }
  if (/uses:\s+[^\s#]+@v\d+\b/.test(workflow)) {
    issues.push(issue("GitHub Actions must be pinned to immutable commit SHAs."));
  }

  const pullRequestTemplate = await readSource(workspace.root, ".github/pull_request_template.md");
  for (const heading of ["## Summary", "## Why", "## Architecture impact", "## Security impact", "## Testing / validation"]) {
    if (!pullRequestTemplate.includes(heading)) issues.push(issue(`Pull request template is missing ${heading}.`));
  }
  const codeowners = await readSource(workspace.root, ".github/CODEOWNERS");
  for (const owner of policy.codeOwners ?? []) {
    if (!codeowners.includes(owner)) issues.push(issue(`CODEOWNERS must route reviews to established owner ${owner}.`));
  }

  const rulesetPath = path.join(workspace.root, ".github", "rulesets", "main.json");
  if (!(await pathExists(rulesetPath))) {
    issues.push(issue("The versioned main-branch ruleset payload is missing."));
  } else {
    const ruleset = await readJsonFile(rulesetPath);
    const ruleTypes = new Set((ruleset.rules ?? []).map(({ type }) => type));
    for (const type of ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]) {
      if (!ruleTypes.has(type)) issues.push(issue(`Main-branch ruleset is missing ${type}.`));
    }
    const statusRule = (ruleset.rules ?? []).find(({ type }) => type === "required_status_checks");
    const contexts = statusRule?.parameters?.required_status_checks?.map(({ context }) => context) ?? [];
    if (!contexts.includes(policy.requiredStatusCheck)) {
      issues.push(issue(`Main-branch ruleset must require status check ${policy.requiredStatusCheck}.`));
    }
  }

  for (const forbidden of ["codebase/git", "codebase/commits", "codebase/branches", "codebase/hooks", "codebase/git-policies"]) {
    if (await pathExists(path.join(workspace.root, forbidden))) {
      issues.push(issue(`Custom Git subsystem is prohibited: ${forbidden}.`));
    }
  }

  return issues;
};
