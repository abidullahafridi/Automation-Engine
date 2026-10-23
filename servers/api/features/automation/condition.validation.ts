export const automationLimits = Object.freeze({
  encodedPayloadBytes: 64 * 1024,
  jsonDepth: 10,
  conditionDepth: 5,
  groups: 10,
  nodes: 50,
  stringBytes: 4 * 1024,
  arrayValues: 100,
  actionsPerRule: 10
});

export type ConditionFieldDefinition =
  | Readonly<{ type: "string" }>
  | Readonly<{ type: "enum"; values: readonly string[] }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{ type: "number" }>
  | Readonly<{ type: "instant" }>;

export type ConditionFieldDefinitions = Readonly<Record<string, ConditionFieldDefinition>>;

export const conditionOperators = Object.freeze([
  "eq",
  "ne",
  "in",
  "not_in",
  "exists",
  "not_exists",
  "gt",
  "gte",
  "lt",
  "lte",
  "before",
  "after"
] as const);

export type ConditionOperator = typeof conditionOperators[number];
export type ConditionScalar = string | number | boolean | null;
export type ConditionValue = ConditionScalar | readonly ConditionScalar[];

export type ConditionExpression =
  | Readonly<{ field: string; op: ConditionOperator; value?: ConditionValue }>
  | Readonly<{ all: readonly ConditionExpression[] }>
  | Readonly<{ any: readonly ConditionExpression[] }>
  | Readonly<{ not: ConditionExpression }>;

export type ConditionValidationIssue = Readonly<{
  code: "AUTOMATION_INVALID_CONDITION" | "AUTOMATION_LIMIT_EXCEEDED";
  path: string;
  message: string;
}>;

export type ConditionValidationResult =
  | Readonly<{ success: true; condition: ConditionExpression }>
  | Readonly<{ success: false; issues: readonly ConditionValidationIssue[] }>;

type PendingNode = Readonly<{ value: unknown; path: string; depth: number }>;

const unsafePathSegments = Object.freeze(["__proto__", "prototype", "constructor"]);
const hasOwn = (value: object, key: PropertyKey): boolean => Object.hasOwn(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const isScalar = (value: unknown): value is ConditionScalar =>
  value === null ||
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));
const pointer = (path: string, segment: string | number): string =>
  `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;

export const isIsoInstant = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarDate = new Date(0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  calendarDate.setUTCHours(0, 0, 0, 0);

  return calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day;
};

const isConditionOperator = (value: unknown): value is ConditionOperator =>
  typeof value === "string" &&
  conditionOperators.some((operator) => operator === value);

const makeIssue = (
  code: ConditionValidationIssue["code"],
  path: string,
  message: string
): ConditionValidationIssue => Object.freeze({ code, path, message });

export const checkAutomationJsonBounds = (input: unknown): ConditionValidationIssue | undefined => {
  const pending: PendingNode[] = [{ value: input, path: "", depth: 1 }];
  const visited = new WeakSet();
  let encodedBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    if (current.depth > automationLimits.jsonDepth) {
      return makeIssue(
        "AUTOMATION_LIMIT_EXCEEDED",
        current.path,
        "JSON payload exceeds the maximum nesting depth."
      );
    }

    const value = current.value;
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes > automationLimits.stringBytes) {
        return makeIssue(
          "AUTOMATION_LIMIT_EXCEEDED",
          current.path,
          "String value exceeds the maximum length."
        );
      }
      const serialized = JSON.stringify(value);
      encodedBytes += Buffer.byteLength(serialized, "utf8");
      if (encodedBytes > automationLimits.encodedPayloadBytes) {
        return makeIssue(
          "AUTOMATION_LIMIT_EXCEEDED",
          "",
          "JSON payload exceeds the maximum encoded size."
        );
      }
      continue;
    }

    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        return makeIssue("AUTOMATION_INVALID_CONDITION", current.path, "Numbers must be finite.");
      }
      const serialized = JSON.stringify(value);
      encodedBytes += Buffer.byteLength(serialized, "utf8");
      if (encodedBytes > automationLimits.encodedPayloadBytes) {
        return makeIssue(
          "AUTOMATION_LIMIT_EXCEEDED",
          "",
          "JSON payload exceeds the maximum encoded size."
        );
      }
      continue;
    }

    if (typeof value !== "object") {
      return makeIssue("AUTOMATION_INVALID_CONDITION", current.path, "Condition must be JSON data.");
    }

    if (visited.has(value)) {
      return makeIssue("AUTOMATION_INVALID_CONDITION", current.path, "Condition must not contain cycles.");
    }
    visited.add(value);

    if (Array.isArray(value)) {
      if (value.length > automationLimits.arrayValues) {
        return makeIssue(
          "AUTOMATION_LIMIT_EXCEEDED",
          current.path,
          "Array exceeds the maximum number of values."
        );
      }
      encodedBytes += 2 + Math.max(0, value.length - 1);
      if (encodedBytes > automationLimits.encodedPayloadBytes) {
        return makeIssue(
          "AUTOMATION_LIMIT_EXCEEDED",
          "",
          "JSON payload exceeds the maximum encoded size."
        );
      }
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], path: pointer(current.path, index), depth: current.depth + 1 });
      }
      continue;
    }

    if (!isRecord(value)) {
      return makeIssue("AUTOMATION_INVALID_CONDITION", current.path, "Condition must contain plain JSON objects.");
    }

    const keys = Object.keys(value);
    encodedBytes += 2 + Math.max(0, keys.length - 1);
    for (const key of keys) {
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (keyBytes > automationLimits.stringBytes) {
        return makeIssue(
          "AUTOMATION_LIMIT_EXCEEDED",
          pointer(current.path, key),
          "Object key exceeds the maximum length."
        );
      }
      const serializedKey = JSON.stringify(key);
      encodedBytes += Buffer.byteLength(serializedKey, "utf8") + 1;
    }
    if (encodedBytes > automationLimits.encodedPayloadBytes) {
      return makeIssue(
        "AUTOMATION_LIMIT_EXCEEDED",
        "",
        "JSON payload exceeds the maximum encoded size."
      );
    }
    for (const key of keys) {
      pending.push({ value: value[key], path: pointer(current.path, key), depth: current.depth + 1 });
    }
  }

  return undefined;
};

export const checkConditionTreeLimits = (input: unknown): ConditionValidationIssue | undefined => {
  const pending: PendingNode[] = [{ value: input, path: "", depth: 1 }];
  let nodeCount = 0;
  let groupCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    nodeCount += 1;
    if (nodeCount > automationLimits.nodes) {
      return makeIssue("AUTOMATION_LIMIT_EXCEEDED", current.path, "Condition tree exceeds the maximum number of nodes.");
    }
    if (current.depth > automationLimits.conditionDepth) {
      return makeIssue("AUTOMATION_LIMIT_EXCEEDED", current.path, "Condition tree exceeds the maximum depth.");
    }
    if (!isRecord(current.value)) continue;

    const keys = Object.keys(current.value);
    if (keys.length !== 1) continue;
    const groupKey = keys[0];
    if (groupKey === "all" || groupKey === "any") {
      groupCount += 1;
      if (groupCount > automationLimits.groups) {
        return makeIssue("AUTOMATION_LIMIT_EXCEEDED", current.path, "Condition tree exceeds the maximum number of groups.");
      }
      const children = current.value[groupKey];
      if (Array.isArray(children)) {
        for (let index = children.length - 1; index >= 0; index -= 1) {
          pending.push({ value: children[index], path: pointer(pointer(current.path, groupKey), index), depth: current.depth + 1 });
        }
      }
    } else if (groupKey === "not") {
      groupCount += 1;
      if (groupCount > automationLimits.groups) {
        return makeIssue("AUTOMATION_LIMIT_EXCEEDED", current.path, "Condition tree exceeds the maximum number of groups.");
      }
      pending.push({ value: current.value.not, path: pointer(current.path, "not"), depth: current.depth + 1 });
    }
  }
  return undefined;
};

export const isConditionFieldValueCompatible = (
  definition: ConditionFieldDefinition,
  value: unknown
): boolean => {
  if (value === null) return true;
  switch (definition.type) {
    case "string":
      return typeof value === "string";
    case "enum":
      return typeof value === "string" && definition.values.includes(value);
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "instant":
      return typeof value === "string" && isIsoInstant(value);
  }
};

const operatorMatchesField = (operator: ConditionOperator, definition: ConditionFieldDefinition): boolean => {
  if (operator === "exists" || operator === "not_exists") return true;
  if (["gt", "gte", "lt", "lte"].includes(operator)) return definition.type === "number";
  if (operator === "before" || operator === "after") return definition.type === "instant";
  return true;
};

export const validateCondition = (
  input: unknown,
  fieldDefinitions: ConditionFieldDefinitions
): ConditionValidationResult => {
  const boundsIssue = checkAutomationJsonBounds(input);
  if (boundsIssue) return Object.freeze({ success: false, issues: Object.freeze([boundsIssue]) });
  const treeLimitIssue = checkConditionTreeLimits(input);
  if (treeLimitIssue) return Object.freeze({ success: false, issues: Object.freeze([treeLimitIssue]) });

  const pending: PendingNode[] = [{ value: input, path: "", depth: 1 }];
  const issues: ConditionValidationIssue[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    if (!isRecord(current.value)) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", current.path, "Condition node must be an object."));
      continue;
    }

    const keys = Object.keys(current.value);
    const groupKey = keys.length === 1 ? keys[0] : undefined;
    if (groupKey === "all" || groupKey === "any") {
      const children = current.value[groupKey];
      if (!Array.isArray(children) || children.length === 0) {
        issues.push(makeIssue(
          "AUTOMATION_INVALID_CONDITION",
          pointer(current.path, groupKey),
          "Condition groups must contain at least one child."
        ));
        continue;
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: children[index],
          path: pointer(pointer(current.path, groupKey), index),
          depth: current.depth + 1
        });
      }
      continue;
    }

    if (groupKey === "not") {
      pending.push({ value: current.value.not, path: pointer(current.path, "not"), depth: current.depth + 1 });
      continue;
    }

    const allowedKeys = new Set(["field", "op", "value"]);
    if (keys.some((key) => !allowedKeys.has(key))) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", current.path, "Condition contains unsupported properties."));
      continue;
    }

    const field = current.value.field;
    const operator = current.value.op;
    if (typeof field !== "string" || field.length === 0) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "field"), "Field path is required."));
      continue;
    }
    if (field.split(".").some((segment) => segment.length === 0 || unsafePathSegments.includes(segment))) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "field"), "Field path contains an unsafe segment."));
      continue;
    }
    if (!Object.hasOwn(fieldDefinitions, field)) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "field"), "Field is not allowed for this trigger."));
      continue;
    }
    const fieldDefinition = fieldDefinitions[field];
    if (!fieldDefinition) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "field"), "Field is not allowed for this trigger."));
      continue;
    }
    if (!isConditionOperator(operator)) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "op"), "Operator is not supported."));
      continue;
    }
    if (!operatorMatchesField(operator, fieldDefinition)) {
      issues.push(makeIssue(
        "AUTOMATION_INVALID_CONDITION",
        pointer(current.path, "op"),
        "Operator is incompatible with the trigger field type."
      ));
      continue;
    }

    const valueRequired = operator !== "exists" && operator !== "not_exists";
    if (valueRequired !== hasOwn(current.value, "value")) {
      issues.push(makeIssue(
        "AUTOMATION_INVALID_CONDITION",
        pointer(current.path, "value"),
        valueRequired ? "Operator requires a value." : "Operator does not accept a value."
      ));
      continue;
    }

    if (!valueRequired) continue;
    const operand = current.value.value;
    if (operator === "in" || operator === "not_in") {
      if (!Array.isArray(operand) ||
          operand.length === 0 ||
          operand.some((item) => !isScalar(item) || !isConditionFieldValueCompatible(fieldDefinition, item))) {
        issues.push(makeIssue(
          "AUTOMATION_INVALID_CONDITION",
          pointer(current.path, "value"),
          "Membership operators require a non-empty array of scalar values."
        ));
      }
      continue;
    }
    if (!isScalar(operand)) {
      issues.push(makeIssue(
        "AUTOMATION_INVALID_CONDITION",
        pointer(current.path, "value"),
        "Operator requires a scalar value."
      ));
      continue;
    }
    if (!isConditionFieldValueCompatible(fieldDefinition, operand)) {
      issues.push(makeIssue(
        "AUTOMATION_INVALID_CONDITION",
        pointer(current.path, "value"),
        "Condition value is incompatible with the trigger field type."
      ));
      continue;
    }
    if (["gt", "gte", "lt", "lte"].includes(operator) && (typeof operand !== "number" || !Number.isFinite(operand))) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "value"), "Numeric operators require a finite number."));
    }
    if ((operator === "before" || operator === "after") && (typeof operand !== "string" || !isIsoInstant(operand))) {
      issues.push(makeIssue("AUTOMATION_INVALID_CONDITION", pointer(current.path, "value"), "Date operators require an ISO-8601 instant with a timezone."));
    }
  }

  if (issues.length > 0) {
    return Object.freeze({ success: false, issues: Object.freeze(issues) });
  }

  return Object.freeze({ success: true, condition: input as ConditionExpression });
};
