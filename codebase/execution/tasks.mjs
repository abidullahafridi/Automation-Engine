export const listTasks = (projects) =>
  projects.flatMap((project) =>
    project.tasks.map((task) => ({
      id: `${project.name}:${task.name}`,
      project: project.name,
      projectRoot: project.root,
      name: task.name,
      command: task.command,
      dependsOn: task.dependsOn,
      inputs: task.inputs,
      outputs: task.outputs,
      environment: task.environment ?? [],
      cache: task.cache
    }))
  );

export const filterTasksByName = ({ tasks, taskName }) =>
  tasks.filter((task) => task.name === taskName || task.id === taskName);

const resolveDeclaredDependencyIds = ({ task, project }) =>
  task.dependsOn.flatMap((dependency) => {
    if (dependency.startsWith("^")) {
      const dependencyTaskName = dependency.slice(1);
      return project.internalDependencies.map((projectName) => `${projectName}:${dependencyTaskName}`);
    }
    return dependency.includes(":") ? [dependency] : [`${task.project}:${dependency}`];
  });

export const createExecutionPlanForTasks = ({ graph, projects, tasks, requestedTaskIds }) => {
  const requestedTasks = requestedTaskIds.map((id) => tasks.find((task) => task.id === id)).filter(Boolean);
  const missingRequested = requestedTaskIds.filter((id) => !requestedTasks.some((task) => task.id === id));
  if (missingRequested.length > 0) throw new Error(`No task matches "${missingRequested.join(", ")}".`);

  const projectsByName = new Map(projects.map((project) => [project.name, project]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const dependenciesByTask = new Map();

  for (const task of tasks) {
    const project = projectsByName.get(task.project) ?? { internalDependencies: [] };
    const sameTaskDependencies = project.internalDependencies
      .map((projectName) => `${projectName}:${task.name}`)
      .filter((id) => tasksById.has(id));
    const declaredDependencies = resolveDeclaredDependencyIds({ task, project });
    const dependencyIds = [...new Set([...sameTaskDependencies, ...declaredDependencies])];
    const missing = dependencyIds.filter((id) => !tasksById.has(id));
    if (missing.length > 0) throw new Error(`${task.id} depends on unknown task ${missing.join(", ")}.`);
    dependenciesByTask.set(task.id, dependencyIds);
  }

  const required = new Set();
  const visitRequired = (id) => {
    if (required.has(id)) return;
    required.add(id);
    for (const dependencyId of dependenciesByTask.get(id) ?? []) visitRequired(dependencyId);
  };
  requestedTasks.forEach((task) => visitRequired(task.id));

  const state = new Map();
  const orderedIds = [];
  const visit = (id, ancestry = []) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      throw new Error(`Task dependency cycle: ${[...ancestry, id].join(" -> ")}`);
    }
    state.set(id, "visiting");
    for (const dependencyId of dependenciesByTask.get(id) ?? []) {
      if (required.has(dependencyId)) visit(dependencyId, [...ancestry, id]);
    }
    state.set(id, "done");
    orderedIds.push(id);
  };
  [...required].sort().forEach((id) => visit(id));

  return orderedIds.map((id) => {
    const task = tasksById.get(id);
    return {
      ...task,
      taskDependencies: dependenciesByTask.get(id) ?? [],
      projectDependencies: graph.edges
        .filter((edge) => edge.valid && edge.from === task.project)
        .map((edge) => edge.to)
        .sort()
    };
  });
};

export const createExecutionPlan = ({ graph, projects, tasks, taskName }) => {
  const requestedTasks = filterTasksByName({ tasks, taskName });
  if (requestedTasks.length === 0) throw new Error(`No task matches "${taskName}".`);
  return createExecutionPlanForTasks({
    graph,
    projects,
    tasks,
    requestedTaskIds: requestedTasks.map((task) => task.id)
  });
};

export const createAffectedExecutionPlan = ({ graph, projects, tasks, taskName, affectedUnits }) => {
  const affected = new Set(affectedUnits);
  const requestedTaskIds = filterTasksByName({ tasks, taskName })
    .filter((task) => affected.has(task.project))
    .map((task) => task.id);
  if (requestedTaskIds.length === 0) return [];
  return createExecutionPlanForTasks({ graph, projects, tasks, requestedTaskIds });
};
