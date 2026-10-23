import { z } from "zod";
import {
  actionRegistry,
  triggerRegistry
} from "./automation.registry.js";
import {
  automationLimits,
  checkAutomationJsonBounds,
  checkConditionTreeLimits,
  validateCondition
} from "./condition.validation.js";

export type RuleValidationCode =
  | "AUTOMATION_INVALID_RULE"
  | "AUTOMATION_INVALID_TRIGGER"
  | "AUTOMATION_INVALID_CONDITION"
  | "AUTOMATION_INVALID_ACTION"
  | "AUTOMATION_LIMIT_EXCEEDED";

export type RuleValidationIssue = Readonly<{
  code: RuleValidationCode;
  path: string;
  message: string;
}>;

export type RuleValidationResult =
  | Readonly<{ valid: true; errors: readonly RuleValidationIssue[]; rule: RuleDocument }>
  | Readonly<{ valid: false; errors: readonly RuleValidationIssue[] }>;

const nonUndefinedUnknown = z.unknown().refine((value) => value !== undefined);
const objectConfig = z.record(z.string(), z.unknown());

const ruleStructureSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  trigger: z.object({
    type: z.string().min(1),
    config: objectConfig
  }).strict(),
  conditions: nonUndefinedUnknown,
  actions: z.array(z.object({
    type: z.string().min(1),
    config: objectConfig,
    onStale: z.literal("skip")
  }).strict()),
  executionPolicy: z.object({
    onActionFailure: z.string().min(1),
    maxAttempts: z.number().int().positive()
  }).strict()
}).strict();

export type RuleDocument = z.infer<typeof ruleStructureSchema>;
type RuleStructure = RuleDocument;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const pointer = (path: string, segment: string | number): string =>
  `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;

const codeForPath = (path: string): RuleValidationCode => {
  if (path === "/trigger" || path.startsWith("/trigger/")) return "AUTOMATION_INVALID_TRIGGER";
  if (path === "/conditions" || path.startsWith("/conditions/")) return "AUTOMATION_INVALID_CONDITION";
  if (path === "/actions" || path.startsWith("/actions/")) return "AUTOMATION_INVALID_ACTION";
  return "AUTOMATION_INVALID_RULE";
};

const makeIssue = (
  code: RuleValidationCode,
  path: string,
  message: string
): RuleValidationIssue => Object.freeze({ code, path, message });

const schemaIssues = (
  error: z.ZodError,
  overrideCode?: RuleValidationCode
): RuleValidationIssue[] => {
  const issues: RuleValidationIssue[] = [];
  for (const issue of error.issues) {
    const basePath = issue.path.reduce<string>((path, segment) =>
      pointer(path, typeof segment === "string" || typeof segment === "number" ? segment : String(segment)), "");
    if ("keys" in issue) {
      for (const key of issue.keys) {
        const path = pointer(basePath, key);
        issues.push(makeIssue(overrideCode ?? codeForPath(path), path, "Unsupported property."));
      }
    } else {
      const code = overrideCode ?? codeForPath(basePath);
      const message = code === "AUTOMATION_INVALID_TRIGGER"
        ? "Trigger structure is invalid."
        : code === "AUTOMATION_INVALID_CONDITION"
          ? "Condition structure is invalid."
          : code === "AUTOMATION_INVALID_ACTION"
            ? "Action structure is invalid."
            : "Rule structure is invalid.";
      issues.push(makeIssue(code, basePath, message));
    }
  }
  return issues;
};

const sortedIssues = (issues: readonly RuleValidationIssue[]): readonly RuleValidationIssue[] =>
  Object.freeze([...issues].sort((left, right) => {
    const compare = (first: string, second: string): number =>
      first < second ? -1 : first > second ? 1 : 0;
    return compare(left.path, right.path) ||
      compare(left.code, right.code) ||
      compare(left.message, right.message);
  }));

const invalid = (issues: readonly RuleValidationIssue[]): RuleValidationResult =>
  Object.freeze({ valid: false, errors: sortedIssues(issues) });

const validateStructure = (input: unknown): RuleStructure | RuleValidationResult => {
  const parsed = ruleStructureSchema.safeParse(input);
  if (!parsed.success) return invalid(schemaIssues(parsed.error));
  return parsed.data;
};

const validateRegisteredComponents = (rule: RuleStructure): RuleValidationIssue[] => {
  const issues: RuleValidationIssue[] = [];
  const trigger = triggerRegistry.get(rule.trigger.type);
  if (!trigger) {
    issues.push(makeIssue(
      "AUTOMATION_INVALID_TRIGGER",
      "/trigger/type",
      "Trigger type is not registered."
    ));
  } else {
    const triggerConfig = trigger.configSchema.safeParse(rule.trigger.config);
    if (!triggerConfig.success) {
      issues.push(...schemaIssues(triggerConfig.error, "AUTOMATION_INVALID_TRIGGER").map((issue) => makeIssue(
        "AUTOMATION_INVALID_TRIGGER",
        `/trigger/config${issue.path}`,
        "Trigger configuration does not match its registered schema."
      )));
    }
    const conditionResult = validateCondition(rule.conditions, trigger.fields);
    if (!conditionResult.success) {
      issues.push(...conditionResult.issues.map((issue) => makeIssue(
        issue.code,
        `/conditions${issue.path}`,
        issue.message
      )));
    }
  }

  for (const [index, action] of rule.actions.entries()) {
    const registeredAction = actionRegistry.get(action.type);
    const actionPath = pointer("/actions", index);
    if (!registeredAction) {
      issues.push(makeIssue(
        "AUTOMATION_INVALID_ACTION",
        pointer(actionPath, "type"),
        "Action type is not registered."
      ));
      continue;
    }
    const actionConfig = registeredAction.configSchema.safeParse(action.config);
    if (!actionConfig.success) {
      issues.push(...schemaIssues(actionConfig.error, "AUTOMATION_INVALID_ACTION").map((issue) => makeIssue(
        "AUTOMATION_INVALID_ACTION",
        `${actionPath}/config${issue.path}`,
        "Action configuration does not match its registered schema."
      )));
    }
  }
  return issues;
};

export const validateRuleDraft = (input: unknown): RuleValidationResult => {
  const boundsIssue = checkAutomationJsonBounds(input);
  if (boundsIssue) {
    return invalid([makeIssue(
      boundsIssue.code === "AUTOMATION_LIMIT_EXCEEDED" ? "AUTOMATION_LIMIT_EXCEEDED" : "AUTOMATION_INVALID_RULE",
      boundsIssue.path,
      boundsIssue.code === "AUTOMATION_LIMIT_EXCEEDED" ? boundsIssue.message : "Rule must be JSON data."
    )]);
  }

  if (isRecord(input) && Object.hasOwn(input, "conditions")) {
    const conditionLimitIssue = checkConditionTreeLimits(input.conditions);
    if (conditionLimitIssue) {
      return invalid([makeIssue(
        "AUTOMATION_LIMIT_EXCEEDED",
        `/conditions${conditionLimitIssue.path}`,
        conditionLimitIssue.message
      )]);
    }
  }

  if (isRecord(input) && Array.isArray(input.actions) && input.actions.length > automationLimits.actionsPerRule) {
    return invalid([makeIssue(
      "AUTOMATION_LIMIT_EXCEEDED",
      "/actions",
      "Rule exceeds the maximum number of actions."
    )]);
  }

  const structure = validateStructure(input);
  if ("valid" in structure) return structure;

  const issues = validateRegisteredComponents(structure);
  return issues.length > 0
    ? invalid(issues)
    : Object.freeze({ valid: true, errors: Object.freeze([]), rule: structure });
};
