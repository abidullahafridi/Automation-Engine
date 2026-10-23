# Automation condition language

This is the bounded, pure condition evaluator for the Automation API feature. It is not
connected to an API route, persistence layer, dry-run, or worker. The accepted v1 scope is
recorded in ADR-0005.

## Expression forms

```json
{ "field": "task.status", "op": "eq", "value": "done" }
{ "all": [{ "field": "task.priority", "op": "in", "value": ["high", "urgent"] }] }
{ "any": [{ "field": "task.isArchived", "op": "eq", "value": false }] }
{ "not": { "field": "task.status", "op": "eq", "value": "open" } }
```

Predicates accept only `field`, `op`, and (when required) `value`. Group objects contain
exactly one of `all`, `any`, or `not`. Empty groups, extra keys, unsupported operators, and
Fields outside the registered trigger's field allowlist are rejected before evaluation.

| Operator | Operand | Semantics |
|---|---|---|
| `eq` / `ne` | JSON scalar compatible with the registered field type | Strict equality; no string/number/boolean coercion. Explicit `null` compares equal only to `null`. Missing `ne` is `not_matched`. |
| `in` / `not_in` | Non-empty array compatible with the registered field type | Strict membership; the field must exist and be scalar. Missing `not_in` is `not_matched`. |
| `exists` / `not_exists` | No value | Tests own-property presence; an explicit `null` is present. |
| `gt` / `gte` / `lt` / `lte` | Finite number | Numeric comparison only; the field must be a finite number. |
| `before` / `after` | ISO-8601 instant with `Z` or explicit offset | Compare parsed instants; both field and operand must be valid timezone-qualified strings. |
| `all` / `any` / `not` | Child expression(s) | Non-empty conjunction/disjunction or one negated child. Evaluation errors are surfaced rather than hidden by another child's boolean result. |

Field paths use dot-separated own-property lookup only. `__proto__`, `prototype`, and
`constructor` path segments are rejected. Inherited properties are never read.

## Missing, null, and errors

- Missing field with `exists` returns `not_matched`; missing field with `not_exists` returns
  `matched`.
- Explicit null is present and can be tested with `eq`/`ne`; ordering and date operators
  return `evaluation_error` for null, missing, or incompatible values.
- A malformed condition is rejected as `evaluation_error` with a stable code and JSON
  Pointer-like path. The evaluator does not turn data/type errors into an ordinary false
  result.

## Provisional resource bounds

The shared validation entry point checks the accepted provisional starter limits before
walking the condition tree:

| Bound | Limit |
|---|---:|
| Encoded rule payload | 64 KiB |
| JSON nesting depth | 10 |
| Condition-tree depth | 5 |
| Groups | 10 |
| Total condition nodes | 50 |
| UTF-8 bytes per string/key | 4 KiB |
| Values per array | 100 |
| Actions per rule | 10 |

The registry-owned `task.status_changed` allowlist is `task.status` (string),
`task.previousStatus` (string), `task.priority` (`low|medium|high|urgent`), and
`task.isArchived` (boolean). Numeric/date operators remain in the operator table but cannot be
used with these field types. Limits are provisional guardrails, not product entitlements or
production SLOs. Callers cannot supply or widen a trigger's allowlist.
