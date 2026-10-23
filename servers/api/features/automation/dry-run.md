# Automation dry-run (AE-T-051.1)

`POST /api/v1/workspaces/{workspaceId}/automations/{automationId}/dry-run`
Body: `{ "sample": { "task": { "status", "previousStatus", "priority", "isArchived" } } }` (all task fields optional).

## Guarantees
- Pure code path: `buildDryRunPreview(header, sample)` has no repository, handler, executor, audit, or clock dependency.
- Same evaluator (`createConditionEvaluator`), same JSON bounds (`checkAutomationJsonBounds`), and same rule validation/limits as real execution.
- Values in the output pass through `redactValue`; action config is redacted too.
- Cross-workspace, unknown, or unauthorized automations return a non-enumerating 404.
- An invalid stored draft returns 200 `{ valid: false, errors, preview: null }`.

## Not previewed (listed in `limitations`)
- Execution-time authorization and recipient resolution.
- Quota, fan-out, and loop budgets.
- Sample fields that were not supplied.

## Trigger match
Compares sample `task.status` with the trigger's `toStatus`; `matched: null` when the sample has no status.