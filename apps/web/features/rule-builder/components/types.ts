import type { ReactNode } from "react";

export type ConditionOperator =
  | "eq"
  | "ne"
  | "in"
  | "not_in"
  | "exists"
  | "not_exists"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after";

export type ConditionLeafState = Readonly<{
  id: string;
  kind: "leaf";
  field: string;
  op: ConditionOperator;
  value: string;
}>;

export type ConditionGroupState = Readonly<{
  id: string;
  kind: "group";
  conjunction: "all" | "any";
  children: readonly (ConditionLeafState | ConditionGroupState)[];
}>;

export type TriggerConfigState = Readonly<{
  type: string;
  toStatus: string;
  allowAutomationOrigin: boolean;
}>;

export type ActionConfigState = Readonly<{
  id: string;
  type: string;
  recipientType: string;
  template: string;
  onStale: "skip";
}>;

export type ExecutionPolicyState = Readonly<{
  onActionFailure: string;
  maxAttempts: number;
}>;

export type RuleDraftFormState = Readonly<{
  name: string;
  trigger: TriggerConfigState;
  conditions: ConditionGroupState;
  actions: readonly ActionConfigState[];
  executionPolicy: ExecutionPolicyState;
}>;

export type ServerValidationIssue = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type ConflictInfo = Readonly<{
  occurred: boolean;
  message: string;
  expectedRevision?: number | undefined;
  actualRevision?: number | undefined;
}>;

export type SaveDraftResult =
  | Readonly<{ kind: "success"; automationId: string; revision: number }>
  | Readonly<{ kind: "validation-error"; errors: readonly ServerValidationIssue[] }>
  | Readonly<{ kind: "conflict"; message: string; expectedRevision?: number | undefined; actualRevision?: number | undefined }>
  | Readonly<{ kind: "error"; message: string }>;

export type RuleBuilderProps = Readonly<{
  initialDraft?: Partial<RuleDraftFormState> | undefined;
  initialRevision?: number | undefined;
  workspaceId?: string | undefined;
  automationId?: string | undefined;
  apiBaseUrl?: string | undefined;
  bearerToken?: string | undefined;
  onSaveDraft?: ((draft: RuleDraftFormState, revision?: number | undefined) => Promise<SaveDraftResult>) | undefined;
  children?: ReactNode | undefined;
}>;
