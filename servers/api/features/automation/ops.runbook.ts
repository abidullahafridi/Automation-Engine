import type { Principal, WorkspaceScope } from "./automation.ports.js";
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import { decideDeadLetterRecovery, type RecoveryBlockCode } from "./dead-letter.policy.js";
import type {
  DeadLetterListResult,
  DeadLetterService,
  RetryRequest,
  RetryResult
} from "./dead-letter.service.js";
import type { ActionAttempt, DeadLetterCursor, DeadLetterInfo } from "./run.repository.js";

export type DlqNextStep =
  | Readonly<{ step: "retry" }>
  | Readonly<{ step: "confirm-non-idempotent"; actionIndexes: readonly number[] }>
  | Readonly<{ step: "reconcile-first"; actionIndexes: readonly number[] }>
  | Readonly<{ step: "escalate"; code: RecoveryBlockCode; actionIndexes: readonly number[] }>;

export type DlqDiagnosis = Readonly<{
  runId: string;
  automationId: string;
  /** Pass this as expectedRevision when resolving. */
  revision: number;
  deadLetter: DeadLetterInfo | undefined;
  next: DlqNextStep;
  /** Static operator guidance for the next step. Never contains run data. */
  instructions: readonly string[];
}>;

export type DlqDiagnoseResult =
  | Readonly<{ kind: "diagnosed"; diagnosis: DlqDiagnosis }>
  | Readonly<{ kind: "not-found" }>;

export type DlqRunbook = Readonly<{
  /** Step 1: find dead-lettered runs. */
  locate: (
    scope: WorkspaceScope,
    principal: Principal,
    page: Readonly<{ after: DeadLetterCursor | undefined; limit: number }>
  ) => Promise<DeadLetterListResult>;
  /** Step 2: read-only. Decides the safe next step. Changes nothing and writes no audit record. */
  diagnose: (scope: WorkspaceScope, principal: Principal, runId: string) => Promise<DlqDiagnoseResult>;
  /** Step 3: audited retry. Authorization, safety policy and revision check live in DeadLetterService. */
  resolve: (scope: WorkspaceScope, principal: Principal, request: RetryRequest) => Promise<RetryResult>;
}>;

const instructionsFor: Readonly<Record<DlqNextStep["step"], readonly string[]>> = Object.freeze({
  retry: Object.freeze([
    "Fix the cause first (provider outage, permissions, configuration).",
    "Retry with a written reason and the revision shown here."
  ]),
  "confirm-non-idempotent": Object.freeze([
    "A failed action is not safe to repeat automatically.",
    "Verify in the target system that the effect did not happen.",
    "Retry again confirming only the listed action indexes."
  ]),
  "reconcile-first": Object.freeze([
    "An action ended with an unknown outcome: its effect may have happened.",
    "Check the real outcome in the target system. Confirmation cannot override this.",
    "A reconciliation operation does not exist yet; escalate to the owning engineer."
  ]),
  escalate: Object.freeze([
    "The run cannot be judged safe (unknown action type or an action still running).",
    "Escalate to the owning engineer. Do not retry."
  ])
});

const epoch = "1970-01-01T00:00:00.000Z";

const toNextStep = (
  decision: ReturnType<typeof decideDeadLetterRecovery>
): DlqNextStep => {
  if (decision.decision === "allow") return Object.freeze({ step: "retry" as const });
  switch (decision.code) {
    case "UNCONFIRMED_NON_IDEMPOTENT":
      return Object.freeze({ step: "confirm-non-idempotent" as const, actionIndexes: decision.actionIndexes });
    case "RECONCILIATION_REQUIRED":
      return Object.freeze({ step: "reconcile-first" as const, actionIndexes: decision.actionIndexes });
    case "RUN_NOT_SETTLED":
    case "UNKNOWN_ACTION_TYPE":
      return Object.freeze({ step: "escalate" as const, code: decision.code, actionIndexes: decision.actionIndexes });
  }
};

export const createDlqRunbook = ({
  deadLetters,
  actions = actionRegistry
}: Readonly<{
  deadLetters: Pick<DeadLetterService, "list" | "get" | "retry">;
  actions?: ActionRegistry;
}>): DlqRunbook => Object.freeze({
  locate: (scope, principal, page) => deadLetters.list(scope, principal, page),

  diagnose: async (scope, principal, runId) => {
    // get() enforces authorization and workspace scope; an unauthorized caller sees "not found".
    const found = await deadLetters.get(scope, principal, runId);
    if (found.kind === "not-found") return Object.freeze({ kind: "not-found" as const });
    const item = found.item;

    // The policy only reads index, attempt, status and type; timestamps are placeholders.
    const attempts: readonly ActionAttempt[] = item.actions.map((action) => Object.freeze({
      runId: item.runId,
      workspaceId: scope.workspaceId,
      actionIndex: action.actionIndex,
      attempt: action.attempt,
      status: action.status,
      createdAt: epoch,
      updatedAt: epoch,
      ...(action.actionType === undefined ? {} : { actionType: action.actionType })
    }));

    const next = toNextStep(decideDeadLetterRecovery({ attempts, confirmedActionIndexes: [] }, actions));
    return Object.freeze({
      kind: "diagnosed" as const,
      diagnosis: Object.freeze({
        runId: item.runId,
        automationId: item.automationId,
        revision: item.revision,
        deadLetter: item.deadLetter,
        next,
        instructions: instructionsFor[next.step]
      })
    });
  },

  resolve: (scope, principal, request) => deadLetters.retry(scope, principal, request)
});