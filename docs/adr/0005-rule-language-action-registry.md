# ADR-0005: Rule language and action registry

- **Status:** Accepted (single-reviewer exception; see Approval)
- **Next review:** Before AE-US-012 or any production enablement

## Context

The engine needs a versioned, bounded rule language and a controlled action catalogue. The
specification proposes declarative conditions only, no user code/eval or user regex, and
typed registered actions with strict schemas, permissions, timeouts, idempotency, and
redaction rules. No automation DSL, policy engine, or action handler exists in the repository.
This decision is limited to v1 and the first vertical slice.

## Drivers

- Untrusted rules must not execute arbitrary code or unbounded computation.
- Unknown operators/actions fail closed.
- Every action has explicit input/output schemas, permissions, timeouts, side-effect and
  retry semantics.
- Validation and evaluation remain deterministic and testable.

## Options

1. **Accepted: versioned declarative DSL plus explicit typed action registry.** Allow only
   enumerated operators and actions; bound payload, depth, nodes, and action count.
2. **User-supplied scripts or expressions.** Rejected for v1 due to code-execution and
   resource-exhaustion risk.
3. **User-provided regular expressions.** Rejected for v1 due to ReDoS risk; any future
   matching operator requires a separate reviewed design and safe engine.
4. **Implicit dynamic action lookup.** Rejected because unknown or colliding handlers could
   fail open or route to unintended effects.

## Decision

Accepted for **v1, first vertical slice only**, using the scope below:

1. Declarative rules only: no user code, `eval`, regex, scripting, arithmetic expressions, or
   function calls (spec D-09, D-10, CON-003).
2. Rule document `schemaVersion: 1` uses the shape in spec §8.1:
   `schemaVersion`, `name`, `trigger`, `conditions`, `actions`, and `executionPolicy`.
   Unknown keys are rejected, never stripped.
3. The v1 trigger registry contains only `task.status_changed`, with config
   `{ toStatus, allowAutomationOrigin }`.
4. The v1 action registry contains only `notification.send`, with config
   `{ recipient, template }`, plus `onStale: "skip"`.
5. Supported operators are `eq`, `ne`, `in`, `not_in`, `exists`, `not_exists`, `gt`, `gte`,
   `lt`, `lte`, `before`, and `after`. Groups are `all`, `any`, and `not` (one child).
   Empty groups are invalid; implicit coercion is forbidden. An absent field for `ne` or
   `not_in` is a non-match.
6. The trigger registry entry owns its field allowlist. For `task.status_changed`, the
   provisional fields are `task.status` (string), `task.previousStatus` (string),
   `task.priority` (enum `low|medium|high|urgent`), and `task.isArchived` (boolean).
7. Registries fail closed for unknown trigger, action, operator, or field. Duplicate type
   registration throws at startup. An action without a config schema, required-permission
   mapping, timeout, and redaction rules cannot register.
   For provisional v1 `notification.send`: schemaVersion 1, `internal-idempotent`, internal
   timeout 5000 ms, and permission declaration `notification.send` on the resolved recipient
   (`user` resource). This declaration is not enforced until a PolicyPort exists under
   ADR-0008. Recipient resolution must be scoped to the same workspace and waits for the
   task/membership domain.
   Retry classification is transient for timeout, connection reset, 5xx, and 429; permanent
   for validation, permission denied, recipient not found, and recipient disabled; there is no
   ambiguous class. Redaction denies `authorization`, `cookie`, `token`, `secret`, `password`,
   and `apiKey`; recipient personal data is excluded from logs/run history except type and
   masked ID; result output is limited to `{ notificationId, status }`. Templates are registered
   names only, with no free text or helpers; v1 registers `task_completed`.
8. A single typed limits object defines provisional starter bounds: payload 64 KiB, JSON depth
   10, condition depth 5, groups 10, nodes 50, string 4 KiB, array 100 values, and 10 actions
   per rule. Enforce limits before schema validation and evaluation.
9. `workspaceId` and secrets are not part of rule JSON or condition fields.
10. Validation errors use stable codes and JSON-pointer paths:
    `AUTOMATION_INVALID_RULE`, `AUTOMATION_INVALID_TRIGGER`,
    `AUTOMATION_INVALID_CONDITION`, `AUTOMATION_INVALID_ACTION`, and
    `AUTOMATION_LIMIT_EXCEEDED`. Return multiple errors in deterministic order. Messages must
    not expose stack traces, secrets, or internals.
11. Implementation belongs in `servers/api/features/automation/`; do not add a package until
    a second consumer (worker) needs it.

## Out of scope for v1

Regex, templates with helpers, HTTP/webhook actions, schedules and timer triggers,
user-defined variables, and any second trigger or action type.

## Provisional parts

- Task field names and `recipient` types remain provisional until a task domain exists.
  `recipient.type: "project_lead"` comes from the spec example and is not resolved by code in
  this scope.
- `notification.send` permission enforcement and recipient resolution remain deferred; the
  registry records the approved permission and redaction declarations only.
- Operator semantics follow `condition-language.md` and must be revisited if task-domain field
  types change.

## Consequences

- This decision unblocks AE-T-011.1 and AE-T-011.3.
- It does not unblock rule enablement, the management API, or execution; those depend on
  ADR-0008 (scope and identity) and AE-US-012.
- Unsupported syntax must be rejected, not ignored.
- The v1 notification action metadata is provisional and declarative; policy enforcement,
  recipient resolution, and execution are not implemented in this scope.
- Adding a trigger or action requires its schema, permission, retry classification, tests,
  documentation, metrics, and an ADR update.

## Security and operations

Bound parser/evaluator work, prohibit prototype/property escape, require allowlisted fields
per trigger, and avoid dynamic evaluation. Add adversarial depth/size tests and ensure errors
do not expose secrets or internal traces.

## Follow-ups and blocked work

- Engineering: implement the accepted v1 trigger/action schemas, typed registries, and draft
  validation service.
- Verify every item in the security review checklist with tests/review before AE-US-012 or
  production enablement.
- **Unblocked:** AE-T-011.1 and AE-T-011.3.
- **Still blocked:** AE-US-012 and production enablement pending ADR-0008 and version-lifecycle
  prerequisites; later action/connector work remains out of scope or separately gated.

## Approval

- **Owner:** ____________
- **Date:** ____________
- **Reviewer:** ____________
- **Reviewer date:** ____________
- If no independent reviewer: "Single-reviewer exception accepted by owner, review again
  before AE-US-012 or any production enablement."

## Security review checklist

- [x] `__proto__`, `constructor`, and `prototype` are rejected at validation and runtime. Proven by `does not traverse inherited properties or unsafe property names` in `condition.evaluator.test.ts`.
- [x] No implicit type coercion. Proven by `uses deterministic boolean boundaries and rejects coercion` in `condition.evaluator.test.ts`.
- [x] Limits are enforced before validation and evaluation. Proven by `rejects excessive depth, node count, array length, string size, and encoded payload size` in `condition.evaluator.test.ts` and `rule limits are enforced before schema validation` in `registry-and-rule.validation.test.ts`.
- [x] Unknown trigger, action, operator, and field are rejected. Proven by `TC-0112 unregistered trigger and action types are rejected`, `rejects unknown fields, operators, extra keys, and incompatible operands`, and `uses only the trigger registry-owned field allowlist`.
- [x] `workspaceId` and secrets are rejected from rule JSON. Proven by `workspace scope and unregistered secret fields are rejected` in `registry-and-rule.validation.test.ts`.
- [x] Error output contains no stack trace or secret. Proven by `TC-0121 validation errors do not expose secrets or stack traces` in `registry-and-rule.validation.test.ts`.

These implementation checklist items are covered by the named unit tests above. The acceptance
does not approve API enablement or production use; ADR-0008's real-adapter and cross-tenant
integration gate remains required.

## Evidence

- [Automation Engine specification, D-09–D-10 and §10.2](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-011 and AE-US-031](../../automation-engine-backlog.md)
- [Repository audit, verified absence of automation/policy code](../architecture/repository-audit.md)
