# Agent Operating Guide

Agents working in this repository must treat the repository itself as the workspace and
the monorepo foundation as the product being implemented. There is no mandatory
`<project>` path segment: workspace units live under physical roots such as `apps/web`
and `servers/api`. These are defaults, not directories to create without a real need.

Before changing code:

1. Read this file and `architecture.yaml`.
2. Inspect the relevant workspace unit through the repository control plane.
3. Keep dependencies explicit and boundaries clear.
4. Prefer functional modules, pure functions, immutable data, and explicit dependency passing.
5. Run the smallest useful validation command after changes.

Read the narrowest authoritative guide for the work:

- `.agent/instructions/architecture.md` for planes, feature ownership, and dependency direction.
- `.agent/instructions/ui-composition.md` for shadcn, Tailwind, component hierarchy, and page composition.
- `.agent/instructions/integrations.md` for external systems and reusable infrastructure.
- `.agent/standards/types-validation.md` for local versus shared contracts and runtime schemas.
- `.agent/standards/testing.md` for unit, component, integration, and end-to-end test intent.
- `.agent/standards/development.md` for functional implementation and progressive growth.

Classify the scope before editing: application, reusable package, infrastructure/enabler,
project knowledge, foundation, or control plane. Application work does not authorize
foundation or control-plane changes.

Implementation follows `UNDERSTAND -> PLAN -> IMPLEMENT -> VALIDATE -> REVIEW -> RECORD -> COMPLETE`.
Create feature-owned code first, add layers only when a concrete boundary requires them,
and extract packages only after ownership and genuine cross-boundary reuse are established.
The governing principle is: everything available, nothing unnecessarily imposed.

Architecture is feature-first. Server features are flat by default, using optional files
such as `<feature>.route.ts`, `<feature>.controller.ts`, `<feature>.service.ts`,
`<feature>.repository.ts`, `<feature>.validation.ts`, `<feature>.model.ts`, and
`<feature>.integration.ts`. Introduce `domain/` only for meaningful domain complexity.
Do not create role folders or any other architectural directory merely to represent a pattern.

The control plane lives in `codebase/`. It owns repository discovery, dependency graphing,
execution planning, task ordering, caching, repository policy, result normalization, and
the CLI. It must not use Turborepo, Nx, Lerna, or another third-party monorepo orchestrator
as its foundation.

The control plane orchestrates established technical tools instead of reimplementing them.
pnpm owns package resolution and dependency auditing; `tsc` owns TypeScript analysis;
ESLint owns lint analysis; project-declared runners own tests; and TruffleHog owns secret
detection. Custom checks are reserved for repository-specific architecture and governance.
Missing required tools and tool execution failures must fail clearly rather than becoming
successful scans. `pnpm run scan` bootstraps the architecture-pinned TruffleHog release into
the ignored repository cache after verifying its official SHA-256 checksum and version; it
also contacts the configured package registry through `pnpm audit`.

`architecture.yaml` uses the JSON-compatible subset of YAML so Node.js can load the
authoritative policy without adding a parser dependency to the control plane.

pnpm is the repository package manager. Internal package dependencies use `workspace:*`,
and `pnpm-workspace.yaml` is the authoritative package-workspace definition.

Workspace-unit code under `apps/`, `servers/`, `packages/`, and `prebuilt/` may use appropriate external libraries. The control plane should stay dependency-light and prefer Node.js built-ins plus repository-owned code. `packages/` owns reusable pieces; `prebuilt/` owns assembled reusable solutions; `enablers/` owns operational support.

Useful commands:

```text
pnpm run projects
pnpm run graph
pnpm run tasks
pnpm run dev
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm run check
pnpm run scan
pnpm test
```

Workspace-unit tasks run through `node codebase/cli/repo.mjs run <task>`. Use `--dry-run` to
inspect ordering and `--json` when another tool needs stable output.
