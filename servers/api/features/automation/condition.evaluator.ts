import {
  validateCondition,
  isConditionFieldValueCompatible,
  isIsoInstant,
  type ConditionExpression,
  type ConditionOperator,
  type ConditionScalar,
  type ConditionValidationIssue
} from "./condition.validation.js";
import {
  triggerRegistry,
  type TriggerRegistry
} from "./automation.registry.js";

export type ConditionEvaluation =
  | Readonly<{ status: "matched" }>
  | Readonly<{ status: "not_matched" }>
  | Readonly<{
      status: "evaluation_error";
      code: ConditionValidationIssue["code"] | "AUTOMATION_INVALID_TRIGGER" | "AUTOMATION_CONDITION_EVALUATION_ERROR";
      path: string;
      message: string;
    }>;

type FieldValue = Readonly<{ exists: boolean; value?: unknown }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const resolveField = (event: unknown, field: string): FieldValue => {
  let current: unknown = event;
  for (const segment of field.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return Object.freeze({ exists: false });
    }
    current = current[segment];
  }
  return Object.freeze({ exists: true, value: current });
};

const isScalar = (value: unknown): value is ConditionScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

const evaluatePredicate = (
  condition: Extract<ConditionExpression, { field: string; op: ConditionOperator }>,
  event: unknown,
  path: string,
  fields: NonNullable<ReturnType<TriggerRegistry["get"]>>["fields"]
): ConditionEvaluation => {
  const field = resolveField(event, condition.field);
  const definition = fields[condition.field];
  if (condition.op === "exists") {
    return field.exists ? Object.freeze({ status: "matched" }) : Object.freeze({ status: "not_matched" });
  }
  if (condition.op === "not_exists") {
    return field.exists ? Object.freeze({ status: "not_matched" }) : Object.freeze({ status: "matched" });
  }
  if (!field.exists && (condition.op === "ne" || condition.op === "not_in")) {
    return Object.freeze({ status: "not_matched" });
  }
  if (!field.exists || !isScalar(field.value) || !("value" in condition)) {
    return Object.freeze({
      status: "evaluation_error",
      code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
      path,
      message: "Condition field is missing or has an unsupported value type."
    });
  }
  if (!definition || !isConditionFieldValueCompatible(definition, field.value)) {
    return Object.freeze({
      status: "evaluation_error",
      code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
      path,
      message: "Condition field has an unsupported value type."
    });
  }

  const actual = field.value;
  const expected = condition.value;
  switch (condition.op) {
    case "eq":
      return actual === expected ? Object.freeze({ status: "matched" }) : Object.freeze({ status: "not_matched" });
    case "ne":
      return actual !== expected ? Object.freeze({ status: "matched" }) : Object.freeze({ status: "not_matched" });
    case "in":
    case "not_in": {
      if (!Array.isArray(expected)) {
        return Object.freeze({
          status: "evaluation_error",
          code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
          path,
          message: "Membership condition has an invalid operand."
        });
      }
      const included = expected.some((candidate) => candidate === actual);
      const matches = condition.op === "in" ? included : !included;
      return matches ? Object.freeze({ status: "matched" }) : Object.freeze({ status: "not_matched" });
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof expected !== "number") {
        return Object.freeze({
          status: "evaluation_error",
          code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
          path,
          message: "Numeric comparison requires finite numbers."
        });
      }
      const matches = condition.op === "gt"
        ? actual > expected
        : condition.op === "gte"
          ? actual >= expected
          : condition.op === "lt"
            ? actual < expected
            : actual <= expected;
      return matches ? Object.freeze({ status: "matched" }) : Object.freeze({ status: "not_matched" });
    }
    case "before":
    case "after": {
      if (typeof actual !== "string" || typeof expected !== "string" || !isIsoInstant(actual) || !isIsoInstant(expected)) {
        return Object.freeze({
          status: "evaluation_error",
          code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
          path,
          message: "Date comparison requires ISO-8601 instants with timezones."
        });
      }
      const matches = condition.op === "before"
        ? Date.parse(actual) < Date.parse(expected)
        : Date.parse(actual) > Date.parse(expected);
      return matches ? Object.freeze({ status: "matched" }) : Object.freeze({ status: "not_matched" });
    }
  }
};

const evaluateValidated = (
  condition: ConditionExpression,
  event: unknown,
  path: string,
  fields: NonNullable<ReturnType<TriggerRegistry["get"]>>["fields"]
): ConditionEvaluation => {
  if ("all" in condition) {
    const results = [...condition.all.entries()].map(([index, child]) =>
      evaluateValidated(child, event, `${path}/all/${index.toString()}`, fields));
    const error = results.find((result) => result.status === "evaluation_error");
    if (error) return error;
    return results.every((result) => result.status === "matched")
      ? Object.freeze({ status: "matched" })
      : Object.freeze({ status: "not_matched" });
  }
  if ("any" in condition) {
    const results = [...condition.any.entries()].map(([index, child]) =>
      evaluateValidated(child, event, `${path}/any/${index.toString()}`, fields));
    const error = results.find((result) => result.status === "evaluation_error");
    if (error) return error;
    return results.some((result) => result.status === "matched")
      ? Object.freeze({ status: "matched" })
      : Object.freeze({ status: "not_matched" });
  }
  if ("not" in condition) {
    const result = evaluateValidated(condition.not, event, `${path}/not`, fields);
    if (result.status === "evaluation_error") return result;
    return result.status === "matched"
      ? Object.freeze({ status: "not_matched" })
      : Object.freeze({ status: "matched" });
  }
  return evaluatePredicate(condition, event, path, fields);
};

export const createConditionEvaluator = (
  registry: TriggerRegistry = triggerRegistry,
  triggerType = "task.status_changed"
) => {
  const trigger = registry.get(triggerType);
  return (conditionInput: unknown, event: unknown): ConditionEvaluation => {
    if (!trigger) {
      return Object.freeze({
        status: "evaluation_error",
        code: "AUTOMATION_INVALID_TRIGGER",
        path: "/trigger/type",
        message: "Trigger is not registered."
      });
    }
    const validation = validateCondition(conditionInput, trigger.fields);
    if (!validation.success) {
      const issue = validation.issues[0];
      if (!issue) throw new Error("Condition validation failed without a validation issue.");
      return Object.freeze({
        status: "evaluation_error",
        code: issue.code,
        path: issue.path,
        message: issue.message
      });
    }
    return evaluateValidated(validation.condition, event, "", trigger.fields);
  };
};
