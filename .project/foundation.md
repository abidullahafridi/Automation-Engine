# Foundation Lifecycle

The foundation is implemented incrementally.

Current baseline:

- Root ownership boundaries are present.
- The repository is the workspace; no mandatory project namespace exists.
- Workspace-unit manifests are defined with `project.json` directly beneath configured physical roots at any justified depth.
- `apps/web` and `servers/api` are conventional defaults, not pre-created requirements; custom unit names remain supported.
- The control plane can discover workspace units, build an internal dependency graph, list tasks, and validate core structure.
- Checks and scans are separate command concepts.

Architecture is feature-first and grows only with demonstrated complexity. Server
features use optional role-named files in a flat feature directory. A `domain/` directory
is introduced only for meaningful domain complexity; role folders are not the default.
Functional composition, immutable data, pure functions where practical, and explicit
dependencies are the repository-wide programming model.

The M03 control plane includes affected workspace-unit and task selection,
dependency-aware parallel execution, local cache invalidation across source,
dependencies, configuration, and selected environment values, reusable architecture
boundary rules, execution profiles, stable machine-readable CLI results, and CI
integration through the same CLI. Remote artifact storage and distributed execution
remain deferred until a concrete workload requires them.
