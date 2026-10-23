# Action handler registry and executor (AE-T-031.1)

The executor is the only supported path to an action handler. Handlers are registered in an
`ActionHandlerRegistry`; creation fails if a handler type is duplicated or not declared in
the `ActionRegistry` (which owns config schema, result schema, permission, timeout, retry
classification and redaction metadata).

## Execution order

1. Trusted scope: scope must be resolver-minted and match the run's workspace.
2. Registered action type and handler. Unknown => `ACTION_UNKNOWN_TYPE`, no side effect.
3. Bounded input (JSON bounds) then the registered config schema. Failure => `ACTION_INVALID_INPUT`.
4. Permission: `authorizeAutomationExecution` (delegated automation principal AND creator's
   current permission). Denied => `ACTION_PERMISSION_DENIED`; policy outage => transient
   `ACTION_POLICY_UNAVAILABLE`. A handler-resolved resource outside the workspace => `ACTION_SCOPE_MISMATCH`.
5. Invocation with a frozen context, an idempotency key (`sha256(runId:actionIndex)`) and an
   `AbortSignal` bound to the per-action timeout and the caller's abort signal.
6. Output is validated against the registered result schema.

Steps 1-4 never reach the handler.

## Error classes

| Situation | Class |
|---|---|
| Unknown type, invalid input, permission denied, scope mismatch | `permanent` |
| Policy unavailable | `transient` |
| Handler throws | `handler.classifyError`; if it throws => `ambiguous` |
| Timeout / caller abort / invalid output | `transient` for idempotent or side-effect-free actions, otherwise `ambiguous` |

Failure messages are static; submitted values and handler messages are never echoed.
Retry scheduling (AE-T-032.1), run/action persistence of outcomes and the first real action
(AE-T-031.2) build on this contract and are not part of this task.