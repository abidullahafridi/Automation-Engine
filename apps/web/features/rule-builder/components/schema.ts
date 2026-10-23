import type {
  ConditionGroupState,
  ConditionLeafState,
  ConditionOperator,
  RuleDraftFormState,
  ServerValidationIssue
} from "./types";

export const LIMITS = Object.freeze({
  MAX_CONDITION_DEPTH: 5,
  MAX_CONDITION_GROUPS: 10,
  MAX_CONDITION_NODES: 50,
  MAX_ACTIONS_PER_RULE: 10
});

export type TriggerFieldDefinition = Readonly<{
  label: string;
  type: "string" | "enum" | "boolean";
  options?: readonly string[];
}>;

export const SUPPORTED_TRIGGERS = Object.freeze({
  "task.status_changed": Object.freeze({
    type: "task.status_changed",
    label: "Task Status Changed",
    defaultConfig: Object.freeze({
      toStatus: "completed",
      allowAutomationOrigin: false
    }),
    fields: Object.freeze({
      "task.status": Object.freeze({
        label: "Task Status",
        type: "string" as const
      }),
      "task.previousStatus": Object.freeze({
        label: "Task Previous Status",
        type: "string" as const
      }),
      "task.priority": Object.freeze({
        label: "Task Priority",
        type: "enum" as const,
        options: Object.freeze(["low", "medium", "high", "urgent"] as const)
      }),
      "task.isArchived": Object.freeze({
        label: "Task Is Archived",
        type: "boolean" as const
      })
    })
  })
});

export const SUPPORTED_OPERATORS: readonly Readonly<{ value: ConditionOperator; label: string }>[] = Object.freeze([
  { value: "eq", label: "Equals (=)" },
  { value: "ne", label: "Does Not Equal (≠)" },
  { value: "in", label: "In" },
  { value: "not_in", label: "Not In" },
  { value: "exists", label: "Exists" },
  { value: "not_exists", label: "Does Not Exist" },
  { value: "gt", label: "Greater Than (>)" },
  { value: "gte", label: "Greater Than or Equal (≥)" },
  { value: "lt", label: "Less Than (<)" },
  { value: "lte", label: "Less Than or Equal (≤)" },
  { value: "before", label: "Before" },
  { value: "after", label: "After" }
]);

export const SUPPORTED_ACTIONS = Object.freeze({
  "notification.send": Object.freeze({
    type: "notification.send",
    label: "Send Notification",
    schemaVersion: 1,
    defaultConfig: Object.freeze({
      recipientType: "project_lead",
      template: "task_completed",
      onStale: "skip" as const
    }),
    fields: Object.freeze({
      recipientType: Object.freeze({
        label: "Recipient",
        type: "enum" as const,
        options: Object.freeze(["project_lead"] as const)
      }),
      template: Object.freeze({
        label: "Template",
        type: "enum" as const,
        options: Object.freeze(["task_completed"] as const)
      })
    })
  })
});

export const calculateConditionStats = (
  node: ConditionGroupState | ConditionLeafState,
  currentDepth = 1
): { maxDepth: number; groupCount: number; nodeCount: number } => {
  if (node.kind === "leaf") {
    return { maxDepth: currentDepth, groupCount: 0, nodeCount: 1 };
  }

  let maxDepth = currentDepth;
  let groupCount = 1;
  let nodeCount = 1;

  for (const child of node.children) {
    const childStats = calculateConditionStats(child, currentDepth + 1);
    if (childStats.maxDepth > maxDepth) {
      maxDepth = childStats.maxDepth;
    }
    groupCount += childStats.groupCount;
    nodeCount += childStats.nodeCount;
  }

  return { maxDepth, groupCount, nodeCount };
};

export const serializeCondition = (
  node: ConditionGroupState | ConditionLeafState
): unknown => {
  if (node.kind === "leaf") {
    if (node.op === "exists" || node.op === "not_exists") {
      return { field: node.field, op: node.op };
    }
    let parsedValue: unknown = node.value;
    if (node.value === "true") parsedValue = true;
    else if (node.value === "false") parsedValue = false;
    else if (!Number.isNaN(Number(node.value)) && node.value.trim() !== "") {
      parsedValue = Number(node.value);
    }
    return { field: node.field, op: node.op, value: parsedValue };
  }

  const serializedChildren = node.children.map(serializeCondition);
  return { [node.conjunction]: serializedChildren };
};

export const formStateToRulePayload = (form: RuleDraftFormState): unknown => ({
  schemaVersion: 1,
  name: form.name,
  trigger: {
    type: form.trigger.type,
    config: {
      toStatus: form.trigger.toStatus,
      allowAutomationOrigin: form.trigger.allowAutomationOrigin
    }
  },
  conditions: serializeCondition(form.conditions),
  actions: form.actions.map((action) => ({
    type: action.type,
    config: {
      recipient: { type: action.recipientType },
      template: action.template
    },
    onStale: action.onStale
  })),
  executionPolicy: {
    onActionFailure: form.executionPolicy.onActionFailure,
    maxAttempts: form.executionPolicy.maxAttempts
  }
});

export const mapServerErrorsToFields = (
  errors: readonly ServerValidationIssue[]
): Record<string, string> => {
  const result: Record<string, string> = {};

  for (const error of errors) {
    const path = error.path;
    let fieldKey = path;

    if (path === "/name" || path.startsWith("/name")) {
      fieldKey = "name";
    } else if (path.startsWith("/trigger/config/toStatus")) {
      fieldKey = "trigger.toStatus";
    } else if (path.startsWith("/trigger/config/allowAutomationOrigin")) {
      fieldKey = "trigger.allowAutomationOrigin";
    } else if (path.startsWith("/trigger")) {
      fieldKey = "trigger";
    } else if (path.startsWith("/actions/")) {
      const parts = path.split("/").filter(Boolean);
      // e.g. ["actions", "0", "config", "template"] -> actions.0.template
      const actionIndex = parts[1];
      if (parts.includes("template")) {
        fieldKey = `actions.${actionIndex}.template`;
      } else if (parts.includes("recipient")) {
        fieldKey = `actions.${actionIndex}.recipientType`;
      } else {
        fieldKey = `actions.${actionIndex}`;
      }
    } else if (path === "/actions") {
      fieldKey = "actions";
    } else if (path.startsWith("/conditions")) {
      fieldKey = "conditions";
    }

    if (!result[fieldKey]) {
      result[fieldKey] = error.message;
    }
  }

  return result;
};

