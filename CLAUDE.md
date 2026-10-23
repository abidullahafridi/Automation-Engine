# Claude Repository Guide

This file is the Claude-facing entry point for this repository. Read it at the start of a
task, then follow the authoritative repository guidance and inspect the current source before
making assumptions. This guide is a map, not a substitute for reading relevant files.

## What this repository is

This repository is an agent-native monorepo foundation; the foundation itself is the product.
The repository root is the workspace. There is no mandatory project-name directory between
the root and workspace units.

Keep the four planes distinct:

```text
Code plane:      apps/, servers/, packages/, prebuilt/
Control plane:   codebase/
Enabler plane:   enablers/
Agent plane:     .agent/, .project/, AGENTS.md, CLAUDE.md, architecture.yaml
```

`architecture.yaml` is the machine-readable architecture policy and uses the JSON-compatible
subset of YAML. `AGENTS.md` is the repository operating guide. Focused documents under
`.agent/`, `.project/`, `enablers/`, `prebuilt/`, and `.github/` are authoritative for their
specific subjects. When a policy or implementation detail is unclear, read its source file;
do not treat this summary as more authoritative than those sources.

## How to understand the repository

Do not try to load dependencies, generated output, caches, or every source file into context.
Discover the workspace first, then read all relevant source, tests, manifests, and guidance for
the task. Never claim to have reviewed files that you have not inspected.

At the beginning of a code task:

1. Read `AGENTS.md`, `architecture.yaml`, `.project/PROJECT-STATE.md`, and
   `.project/foundation.md`.
2. Use the repository CLI to discover workspace units, dependencies, and tasks:

   ```text
   pnpm run projects
   pnpm run graph
   pnpm run tasks
   ```

3. Classify the change by plane and owning unit. Read the narrowest applicable guides listed
   below, then inspect that unit's `project.json`, `package.json`, source, tests, and
   `.env.example` where relevant.
4. Search for existing implementations and consumers before adding abstractions, packages,
   dependencies, or files. Check dependency direction and public exports.
5. Make the smallest complete change, add or update behavior-focused tests when appropriate,
   run the narrowest useful validation, and review the final diff for unrelated changes.
6. Record a durable architecture or project-state decision when the change materially changes
   a contract or repository capability.

Use `node codebase/cli/repo.mjs run <task>` for workspace-unit tasks. Use `--dry-run` to
inspect task ordering and `--json` for stable machine-readable output. Prefer this CLI for
repository discovery, graphing, task selection, checks, and scans; do not invent parallel
repository orchestration commands.

## Current workspace map

The live repository CLI currently discovers these workspace units. Re-run `pnpm run projects`
and `pnpm run graph` because this inventory can change:

| Unit | Path | Ownership |
| --- | --- | --- |
| `web` | `apps/web` | Next.js App Router web application; feature-owned UI and runtime configuration |
| `api` | `servers/api` | Express API runtime, health feature, MongoDB integration, bootstrap and shutdown |
| `ui` | `packages/ui` | Shared shadcn-based UI primitives, generic compositions, hooks, and theme |
| `types` | `packages/types` | Categorized cross-workspace API contracts |
| `logging` | `packages/logging` | Reusable structured application and HTTP logging |
| `eslint-config` | `packages/eslint-config` | Shared ESLint configuration |
| `tsconfig` | `packages/tsconfig` | Shared TypeScript base and runtime presets |

The current dependency graph has no cycles. Applications and servers consume shared
packages; packages must not depend on applications, servers, or prebuilt solutions.

Other current roots:

- `codebase/` contains the repository-owned control plane: CLI, workspace discovery,
  manifests, dependency graph, affected-project selection, execution, cache, checks,
  architecture validation, security scanning, and result contracts. Read the relevant
  implementation and tests before changing it.
- `prebuilt/` currently documents the rules for future composed reusable solutions; do not
  add placeholders or duplicate packages there.
- `enablers/` currently documents operational ownership, including observability. Keep
  operational infrastructure here, not application business logic.
- `apps/web` currently owns the `workspace-foundation` feature and web runtime configuration.
- `servers/api` currently owns the health feature, HTTP middleware, configuration and
  environment validation, MongoDB integration, API contracts, and runtime lifecycle.

`README.md` currently contains only repository headings; use the operating documents and
actual workspace sources as the detailed guidance.

## Architecture and implementation rules

- Keep workspace units directly beneath the configured roots; `apps/web` and `servers/api`
  are current units, not a required namespace pattern for future units.
- Organize business behavior by feature. Start simple and introduce categories only when they
  express real ownership or a concrete growth boundary. Do not add empty directories,
  speculative units, role folders, or abstractions just to match a pattern.
- Server features are flat by default. Optional role-named files include
  `<feature>.route.ts`, `<feature>.controller.ts`, `<feature>.service.ts`,
  `<feature>.repository.ts`, `<feature>.validation.ts`, `<feature>.model.ts`, and
  `<feature>.integration.ts`. Add `domain/` only for meaningful domain complexity.
- Preserve dependency direction: delivery/UI calls application operations; services
  coordinate domain rules and explicit persistence/integration boundaries; domain code stays
  framework- and vendor-independent. Do not deep-import another feature's internals.
- Prefer pure functions, immutable data, composition, factories, and explicit dependency
  objects. Avoid inheritance, service locators, mutable global registries, and DI containers.
- Keep feature/runtime-specific types and validation with their owner. Put categorized
  contracts in `packages/types` only for real cross-workspace reuse. Introduce shared
  validation only when more than one boundary actually consumes it.
- Keep integrations behind explicit contracts. Configuration validates and supplies inputs;
  it must not secretly initialize vendor clients. Keep reusable technical capabilities in
  `packages/`, runtime composition in its app/server, and provisioning/operations in
  `enablers/`.
- Use strict TypeScript. Do not use explicit `any`; narrow `unknown` at boundaries. Follow
  the configured shared TypeScript presets and architecture checks.
- Use pnpm and `workspace:*` for internal dependencies. `pnpm-workspace.yaml` and
  `pnpm-lock.yaml` are authoritative. Do not introduce npm/yarn lockfiles.

## Tooling boundaries

`codebase/` is the custom repository control plane, not a replacement for specialist tools.
It owns repository-specific discovery, dependency graphing, planning, task orchestration,
caching, policy, CLI behavior, and result normalization. It must stay dependency-light and
must not rely on Nx, Turborepo, Lerna, or another external monorepo orchestrator.

Delegate technical work to the established engines:

- pnpm: package management and dependency audit
- `tsc`: TypeScript checking
- ESLint: linting
- each workspace's declared runner: tests
- TruffleHog: secret detection

Do not build homegrown package resolvers, compilers, linters, formatters, test runners, or
secret scanners. Repository-specific architecture and governance checks belong in the control
plane. Missing tools and failed scans must fail clearly, not appear successful.

## UI and integration guidance

Before implementing UI, read `.agent/instructions/ui-composition.md`. Search the configured
shadcn registry first; install a suitable primitive through `pnpm run ui:add <component>`.
Compose upward from primitives to generic `packages/ui` components, then application/feature
UI and pages. Pages should compose capabilities rather than own reusable markup or business
rules. Do not copy registry code manually or create parallel named primitives.

Before connecting an external system, read `.agent/instructions/integrations.md`. Keep
vendor-specific behavior at an explicit integration boundary and do not add an integration
or provider until product behavior requires it.

## Guidance index: read the relevant source

- `AGENTS.md`: complete repository operating process, scope classification, and completion flow.
- `architecture.yaml`: architecture, boundary, package-manager, security, and workspace policy.
- `.agent/operating-model.md`: agent-plane scope and completion expectations.
- `.agent/instructions/architecture.md`: ownership, feature structure, and dependency direction.
- `.agent/instructions/ui-composition.md`: shadcn, Tailwind, tokens, and UI composition.
- `.agent/instructions/integrations.md`: external-system and adapter ownership.
- `.agent/standards/development.md`: functional style and progressive architecture growth.
- `.agent/standards/testing.md`: test levels and behavior/boundary coverage.
- `.agent/standards/types-validation.md`: strict types and contract/schema ownership.
- `.project/PROJECT-STATE.md` and `.project/foundation.md`: current baseline and lifecycle.
- `prebuilt/README.md`: rules for composed reusable solutions.
- `enablers/README.md` and `enablers/observability/README.md`: operational ownership.
- `.github/GOVERNANCE.md`, `.github/pull_request_template.md`, and
  `.github/workflows/control-plane.yml`: contribution, review, and CI policies.

Read the workspace unit's own `README.md` and local instructions when present. `project.json`
describes unit ownership/dependencies/tasks; `package.json` defines executable scripts and
dependencies; source and tests define actual behavior.

## Commands and validation

Root commands are defined by `package.json`; use them rather than guessing:

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
pnpm run validate
```

For a workspace task, use `pnpm --filter <workspace-package> <script>` or the repository CLI
as appropriate; verify the script exists in that unit's `package.json` first. Start with the
narrowest relevant test/check, then expand validation to match the change's blast radius.
`pnpm run validate` is the full CI-style validation and includes syntax, repository policy,
security/audit, lint, typecheck, tests, and builds.

## Safety and completion

- Never read, print, copy, or commit real secrets. Use `.env.example` to understand required
  variables; keep local environment files private and ignored.
- Treat `node_modules/`, `.next/`, `.repo-cache/`, `dist/`, `build/`, and `coverage/` as
  generated/dependency output, not source-of-truth implementation.
- Do not change unrelated user work, generated lockfiles, or policy files unless required by
  the task. Do not silently weaken checks or convert tool failures into success.
- Before finishing, confirm the requested behavior is implemented, inspect the changed-file
  diff, run applicable validation, and report what changed and what was or was not verified.
