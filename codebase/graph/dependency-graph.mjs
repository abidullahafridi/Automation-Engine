export const createDependencyGraph = (projects) => {
  const projectNames = new Set(projects.map((project) => project.name));
  const nodes = projects.map((project) => ({
    name: project.name,
    type: project.type,
    root: project.root
  }));

  const edges = projects.flatMap((project) =>
    project.internalDependencies.map((dependency) => ({
      from: project.name,
      to: dependency,
      valid: projectNames.has(dependency)
    }))
  );

  return { nodes, edges };
};

export const findGraphIssues = (graph) =>
  graph.edges
    .filter((edge) => !edge.valid)
    .map((edge) => ({
      level: "error",
      message: `${edge.from} depends on unknown internal project ${edge.to}.`
    }));

export const topologicalProjectOrder = (graph) => {
  const nodeNames = graph.nodes.map((node) => node.name);
  const incomingCounts = new Map(nodeNames.map((name) => [name, 0]));
  const dependentsByDependency = new Map(nodeNames.map((name) => [name, []]));

  for (const edge of graph.edges.filter((item) => item.valid)) {
    incomingCounts.set(edge.from, (incomingCounts.get(edge.from) ?? 0) + 1);
    dependentsByDependency.set(edge.to, [...(dependentsByDependency.get(edge.to) ?? []), edge.from]);
  }

  const ready = [...incomingCounts.entries()]
    .filter(([, count]) => count === 0)
    .map(([name]) => name)
    .sort();
  const ordered = [];

  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(name);

    for (const dependent of dependentsByDependency.get(name) ?? []) {
      const nextCount = (incomingCounts.get(dependent) ?? 0) - 1;
      incomingCounts.set(dependent, nextCount);

      if (nextCount === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  return {
    ordered,
    cycles: nodeNames.filter((name) => !ordered.includes(name))
  };
};
