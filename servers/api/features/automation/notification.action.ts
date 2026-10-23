import type { z } from "zod";
import type { ActionErrorClass, ActionHandler } from "./action.handler.js";
import type { notificationSendAction } from "./automation.registry.js";
import {
  NotificationProviderError,
  type NotificationPort,
  type RecipientDirectoryPort,
  type TemplateVariables,
  type TemplateVariablesPort
} from "./notification.ports.js";

export const NOTIFICATION_SEND_TYPE = "notification.send";

/** Derived from the registered schema, so a registry change is a compile error here. */
export type NotificationSendConfig = z.infer<typeof notificationSendAction.configSchema>;

/** Must satisfy the registered strict resultSchema: only these two keys. */
export type NotificationSendResultData = Readonly<{
  notificationId: string;
  status: "sent" | "already_sent";
}>;

/** Codes match the permanent list in notificationSendAction.retryClassification. */
export type NotificationErrorCode = "recipient_not_found" | "recipient_disabled" | "validation";

/** Safe, payload-free error: the message is the stable code only. */
export class NotificationActionError extends Error {
  readonly kind: ActionErrorClass = "permanent";
  readonly code: NotificationErrorCode;

  constructor(code: NotificationErrorCode) {
    super(code);
    this.name = "NotificationActionError";
    this.code = code;
  }
}

// ---- Template allowlist (logic-less, D-09) ----

type TemplateDef = Readonly<{
  title: string;
  body: string;
  variables: readonly string[];
}>;

/** Record over the registry enum: adding a template to the registry forces an entry here. */
const TEMPLATES: Readonly<Record<NotificationSendConfig["template"], TemplateDef>> = {
  task_completed: {
    title: "Task completed: {{taskTitle}}",
    body: "{{actorName}} marked \"{{taskTitle}}\" as done.",
    variables: ["taskTitle", "actorName"]
  }
};

const MAX_VALUE_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 1000;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sanitizeValue = (raw: string | number | boolean): string =>
  escapeHtml(
    // eslint-disable-next-line no-control-regex
    String(raw).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_VALUE_LENGTH)
  );

/** Returns null when a placeholder is not allowlisted or has no value. */
const fillTemplate = (
  text: string,
  def: TemplateDef,
  variables: TemplateVariables
): string | null => {
  const state = { ok: true };
  const output = text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    const value = def.variables.includes(name) ? variables[name] : undefined;
    if (value === undefined) {
      state.ok = false;
      return "";
    }
    return sanitizeValue(value);
  });
  return state.ok ? output.slice(0, MAX_OUTPUT_LENGTH) : null;
};

// ---- Handler ----

export type NotificationHandlerDeps = Readonly<{
  directory: RecipientDirectoryPort;
  notifications: NotificationPort;
  variables: TemplateVariablesPort;
}>;

/**
 * The executor already: validated config against the registry schema, checked permission,
 * enforced the timeout, built the idempotency key, and validates this result against the
 * registry result schema. Audit and metrics are recorded by the audited executor wrapper.
 */
export const createNotificationSendHandler = (
  deps: NotificationHandlerDeps
): ActionHandler<NotificationSendConfig, NotificationSendResultData> => ({
  type: NOTIFICATION_SEND_TYPE,

  execute: async (config, context): Promise<NotificationSendResultData> => {
    const def = TEMPLATES[config.template];

    // Workspace comes only from the trusted context. Another workspace's run returns
    // null, the same as "no lead": no existence leak.
    const recipient = await deps.directory.findProjectLeadForRun(
      context.workspaceId,
      context.runId
    );
    if (recipient === null || recipient.status === "deleted") {
      throw new NotificationActionError("recipient_not_found");
    }
    if (recipient.status === "disabled") {
      throw new NotificationActionError("recipient_disabled");
    }

    const variables = await deps.variables.forRun(context.workspaceId, context.runId);
    const title = fillTemplate(def.title, def, variables);
    const body = fillTemplate(def.body, def, variables);
    if (title === null || body === null) {
      throw new NotificationActionError("validation");
    }

    const result = await deps.notifications.send(
      {
        workspaceId: context.workspaceId,
        recipientUserId: recipient.userId,
        templateKey: config.template,
        title,
        body,
        idempotencyKey: context.idempotencyKey
      },
      { signal: context.signal }
    );

    return {
      notificationId: result.notificationId,
      status: result.deduplicated ? "already_sent" : "sent"
    };
  },

  classifyError: (error: unknown): ActionErrorClass => {
    if (error instanceof NotificationActionError || error instanceof NotificationProviderError) {
      return error.kind;
    }
    // Internal + idempotent key => a retry is safe; attempts stay bounded by retry policy.
    return "transient";
  }
});