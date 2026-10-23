# Repository Governance

## Development flow

`main` is the validated integration branch. Normal changes use a short-lived branch, a pull request,
the `validate` status check, review, and squash merge. Delete merged branches. Do not force-push or
delete protected branches.

Allowed branch forms are:

```text
feature/<name>  fix/<name>       refactor/<name>  perf/<name>
test/<name>     docs/<name>      build/<name>     ci/<name>
chore/<name>    hotfix/<name>    release/<version>
```

Names use lowercase words separated by hyphens and describe one coherent purpose. Hotfixes may be
reviewed quickly, but they retain the required validation and security controls.

## Commits and review

Commit messages follow Conventional Commits:

```text
<type>[optional scope][optional !]: <description>
```

Allowed types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`,
`style`, and `revert`. Breaking changes use `!` or a `BREAKING CHANGE:` footer. Commits should be
atomic, coherent, reviewable, and free of generated files, unrelated changes, and credentials.

Application changes need an appropriate application reviewer. Shared package changes need a package
owner. Architecture, control-plane, security, and workflow changes need the repository owner. The
versioned CODEOWNERS file provides current routing without inventing organizational teams.

## Validation layers

- Commit: lint-staged runs each workspace's existing ESLint configuration, then the managed
  TruffleHog and dependency scan runs through `pnpm run scan`.
- Commit message: Commitlint enforces the Conventional Commit policy.
- Push: `pnpm run check` provides the medium-cost repository and architecture check.
- Pull request and main: Commitlint validates the relevant commit, then `pnpm run validate` runs
  syntax, architecture, security, audit, lint, typecheck, tests, and production builds.

Local hooks provide feedback and may be bypassed; GitHub checks and the main-branch ruleset are the
authoritative enforcement boundary.

## Merge, release, and signing

Use squash merge so `main` retains one coherent Conventional Commit per pull request. Release work
uses `release/<version>`, runs full validation, then versions, tags, builds artifacts, and publishes
through GitHub Actions when a release requirement exists. No release framework is currently needed.

Commit signing is supported but not required because no established organization-wide signing policy
exists. It may be enabled later through the GitHub ruleset after contributor readiness is confirmed.

## GitHub ruleset

The desired `main` policy is stored in `.github/rulesets/main.json`. It requires a pull request, one
approval, code-owner review, resolved conversations, an up-to-date `validate` check, linear history,
and blocks deletion and force pushes. It has no bypass actors.

The ruleset is repository policy, but GitHub does not apply files from `.github/rulesets/`
automatically. An authenticated repository administrator must create it through GitHub settings or:

```text
gh api --method POST repos/adeelchainz/nutshyll/rulesets --input .github/rulesets/main.json
```
