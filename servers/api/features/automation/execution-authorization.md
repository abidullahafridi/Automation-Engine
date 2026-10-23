# Execution Authorization and Tenant Scope (AE-T-040.1)

**Task:** AE-T-040.1, Integrate existing principal/policy/scoped-gateway contracts
**Story:** AE-US-040, Re-check permissions at execution time
**Requirements:** FR-013, BR-004, BR-005, BR-006, INV-01, INV-07
**Owner:** Abid Ullah
**Status:** Done for task scope. Local commands (typecheck, lint, tests) were run by the owner and passed.

## What this task adds

Nothing replaces an existing contract. The task connects them:

| Existing contract | Use in this task |
|---|---|
| `WorkspaceScope` + `PrincipalResolver.ownsScope` | Checked first. A forged or missing scope never reaches a repository. |
| `AutomationRepository.findById` (scoped) | Another workspace's automation is "not found". |
| `automationExecutionPrincipal` | Builds the delegated principal `automation:{id}`. |
| `authorizeAutomationExecution` | Per-action check: delegated principal AND creator's live permission. |
| `ActionExecutionRequest` / `createActionExecutor` | Receives the trusted scope from the run. |

New code lives in `execution.context.ts`.

## Flow

1. `ownsScope(scope)`, otherwise `SCOPE_MISSING`.
2. `run.workspaceId === scope.workspaceId`, otherwise `SCOPE_MISMATCH`.
3. Scoped `findById`. Missing gives `AUTOMATION_NOT_FOUND`. Not `enabled` gives `AUTOMATION_NOT_ENABLED`.
4. Creator standing lookup (re-evaluated on every run).
5. Build `TrustedExecutionContext`. `toActionExecutionRequest` carries it to the action executor.
6. The executor checks scope, registry, schema, then `authorizeAutomationExecution`, before any handler runs.

## Creator standing policy (proposed default, platform team to confirm)

| Standing | Outcome | Retryable | Auto-pause |
|---|---|---|---|
| `member` | allowed | | |
| `guest` | `OWNER_ROLE_NOT_ALLOWED` | no | yes |
| `api-key` | `OWNER_ROLE_NOT_ALLOWED` | no | yes |
| `removed` | `OWNER_ACCESS_LOST` | no | yes |
| `unknown` | `OWNER_ACCESS_LOST` (fail closed) | no | yes |
| lookup throws | `STANDING_UNAVAILABLE` | yes | no |

The default adapter `createDenyAllCreatorStandingPort()` returns `unknown`, so execution is denied until a real adapter exists.

## Test evidence

| Test | Covered in | Result |
|---|---|---|
| TC-0401 no scope prevents data access | `execution.context.test.ts` | pass |
| TC-0402 workspace A cannot mutate workspace B | `execution.context.test.ts`, `execution.executor.test.ts` | pass |
| TC-0403 revoked permission blocks action | both files (real executor path) | pass |
| TC-0404 guest / API-key / unknown follow policy | `execution.context.test.ts` | pass |
| TC-0405 direct collection access outside gateway blocked | `automation.architecture.test.ts` | pass |

## Not covered (explicit)

- A real `CreatorStandingPort` adapter and the real platform auth service. These belong to release gate AE-T-010.2b. The platform auth location is currently `NONE`.
- Wiring the resolver into the run worker. The worker will call `resolve` before executing actions.
- The auto-pause transition itself (spec D-12). The resolver only reports `pauseAutomation: true`.
- This does not claim production enablement. The feature flag stays OFF.