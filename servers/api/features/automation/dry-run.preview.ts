import { z } from "zod";
import { actionRegistry, triggerRegistry } from "./automation.registry.js";
import type { AutomationHeader } from "./automation.repository.js";
import { createConditionEvaluator } from "./condition.evaluator.js";
import { validateCondition, type ConditionExpression } from "./condition.validation.js";
import { validateRuleDraft, type RuleValidationIssue } from "./rule.validation.js";
import { redactValue } from "./telemetry.redaction.js";

/**
 * Sample evaluation context for `task.status_changed`. Fields are optional so an author can
 * preview partial data; missing fields surface as explicit limitations, never as guesses.
 */
export const dryRunSampleSchema = z.object({
  task: z.object({
    status: z.string().min(1),
    previousStatus: z.string().min(1),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    isArchived: z.boolean()
  }).partial().strict()
}).strict();

export type DryRunSample = z.infer<typeof dryRunSampleSchema>;

export type DryRunConditionResult = "matched" | "not_matched" | "evaluation_error";

export type DryRunConditionExplanation =
  | Readonly<{
      kind: "predicate";
      path: string;
      result: DryRunConditionResult;
      field: string;
      op: string;
      expected: unknown;
      actual: unknown;
      actualPresent: boolean;
      message: string | null;
    }>
  | Readonly<{
      kind: "group";
      group: "all" | "any" | "not";
      path: string;
      result: DryRunConditionResult;
      children: readonly DryRunConditionExplanation[];
    }>;

export type DryRunActionPlan = Readonly<{
  index: number;
  type: string;
  schemaVersion: number;
  sideEffect: string;
  requiredPermission: string;
  onStale: "skip";
  wouldExecute: boolean;
  config: unknown;
}>;

export type DryRunPreview = Readonly<{
  trigger: Readonly<{ type: string; matched: boolean | null; reason: string }>;
  conditions: Readonly<{ result: DryRunConditionResult; explanation: DryRunConditionExplanation }>;
  actions: readonly DryRunActionPlan[];
  limitations: readonly string[];
  sideEffects: "none";
}>;

export type DryRunResult =
  | Readonly<{ valid: true; errors: readonly RuleValidationIssue[]; preview: DryRunPreview }>
  | Readonly<{ valid: false; errors: readonly RuleValidationIssue[]; preview: null }>;

type EvaluateFn = ReturnType<typeof createConditionEvaluator>;

type ExplainContext = Readonly<{
  evaluate: EvaluateFn;
  sample: DryRunSample;
  limitations: Set<string>;
}>;

const invalidResult = (errors: readonly RuleValidationIssue[]): DryRunResult =>
  Object.freeze({ valid: false, errors, preview: null });

const lookup = (
  sample: unknown,
  field: string
): Readonly<{ present: boolean; value: unknown }> => {
  let current: unknown = sample;
  for (const segment of field.split(".")) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) {
      return Object.freeze({ present: false, value: null });
    }
    const next: unknown = Reflect.get(current, segment);
    current = next;
  }
  return Object.freeze({ present: true, value: current });
};

const explain = (
  node: ConditionExpression,
  path: string,
  context: ExplainContext
): DryRunConditionExplanation => {
  // Same evaluator the worker uses; each subtree is itself a valid condition.
  const outcome = context.evaluate(node, context.sample);
  if ("all" in node) {
    return Object.freeze({
      kind: "group",
      group: "all",
      path,
      result: outcome.status,
      children: Object.freeze(node.all.map((child, index) =>
        explain(child, `${path}/all/${String(index)}`, context)))
    });
  }
  if ("any" in node) {
    return Object.freeze({
      kind: "group",
      group: "any",
      path,
      result: outcome.status,
      children: Object.freeze(node.any.map((child, index) =>
        explain(child, `${path}/any/${String(index)}`, context)))
    });
  }
  if ("not" in node) {
    return Object.freeze({
      kind: "group",
      group: "not",
      path,
      result: outcome.status,
      children: Object.freeze([explain(node.not, `${path}/not`, context)])
    });
  }
  const actual = lookup(context.sample, node.field);
  if (!actual.present && outcome.status === "evaluation_error") {
    context.limitations.add(
      `The sample does not include "${node.field}", which a condition references; provide it to preview that condition.`
    );
  }
  return Object.freeze({
    kind: "predicate",
    path,
    result: outcome.status,
    field: node.field,
    op: node.op,
    expected: node.value === undefined ? null : redactValue(node.value),
    actual: actual.present ? redactValue(actual.value) : null,
    actualPresent: actual.present,
    message: outcome.status === "evaluation_error" ? outcome.message : null
  });
};

/**
 * Pure, side-effect-free preview. It receives an already-read header and a bounded sample,
 * has no repository, handler, executor, audit, or clock dependency, and never executes actions.
 */
export const buildDryRunPreview = (
  header: AutomationHeader,
  sample: DryRunSample
): DryRunResult => {
  const validation = validateRuleDraft(header.draft);
  if (!validation.valid) return invalidResult(validation.errors);
  const rule = validation.rule;

  const trigger = triggerRegistry.get(rule.trigger.type);
  if (!trigger) {
    return invalidResult([Object.freeze({
      code: "AUTOMATION_INVALID_TRIGGER" as const,
      path: "/trigger/type",
      message: "Trigger type is not registered."
    })]);
  }
  const condition = validateCondition(rule.conditions, trigger.fields);
  if (!condition.success) {
    return invalidResult(condition.issues.map((issue) => Object.freeze({
      code: issue.code,
      path: `/conditions${issue.path}`,
      message: issue.message
    })));
  }

  const limitations = new Set<string>();
  const evaluate = createConditionEvaluator(triggerRegistry, rule.trigger.type);
  const explanation = explain(condition.condition, "", { evaluate, sample, limitations });

  const toStatus = rule.trigger.config.toStatus;
  const sampleStatus = sample.task.status;
  let triggerMatched: boolean | null = null;
  let triggerReason = "Trigger match could not be previewed from this sample.";
  if (sampleStatus === undefined) {
    limitations.add('The sample does not include "task.status", so the trigger match cannot be previewed.');
  } else if (typeof toStatus === "string") {
    triggerMatched = sampleStatus === toStatus;
    triggerReason = triggerMatched
      ? "Sample task.status equals the trigger's toStatus."
      : "Sample task.status differs from the trigger's toStatus.";
  }

  const wouldExecute = triggerMatched === true && explanation.result === "matched";
  const actions: DryRunActionPlan[] = [];
  for (const [index, action] of rule.actions.entries()) {
    const registered = actionRegistry.get(action.type);
    if (!registered) {
      return invalidResult([Object.freeze({
        code: "AUTOMATION_INVALID_ACTION" as const,
        path: `/actions/${String(index)}/type`,
        message: "Action type is not registered."
      })]);
    }
    limitations.add(
      `Action ${String(index)} (${action.type}): runtime authorization and recipient resolution are evaluated at execution time and are not previewed.`
    );
    actions.push(Object.freeze({
      index,
      type: action.type,
      schemaVersion: registered.schemaVersion,
      sideEffect: registered.sideEffect,
      requiredPermission: registered.requiredPermission.permission,
      onStale: action.onStale,
      wouldExecute,
      config: redactValue(action.config)
    }));
  }

  return Object.freeze({
    valid: true,
    errors: Object.freeze([]),
    preview: Object.freeze({
      trigger: Object.freeze({
        type: rule.trigger.type,
        matched: triggerMatched,
        reason: triggerReason
      }),
      conditions: Object.freeze({ result: explanation.result, explanation }),
      actions: Object.freeze(actions),
      limitations: Object.freeze([...limitations].sort()),
      sideEffects: "none" as const
    })
  });
};