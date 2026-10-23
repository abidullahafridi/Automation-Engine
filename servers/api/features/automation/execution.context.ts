import type { ActionExecutionRequest } from "./action.executor.js";
import {
  automationExecutionPrincipal,
  type Principal,
  type WorkspaceScope
} from "./automation.ports.js";
import type { AutomationHeader, AutomationRepository } from "./automation.repository.js";

/**
 * Standing of the automation creator inside ONE workspace.
 * Proposed default policy (confirm with the platform team): only "member" may own a running automation.
 */
export type CreatorStanding = "member" | "guest" | "api-key" | "removed" | "unknown";

export type CreatorStandingPort = Readonly<{
  lookup: (scope: WorkspaceScope, creatorId: string) => Promise<CreatorStanding>;
}>;

export type ExecutionDenialCode =
  | "SCOPE_MISSING"
  | "SCOPE_MISMATCH"
  | "AUTOMATION_NOT_FOUND"
  | "AUTOMATION_NOT_ENABLED"
  | "AUTOMATION_LOOKUP_UNAVAILABLE"
  | "OWNER_ACCESS_LOST"
  | "OWNER_ROLE_NOT_ALLOWED"
  | "STANDING_UNAVAILABLE";

export type ExecutionRun = Readonly<{
  runId: string;
  workspaceId: string;
  automationId: string;
}>;

/** Everything downstream code may rely on. Built only after every scope/standing check passed. */
export type TrustedExecutionContext = Readonly<{
  scope: WorkspaceScope;
  workspaceId: string;
  automationId: string;
  runId: string;
  creatorId: string;
  principal: Principal;
}>;

export type ExecutionContextResult =
  | Readonly<{ kind: "ready"; context: TrustedExecutionContext }>
  | Readonly<{
      kind: "denied";
      code: ExecutionDenialCode;
      /** True only for infrastructure faults; policy denials are permanent. */
      retryable: boolean;
      /** True when the automation should auto-pause (OWNER_ACCESS_LOST, spec D-12). */
      pauseAutomation: boolean;
    }>;

export type ExecutionContextResolver = Readonly<{
  resolve: (scope: WorkspaceScope, run: ExecutionRun) => Promise<ExecutionContextResult>;
}>;

const denialTraits: Readonly<Record<ExecutionDenialCode, Readonly<{ retryable: boolean; pauseAutomation: boolean }>>> = {
  SCOPE_MISSING: { retryable: false, pauseAutomation: false },
  SCOPE_MISMATCH: { retryable: false, pauseAutomation: false },
  AUTOMATION_NOT_FOUND: { retryable: false, pauseAutomation: false },
  AUTOMATION_NOT_ENABLED: { retryable: false, pauseAutomation: false },
  AUTOMATION_LOOKUP_UNAVAILABLE: { retryable: true, pauseAutomation: false },
  OWNER_ACCESS_LOST: { retryable: false, pauseAutomation: true },
  OWNER_ROLE_NOT_ALLOWED: { retryable: false, pauseAutomation: true },
  STANDING_UNAVAILABLE: { retryable: true, pauseAutomation: false }
};

/** Explicit role policy. `undefined` means allowed. Unknown standing fails closed. */
const standingDenial: Readonly<Record<CreatorStanding, ExecutionDenialCode | undefined>> = {
  member: undefined,
  guest: "OWNER_ROLE_NOT_ALLOWED",
  "api-key": "OWNER_ROLE_NOT_ALLOWED",
  removed: "OWNER_ACCESS_LOST",
  unknown: "OWNER_ACCESS_LOST"
};

const denied = (code: ExecutionDenialCode): ExecutionContextResult =>
  Object.freeze({ kind: "denied", code, ...denialTraits[code] });

/** Fail-closed default used until a real platform adapter exists. */
export const createDenyAllCreatorStandingPort = (): CreatorStandingPort =>
  Object.freeze({ lookup: () => Promise.resolve<CreatorStanding>("unknown") });

export const createExecutionContextResolver = ({
  ownsScope,
  automations,
  creators
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  automations: Pick<AutomationRepository, "findById">;
  creators: CreatorStandingPort;
}>): ExecutionContextResolver => Object.freeze({
  resolve: async (scope, run): Promise<ExecutionContextResult> => {
    // 1. Trusted scope first: a forged or missing scope never reaches a repository.
    if (!ownsScope(scope)) return denied("SCOPE_MISSING");
    if (run.workspaceId !== scope.workspaceId) return denied("SCOPE_MISMATCH");

    // 2. Workspace-scoped lookup. Another workspace's automation is simply "not found".
    let header: AutomationHeader | undefined;
    try {
      header = await automations.findById(scope, run.automationId);
    } catch {
      return denied("AUTOMATION_LOOKUP_UNAVAILABLE");
    }
    if (!header) return denied("AUTOMATION_NOT_FOUND");
    if (header.workspaceId !== scope.workspaceId) return denied("SCOPE_MISMATCH");
    if (header.status !== "enabled") return denied("AUTOMATION_NOT_ENABLED");

    // 3. Creator standing is re-evaluated on every run (never trusted from authoring time).
    let standing: CreatorStanding;
    try {
      standing = await creators.lookup(scope, header.createdBy);
    } catch {
      return denied("STANDING_UNAVAILABLE");
    }
    const denial = standingDenial[standing];
    if (denial) return denied(denial);

    return Object.freeze({
      kind: "ready",
      context: Object.freeze({
        scope,
        workspaceId: scope.workspaceId,
        automationId: header.automationId,
        runId: run.runId,
        creatorId: header.createdBy,
        principal: automationExecutionPrincipal(header.automationId, header.createdBy)
      })
    });
  }
});

/** Carries the trusted scope from the run to the action executor. */
export const toActionExecutionRequest = (
  context: TrustedExecutionContext,
  step: Readonly<{
    actionIndex: number;
    action: Readonly<{ type: string; config: unknown }>;
    signal?: AbortSignal;
  }>
): ActionExecutionRequest => Object.freeze({
  scope: context.scope,
  run: Object.freeze({
    runId: context.runId,
    workspaceId: context.workspaceId,
    automationId: context.automationId
  }),
  creatorId: context.creatorId,
  actionIndex: step.actionIndex,
  action: step.action,
  ...(step.signal ? { signal: step.signal } : {})
});