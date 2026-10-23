# Prebuilt Solutions

`prebuilt/` owns composed, reusable solutions that are larger than a package and useful
in more than one delivery context. Supported categories are `prebuilt/apps/<unit>/`,
`prebuilt/services/<unit>/`, and `prebuilt/features/<unit>/`; utilities and
single-library implementations belong in `packages/` instead.

Each unit owns its source and operational documentation and must declare `project.json`
and `package.json`. The control plane discovers manifests recursively, while pnpm matches
the declared `prebuilt/*/*` workspace pattern. Tasks and dependencies must describe only
real behavior and use explicit internal project dependencies. Consumers integrate a
prebuilt unit as a composed solution; they do not deep-import its internals.

Do not add placeholders, mirrors of existing applications, speculative templates, or
provider-specific deployments without a concrete reusable solution and owner.
