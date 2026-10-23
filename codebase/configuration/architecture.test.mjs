import test from "node:test";
import assert from "node:assert/strict";
import { readArchitecture, validateArchitectureConfiguration } from "./architecture.mjs";

test("validates architecture policy structure and workspace unit types", () => {
  const issues = validateArchitectureConfiguration({
    version: 0,
    foundation: { projectRoots: { "../outside": "service" }, requiredRoots: "apps" }
  });
  assert.ok(issues.some((issue) => issue.message.includes("positive integer version")));
  assert.ok(issues.some((issue) => issue.message.includes("Invalid workspace unit root")));
  assert.ok(issues.some((issue) => issue.message.includes("invalid type")));
  assert.ok(issues.some((issue) => issue.message.includes("requiredRoots must be an array")));
  assert.ok(issues.some((issue) => issue.message.includes("missing boundary")));
});

test("requires pinned managed TruffleHog filesystem policy", async () => {
  const architecture = await readArchitecture(process.cwd());
  const invalid = structuredClone(architecture);
  invalid.security.secretScan = {
    engine: "trufflehog",
    version: "",
    execution: "host-path",
    scanMode: "git",
    resultClasses: ["verified"],
    configuration: ".trufflehog-exclude-paths.txt"
  };
  const issues = validateArchitectureConfiguration(invalid);
  assert.ok(issues.some((issue) => issue.message.includes("managed TruffleHog filesystem")));
});

test("requires the repository Git governance contract", async () => {
  const architecture = await readArchitecture(process.cwd());
  const invalid = structuredClone(architecture);
  invalid.gitGovernance.hooks = "custom-hooks";
  const issues = validateArchitectureConfiguration(invalid);
  assert.ok(issues.some((issue) => issue.message.includes("Git governance")));
});
