import type { PolicyPort, Principal, WorkspaceScope } from "./automation.ports.js";
import type { AutomationHeader } from "./automation.repository.js";
import type { RunHistoryCursor, RunHistoryRepository } from "./run.history.repository.js";
import type {
  ActionAttempt,
  ActionStatus,
  DeadLetterInfo,
  RunStatus,
  StoredRun
} from "./run.repository.js";
import { scrubText } from "./telemetry.redaction.js";

/** [VERIFY] Must exist in the platform policy engine (same name as the dead-letter read permission). */
export const runHistoryPermissions = Object.freeze({ read: "automation.run.read" });

export type RunFailureView = Readonly<{
  reason: DeadLetterInfo["reason"];
  attempts: number;
  firstAttemptAt: string;
  deadLetteredAt: string;
  failureCode?: string;
  errorClass?: NonNullable<DeadLetterInfo["errorClass"]>;
  actionIndex?: number;
}>;

export type RunSummaryView = Readonly<{
  runId: string;
  revision: number;
  eventId: string;
  automationId: string;
  version: number;
  contentHash: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  interruptedReason?: string;
  skipReason?: string;
  replayOf?: string;
  failure?: RunFailureView;
}>;

export type RunActionView = Readonly<{
  actionIndex: number;
  attempt: number;
  status: ActionStatus;
  createdAt: string;
  updatedAt: string;
  actionType?: string;
}>;

export type RunDetailView = RunSummaryView & Readonly<{
  runAfter: string;
  attemptCount: number;
  actions: readonly RunActionView[];
}>;

const toFailure = (info: DeadLetterInfo): RunFailureView => Object.freeze({
  reason: info.reason,
  attempts: info.attempts,
  firstAttemptAt: info.firstAttemptAt,
  deadLetteredAt: info.deadLetteredAt,
  ...(info.failureCode === undefined ? {} : { failureCode: scrubText(info.failureCode) }),
  ...(info.errorClass === undefined ? {} : { errorClass: info.errorClass }),
  ...(info.actionIndex === undefined ? {} : { actionIndex: info.actionIndex })
});

// Allowlist views: lease owner, fencing token, chain key, traceparent, and unknown extras never leave here.
const toSummary = (run: StoredRun): RunSummaryView => Object.freeze({
  runId: run.runId,
  revision: run.revision,
  eventId: run.eventId,
  automationId: run.automationId,
  version: run.version,
  contentHash: run.contentHash,
  status: run.status,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  ...(run.interruptedReason === undefined ? {} : { interruptedReason: scrubText(run.interruptedReason) }),
  ...(run.skipReason === undefined ? {} : { skipReason: scrubText(run.skipReason) }),
  ...(run.replayOf === undefined ? {} : { replayOf: scrubText(run.replayOf) }),
  ...(run.deadLetter === undefined ? {} : { failure: toFailure(run.deadLetter) })
});

const toActionView = (attempt: ActionAttempt): RunActionView => Object.freeze({
  actionIndex: attempt.actionIndex,
  attempt: attempt.attempt,
  status: attempt.status,
  createdAt: attempt.createdAt,
  updatedAt: attempt.updatedAt,
  ...(attempt.actionType === undefined ? {} : { actionType: scrubText(attempt.actionType) })
});

export type RunHistoryListResult =
  | Readonly<{ kind: "page"; items: readonly RunSummaryView[]; next: RunHistoryCursor | undefined }>
  | Readonly<{ kind: "not-found" }>;

export type RunHistoryGetResult =
  | Readonly<{ kind: "found"; item: RunDetailView }>
  | Readonly<{ kind: "not-found" }>;

export type RunHistoryService = Readonly<{
  listForAutomation: (
    scope: WorkspaceScope,
    principal: Principal,
    automationId: string,
    page: Readonly<{ after: RunHistoryCursor | undefined; limit: number }>
  ) => Promise<RunHistoryListResult>;
  get: (scope: WorkspaceScope, principal: Principal, runId: string) => Promise<RunHistoryGetResult>;
}>;

const notFound = Object.freeze({ kind: "not-found" as const });

export const createRunHistoryService = ({
  history,
  automations,
  policy,
  ownsScope
}: Readonly<{
  history: RunHistoryRepository;
  automations: Readonly<{
    findById: (scope: WorkspaceScope, automationId: string) => Promise<AutomationHeader | undefined>;
  }>;
  policy: PolicyPort;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
}>): RunHistoryService => {
  const requireScope = (scope: WorkspaceScope): void => {
    if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
  };

  return Object.freeze({
    listForAutomation: async (scope, principal, automationId, page) => {
      requireScope(scope);
      const automation = await automations.findById(scope, automationId);
      if (!automation) return notFound;
      const allowed = await policy.authorize(
        principal,
        runHistoryPermissions.read,
        { type: "automation", id: automationId }
      );
      if (!allowed) return notFound;
      const result = await history.listRuns(scope, automationId, page);
      return Object.freeze({
        kind: "page" as const,
        items: Object.freeze(result.items.map((run) => toSummary(run))),
        next: result.next
      });
    },

    get: async (scope, principal, runId) => {
      requireScope(scope);
      const run = await history.findRun(scope, runId);
      if (!run) return notFound;
      const allowed = await policy.authorize(
        principal,
        runHistoryPermissions.read,
        { type: "automation", id: run.automationId }
      );
      if (!allowed) return notFound;
      const attempts = await history.listActionAttempts(scope, runId);
      const actions = Object.freeze(attempts.map((attempt) => toActionView(attempt)));
      return Object.freeze({
        kind: "found" as const,
        item: Object.freeze({
          ...toSummary(run),
          runAfter: run.runAfter,
          attemptCount: actions.length,
          actions
        })
      });
    }
  });
};
