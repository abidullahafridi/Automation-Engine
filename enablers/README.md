# Enablers

`enablers/` owns cross-cutting infrastructure, platform operation, tooling, automation,
environments, CI/CD, deployment, observability, security, development operations, and
operational-process capabilities without becoming application business code. Concrete units live at
`enablers/<category>/<unit>/`; category-level README files may define ownership before a
unit is justified.

An enabler owns its documentation, configuration, and lifecycle. It is not a workspace
project by default. If it gains independently runnable tasks or package dependencies,
the same change must deliberately add its project root and pnpm workspace pattern, then
provide honest `project.json` and `package.json` manifests. Runtime libraries consumed by
code belong in `packages/`; composed reusable products belong in `prebuilt/`.

Do not use enablers for feature code, generic utilities, duplicated service folders,
empty capability placeholders, or repository-wide orchestration.
