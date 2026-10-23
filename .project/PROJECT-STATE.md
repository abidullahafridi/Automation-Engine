# Project State

## Current phase

M03.2 - First Workspace Bootstrap

STATUS: COMPLETE

CONTROL PLANE TOOLING RECONCILIATION: 2026-09-17

UI REGISTRY AND TYPESCRIPT RECONCILIATION: 2026-09-17

SERVER FEATURE AND SHARED CONFIG RECONCILIATION: 2026-09-17

HEALTH FEATURE RESPONSIBILITY RECONCILIATION: 2026-09-18

NEXT.JS AND PACKAGES ARCHITECTURE RECONCILIATION: 2026-09-18

SECURITY SCANNER RECONCILIATION: 2026-09-18

GIT GOVERNANCE RECONCILIATION: 2026-09-18

## Implemented

- The repository remains the workspace. The repository-owned control plane, project manifests, dependency graph, task runner, affected analysis, cache, checks, scans, and execution profiles remain the monorepo foundation.
- `codebase/` owns repository discovery, dependency graphing, execution planning, task ordering, caching, repository-specific policy, result normalization, and the CLI. It delegates specialized analysis to standard engines rather than recreating them.
- The homemade regex secret scanner remains absent. Thin functional adapters orchestrate `pnpm audit` for dependency vulnerabilities and TruffleHog 3.97.5 for secret detection, normalize their results, omit credential values, and fail closed on missing tools, invalid versions, malformed reports, registry failures, findings, or non-zero tool failures.
- Type checking remains delegated to `tsc`, linting to ESLint, testing to project-declared runners, compilation to project build tools, and package resolution to pnpm. The custom dependency graph, planner, runner, cache, architecture validators, and generators remain repository-owned.
- The control plane manages the architecture-pinned TruffleHog release under `.repo-cache`, verifies the official release SHA-256 checksum and executable version, then scans the current repository filesystem for verified, unknown, and unverified findings. Local development and CI use this same bootstrap and scanner adapter.
- pnpm 11.19.0 is the actual workspace package manager. `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `workspace:*` internal dependencies, package scripts, project tasks, CI, generator defaults, and operating guidance are aligned; the npm workspace field and `package-lock.json` were removed.
- pnpm dependency build scripts are deny-by-default except for the explicit `esbuild` and `unrs-resolver` allowlist required by installed tooling.
- `packages/ui` is an operational strict TypeScript workspace package with controlled compiled exports, package-local shadcn configuration, a generated shadcn Button primitive, generic PageHeader, PageShell, and MessageState compositions, and a component test.
- `packages/ui` now owns 53 official shadcn `new-york` registry primitives under `src/primitives`, with a controlled category index, generated hooks category, source/runtime private import mappings, and the exact dependencies declared by its project manifest.
- UI creation is registry-first and CLI-first. Root `ui:add` and `ui:add:all` commands delegate to the package-pinned shadcn 4.20.0 CLI, architecture policy fixes the source aliases and style-compatible catalog, and repository checks reject workflow, alias, version, or catalog drift.
- Repository-owned TypeScript configuration forbids `baseUrl` and `ignoreDeprecations`. The UI package retains explicit source path mappings without `baseUrl`, and repository checks reject either forbidden compiler option.
- `apps/web` consumes generic UI only through the `@workspace/ui` root API. Application-specific workspace components remain local, while the former app-local primitive, layout, feedback, and utility implementations were removed.
- Tailwind CSS scans the UI package source and applies the shared shadcn CSS-variable tokens. The rendered home route composes the package Button through application-owned workspace UI.
- API constants are categorized under `constants/errors`, `constants/http`, and `constants/runtime`, with controlled category and root exports. Existing categorized web, API, and shared types remain in their owning boundaries.
- MongoDB remains server-owned under `servers/api/integrations/mongodb`; no database package or speculative integration was introduced.
- Architecture validation enforces pnpm workspace policy, `workspace:` dependencies, the native-build allowlist, UI ownership, named shadcn primitive ownership, feature ownership, package export surfaces, deep-import boundaries, categorized module exports, and constants/types dumping-ground rules.
- New and refactored code remains functional and compositional, with no classes, dependency-injection containers, mutable global state, or explicit `any`.
- Server HTTP features now have an explicit `servers/<runtime>/features/<feature>/` boundary. Health owns a dependency-injected router factory under `servers/api/features/health`, and API bootstrap composes it through an explicit feature list while preserving `/health`.
- `packages/tsconfig` and `packages/eslint-config` are configuration-only workspace projects. Five TypeScript consumers inherit approved shared presets, and configuration projects participate in discovery and dependency planning without invented tasks.
- The web root route is owned by `(public)`, while `(app)` establishes a minimal application layout boundary without authentication, guards, providers, or speculative feature code.
- Package-local maintenance, prebuilt solution, enabler, and categorization contracts are now explicit and executable where static validation is meaningful.
- Health is the reference categorized server feature: `routes/` composes HTTP delivery, `controllers/` translates the response, and `services/` owns the application operation. Every layer is functional, dependency-explicit, and exposed through controlled indexes; no unused domain, validation, persistence, model, or integration layer exists.
- Health behavior tests now live with the feature and independently verify service, controller, and HTTP route contracts. The API-level suite retains the general not-found/error boundary test.
- Server consumers outside a feature are rejected when they bypass the feature root public API, and route validation requires the justified `features/<feature>/routes/` boundary plus explicit bootstrap registration.
- Shared logging renders readable level-first, locally timestamped terminal output with indented context in non-production API environments; production output remains structured JSON for ingestion.
- The public home route now composes an application-owned `workspace-foundation` feature through its root public API. Its feature UI moved out of the generic application component boundary, and the route remains a thin Server Component that owns environment-derived configuration.
- `packages/ui` now owns its Tailwind theme and semantic design tokens through an exported stylesheet consumed by the web application. `PageHeader` is a generic component, while `PageShell` and the shell-dependent `MessageState` are compositions; all consumers continue through the package root API.
- Shared API contracts are categorized under `packages/types/src/api/environment`, `errors`, and `health`, with category indexes and unchanged root-package imports for consumers.
- Git governance uses repository-local Husky hooks, Commitlint Conventional Commits, lint-staged workspace ESLint routing, the existing managed TruffleHog scan, and the existing control-plane check contract. GitHub repository policy now includes CODEOWNERS, a pull request template, least-privilege immutable-action CI, documented branch and review standards, and a versioned `main` ruleset payload for administrator application.

## Validated

- A frozen pnpm install succeeds across all eight workspace projects and executes only the two allowlisted dependency build scripts.
- Repository syntax, architecture, project discovery, and package-manager checks pass with no issues.
- All five TypeScript workspaces pass independent `tsc --noEmit`: web, API, UI, logging, and shared types.
- All five TypeScript workspaces pass independent ESLint tasks.
- Production builds pass for web, API, UI, logging, and shared types. Next.js compiled and type-checked the app and generated `/` and `/_not-found`.
- 48 control-plane tests pass. Fourteen workspace tests pass: four web, eight API, one UI, and one logging test.
- `pnpm audit` reports zero dependency findings at every severity. The managed TruffleHog repository scan is clean, and aggregate local validation no longer depends on a globally installed secret scanner.
- Controlled standard-tool failures propagate correctly. ESLint rejected explicit `any`; `tsc` rejected an invalid assignment; the runner marked the owning task failed and skipped its dependent task; TruffleHog detected a generated temporary private key without exposing its value; checksum, version, scanner-error, malformed-report, missing-tool, and dependency-advisory fixtures all failed repository policy. All temporary files were removed.
- The package-local `ui:add` workflow and controlled UI package exports remain operational across tests and production builds.
- The pinned shadcn 4.20.0 CLI successfully queried the official registry and generated all 53 components that expose `new-york` style artifacts. The reproducible catalog command excludes eight searchable entries whose registry style artifacts return not found: `attachment`, `bubble`, `combobox`, `direction`, `marker`, `message`, `message-scroller`, and `native-select`.
- Registry aliases resolve generation into `packages/ui/src` without `baseUrl`; the private `#ui` import map resolves source during TypeScript compilation and compiled files at runtime. Strict UI type checking, scoped registry-source linting, the component test, and the UI build pass.
- 56 control-plane tests pass, including shared TypeScript inheritance, config-project placement, server feature placement and registration, feature public API enforcement, package-local maintenance scope, forbidden compiler options, and the pinned registry workflow. Sixteen workspace tests pass.
- Controlled failures detect invalid server feature location and registration, invalid shared TypeScript inheritance, invalid config-project placement, forbidden package-local maintenance behavior, duplicate shadcn primitives, feature UI inside `packages/ui`, and generic UI inside `apps/web`. Test fixtures are temporary and the real tree passes cleanly afterward.
- Production runtime smoke checks returned HTTP 200 from the web application, rendered the expected UI-package-backed content, and returned the healthy API payload from `/health` with startup and request logging.
- `git diff --check` passes.
- M03.4 workspace discovery and the dependency graph remain valid and acyclic. Architecture checks, lint, strict type checking, production builds, 56 control-plane tests, and 17 workspace tests pass; the pinned shadcn CLI resolves the package-owned theme and all 53 installed registry components.
- The security scanner reconciliation passes a clean managed TruffleHog scan, normalized JSON output, aggregate validation, checksum, cached-binary integrity, and version enforcement, a generated-credential integration test, 71 control-plane tests, all 17 workspace tests, lint, strict type checking, and every production build.
- Git governance contract tests cover valid, invalid, malformed, missing-subject, and breaking Conventional Commits; staged-only processing and command failure; hook thinness; workspace ESLint routing; immutable CI actions; pull request structure; CODEOWNERS; and the versioned ruleset policy. Repository-wide validation remains the authoritative CI path.

## Deferred

- A required live MongoDB connection, feature repositories, models, and live-provider integration coverage remain deferred until a persistence-backed feature exists.
- Remote artifact storage, distributed execution, deployment-specific standalone web packaging, and production observability infrastructure remain deferred until operational requirements justify them.
- Applying `.github/rulesets/main.json` to GitHub remains an authenticated repository-administrator action; the current environment has no authenticated GitHub CLI session.

## Not applicable

- Authentication, users, sessions, and authorization are outside M03.2 and were not introduced.
- `packages/validation` is not justified because current environment schemas are runtime-specific and not shared.
- Additional feature, form, navigation, persistence, or infrastructure folder hierarchies are not justified by current source responsibilities.

## Next milestone

M03.3 - Auth Vertical Slice Design. Authentication is not implemented in the current workspace.
