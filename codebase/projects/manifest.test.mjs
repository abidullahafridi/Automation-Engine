import test from "node:test";
import assert from "node:assert/strict";
import { validateProjectManifest } from "./manifest.mjs";

const validProject = {
  name: "orders-api",
  type: "server",
  root: "servers/store/orders-api",
  internalDependencies: [],
  externalDependencies: [],
  capabilities: [],
  tasks: [{ name: "build", command: "npm run build" }]
};

test("accepts a valid project manifest", () => {
  assert.deepEqual(validateProjectManifest(validProject), []);
});

test("accepts a config project without invented tasks", () => {
  assert.deepEqual(validateProjectManifest({ ...validProject, name: "tsconfig", type: "config", tasks: [] }), []);
});

test("rejects ambiguous project names and types", () => {
  const issues = validateProjectManifest({ ...validProject, name: "Orders API", type: "service" });
  assert.equal(issues.filter((issue) => issue.level === "error").length, 2);
});
