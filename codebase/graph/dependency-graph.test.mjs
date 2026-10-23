import test from "node:test";
import assert from "node:assert/strict";
import { createDependencyGraph, findGraphIssues, topologicalProjectOrder } from "./dependency-graph.mjs";

const project = (name, internalDependencies = []) => ({ name, type: "package", root: `packages/${name}`, internalDependencies });

test("orders dependencies before dependents", () => {
  const graph = createDependencyGraph([
    project("web", ["orders"]),
    project("orders", ["database"]),
    project("database")
  ]);
  assert.deepEqual(topologicalProjectOrder(graph), {
    ordered: ["database", "orders", "web"],
    cycles: []
  });
});

test("reports unknown projects and cycles", () => {
  const unknownGraph = createDependencyGraph([project("web", ["missing"])]);
  assert.equal(findGraphIssues(unknownGraph).length, 1);

  const cyclicGraph = createDependencyGraph([project("one", ["two"]), project("two", ["one"])]);
  assert.deepEqual(topologicalProjectOrder(cyclicGraph).cycles.sort(), ["one", "two"]);
});
