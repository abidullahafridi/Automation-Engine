import test from "node:test";
import assert from "node:assert/strict";
import { createDependencyGraph } from "../graph/dependency-graph.mjs";
import { createAffectedExecutionPlan, createExecutionPlan, listTasks } from "./tasks.mjs";

const task = (name, dependsOn = []) => ({ name, command: `run ${name}`, dependsOn, inputs: [], outputs: [], cache: false });
const project = (name, internalDependencies, tasks) => ({
  name,
  type: "package",
  root: `packages/${name}`,
  internalDependencies,
  tasks
});

test("plans project and explicit task dependencies", () => {
  const projects = [
    project("core", [], [task("build")]),
    project("api", ["core"], [task("prepare"), task("build", ["prepare"])])
  ];
  const graph = createDependencyGraph(projects);
  const plan = createExecutionPlan({ graph, projects, tasks: listTasks(projects), taskName: "build" });
  assert.deepEqual(plan.map((item) => item.id), ["core:build", "api:prepare", "api:build"]);
});

test("rejects missing task dependencies", () => {
  const projects = [project("api", [], [task("build", ["missing"])])];
  assert.throws(
    () => createExecutionPlan({
      graph: createDependencyGraph(projects),
      projects,
      tasks: listTasks(projects),
      taskName: "build"
    }),
    /unknown task api:missing/
  );
});

test("rejects task cycles", () => {
  const projects = [project("api", [], [task("one", ["two"]), task("two", ["one"])])];
  assert.throws(
    () => createExecutionPlan({
      graph: createDependencyGraph(projects),
      projects,
      tasks: listTasks(projects),
      taskName: "one"
    }),
    /Task dependency cycle/
  );
});

test("plans only affected tasks and their required dependencies", () => {
  const projects = [
    project("core", [], [task("build")]),
    project("api", ["core"], [task("prepare"), task("build", ["prepare"])]),
    project("web", ["api"], [task("build")]),
    project("other", [], [task("build")])
  ];
  const tasks = listTasks(projects);
  const plan = createAffectedExecutionPlan({
    graph: createDependencyGraph(projects), projects, tasks, taskName: "build", affectedUnits: ["api"]
  });
  assert.deepEqual(plan.map((item) => item.id), ["core:build", "api:prepare", "api:build"]);
});
