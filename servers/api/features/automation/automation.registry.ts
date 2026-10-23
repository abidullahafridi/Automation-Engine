import { z } from "zod";
import type { ConditionFieldDefinitions } from "./condition.validation.js";

export type Registry<TDefinition extends Readonly<{ type: string }>> = Readonly<{
  types: readonly string[];
  get: (type: string) => TDefinition | undefined;
}>;

export const createRegistry = <TDefinition extends Readonly<{ type: string }>>(
  definitions: readonly TDefinition[]
): Registry<TDefinition> => {
  const entries = new Map<string, TDefinition>();
  for (const definition of definitions) {
    if (entries.has(definition.type)) {
      throw new Error(`Duplicate registry type: ${definition.type}`);
    }
    entries.set(definition.type, definition);
  }
  return Object.freeze({
    types: Object.freeze([...entries.keys()]),
    get: (type: string) => entries.get(type)
  });
};

export type TriggerRegistration<TConfig = unknown> = Readonly<{
  type: string;
  configSchema: z.ZodType<TConfig>;
  fields: ConditionFieldDefinitions;
}>;

const taskStatusChangedConfigSchema = z.object({
  toStatus: z.string().min(1),
  allowAutomationOrigin: z.boolean()
}).strict();

export const taskStatusChangedFields = Object.freeze({
  "task.status": Object.freeze({ type: "string" as const }),
  "task.previousStatus": Object.freeze({ type: "string" as const }),
  "task.priority": Object.freeze({
    type: "enum" as const,
    values: Object.freeze(["low", "medium", "high", "urgent"] as const)
  }),
  "task.isArchived": Object.freeze({ type: "boolean" as const })
});

export const taskStatusChangedTrigger = Object.freeze({
  type: "task.status_changed",
  configSchema: taskStatusChangedConfigSchema,
  fields: taskStatusChangedFields
});

export type TriggerRegistry = Registry<TriggerRegistration>;

export const createTriggerRegistry = (
  definitions: readonly TriggerRegistration[] = [taskStatusChangedTrigger]
): TriggerRegistry => createRegistry(definitions);

export const triggerRegistry = createTriggerRegistry();

const notificationConfigSchema = z.object({
  recipient: z.object({
    type: z.literal("project_lead")
  }).strict(),
  template: z.enum(["task_completed"])
}).strict();

const notificationResultSchema = z.object({
  notificationId: z.string().min(1),
  status: z.string().min(1)
}).strict();

export type ActionRegistration<TConfig = unknown> = Readonly<{
  type: string;
  schemaVersion: number;
  configSchema: z.ZodType<TConfig>;
  resultSchema: z.ZodType;
  sideEffect: "none" | "internal-idempotent" | "internal" | "external-idempotent" | "external";
  requiredPermission: Readonly<{
    permission: string;
    resource: Readonly<{ type: "user"; id: "resolved-recipient" }>;
    enforced: false;
  }>;
  timeoutMs: Readonly<{ internal?: number; external?: number }>;
  retryClassification: Readonly<{
    transient: readonly string[];
    permanent: readonly string[];
    ambiguous: readonly string[];
  }>;
  redaction: Readonly<{
    deniedKeys: readonly string[];
    recipient: "type-and-masked-id-only";
    runHistory: "exclude-recipient-personal-data";
    resultFields: readonly ["notificationId", "status"];
  }>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSchema = (value: unknown): value is z.ZodType =>
  isRecord(value) && "safeParse" in value && typeof value.safeParse === "function";

const isStringList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

const isActionRegistration = (value: unknown): value is ActionRegistration => {
  if (!isRecord(value)) return false;
  const permission = value.requiredPermission;
  const timeout = value.timeoutMs;
  const retry = value.retryClassification;
  const redaction = value.redaction;
  if (!isRecord(permission) || !isRecord(permission.resource) ||
      !isRecord(timeout) || !isRecord(retry) || !isRecord(redaction)) return false;

  const timeoutEntries = Object.entries(timeout);
  const hasTimeout = timeoutEntries.length > 0 && timeoutEntries.every(([kind, milliseconds]) =>
    (kind === "internal" || kind === "external") &&
    typeof milliseconds === "number" &&
    Number.isFinite(milliseconds) &&
    milliseconds > 0);
  const resultFields = redaction.resultFields;
  return typeof value.type === "string" &&
    value.type.length > 0 &&
    typeof value.schemaVersion === "number" &&
    Number.isInteger(value.schemaVersion) &&
    value.schemaVersion >= 1 &&
    isSchema(value.configSchema) &&
    isSchema(value.resultSchema) &&
    ["none", "internal-idempotent", "internal", "external-idempotent", "external"].includes(String(value.sideEffect)) &&
    typeof permission.permission === "string" &&
    permission.permission.length > 0 &&
    permission.resource.type === "user" &&
    permission.resource.id === "resolved-recipient" &&
    permission.enforced === false &&
    hasTimeout &&
    isStringList(retry.transient) &&
    retry.transient.length > 0 &&
    isStringList(retry.permanent) &&
    retry.permanent.length > 0 &&
    isStringList(retry.ambiguous) &&
    isStringList(redaction.deniedKeys) &&
    redaction.deniedKeys.length > 0 &&
    redaction.recipient === "type-and-masked-id-only" &&
    redaction.runHistory === "exclude-recipient-personal-data" &&
    isStringList(resultFields) &&
    resultFields.length === 2 &&
    resultFields[0] === "notificationId" &&
    resultFields[1] === "status";
};

export const notificationSendAction = Object.freeze({
  type: "notification.send",
  schemaVersion: 1,
  configSchema: notificationConfigSchema,
  resultSchema: notificationResultSchema,
  sideEffect: "internal-idempotent" as const,
  requiredPermission: Object.freeze({
    permission: "notification.send",
    resource: Object.freeze({ type: "user" as const, id: "resolved-recipient" as const }),
    enforced: false as const
  }),
  timeoutMs: Object.freeze({ internal: 5_000 }),
  retryClassification: Object.freeze({
    transient: Object.freeze(["timeout", "connection_reset", "5xx", "429"]),
    permanent: Object.freeze(["validation", "permission_denied", "recipient_not_found", "recipient_disabled"]),
    ambiguous: Object.freeze([])
  }),
  redaction: Object.freeze({
    deniedKeys: Object.freeze(["authorization", "cookie", "token", "secret", "password", "apiKey"]),
    recipient: "type-and-masked-id-only" as const,
    runHistory: "exclude-recipient-personal-data" as const,
    resultFields: Object.freeze(["notificationId", "status"] as const)
  })
});

export type ActionRegistry = Registry<ActionRegistration>;

export const createActionRegistry = (
  definitions: readonly unknown[] = [notificationSendAction]
): ActionRegistry => createRegistry(definitions.map((definition) => {
  if (!isActionRegistration(definition)) {
    throw new Error("Action registration is incomplete.");
  }
  return definition;
}));

export const actionRegistry = createActionRegistry();
