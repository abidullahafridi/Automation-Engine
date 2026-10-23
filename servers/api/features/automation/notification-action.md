# notification.send action (AE-T-031.2)

The first low-risk internal action. Side effect class: `internal-idempotent`.
The registration (schema, permission, timeout, retry classes, redaction) is
`notificationSendAction` in `automation.registry.ts`, which is the source of truth.
`NotificationSendConfig` is derived from its schema with `z.infer`, so drift is a compile error.

## Config (strict; validated by the executor before the handler runs)

    { "recipient": { "type": "project_lead" }, "template": "task_completed" }

## Recipient resolution

`RecipientDirectoryPort.findProjectLeadForRun(workspaceId, runId)`. The workspace comes only
from the trusted handler context, never from rule config. A run or project in another
workspace returns `null`, identical to "no lead": no existence leak.

## Outcome policy

| Situation | Handler behaviour | Executor errorClass |
|---|---|---|
| Sent | returns `{ notificationId, status: "sent" }` | n/a |
| Same idempotency key again | returns `{ notificationId, status: "already_sent" }` | n/a |
| No lead / other workspace / lead deleted | throws `recipient_not_found` | permanent |
| Lead disabled | throws `recipient_disabled` | permanent |
| Missing template variable | throws `validation` | permanent |
| Provider transient error | throws `NotificationProviderError` | transient |
| Provider permanent error | throws `NotificationProviderError` | permanent |
| Unknown error | throws | transient (safe: idempotent key) |
| Timeout / caller abort | executor result | transient (idempotent action) |

Disabled or deleted recipients are permanent failures (not skips) because the registered
`retryClassification.permanent` list contains `recipient_not_found` and `recipient_disabled`.

## Safety

- Template allowlist (`Record` over the registry enum); values are control-character stripped,
  HTML-escaped and length-capped.
- Errors carry stable codes only; the executor replaces messages with static text.
- The result exposes only `notificationId` and `status` (registry redaction contract).

## Audit and metrics (`action.outcome.ts`)

`createAuditedActionExecutor` wraps an `ActionExecutor`:

- one allowlisted `ActionOutcomeRecord` per execution: workspace, automation, run, action index,
  action type, status, handlerInvoked, idempotency key, failure code and error class, and only the
  registered `redaction.resultFields` of the output. No config, recipient, message or handler text.
- metric `automation_action_attempts_total{action_type,outcome}`; unregistered types are labelled
  `unknown` so labels stay low-cardinality. `automation_action_audit_failures_total{action_type}`
  counts audit store failures, which never change the action result.

## Known gaps (not part of this task)

- Registry has `requiredPermission.enforced: false`: permission is evaluated against the workspace
  resource, not the resolved recipient (the recipient is only known after an async lookup, and
  `resolveResource` is synchronous).
- No real adapters yet: `RecipientDirectoryPort`, `NotificationPort`, `TemplateVariablesPort` need
  platform directory/notification services that do not exist in this repository.
- `createInMemoryActionOutcomeStore` is a test double. Durable, append-only outcome storage and
  action-attempt state updates belong to the run persistence and retry work (AE-T-032.x).
- The run worker does not call the executor yet.
