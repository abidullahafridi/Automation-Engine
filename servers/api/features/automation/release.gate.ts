import type { WorkspaceScope } from "./automation.ports.js";
import {
  decideExecution,
  decideIntake,
  deny,
  type ReleaseSnapshot,
  type RolloutDecision
} from "./release.flags.js";
import type { ReleaseControlStore } from "./release.store.js";

export type ReleaseGate = Readonly<{
  decideIntake: (scope: WorkspaceScope) => Promise<RolloutDecision>;
  decideExecution: (scope: WorkspaceScope) => Promise<RolloutDecision>;
  /** True only for a real "allow". Shadow is held because no plan-only execution path exists yet. */
  allowsIntake: (scope: WorkspaceScope) => Promise<boolean>;
  /** Bound to one trusted workspace scope; plugs into the run worker as its claim gate. */
  claimGateFor: (scope: WorkspaceScope) => () => Promise<boolean>;
}>;

/** Never throws. A missing scope or an unreadable store denies (fail closed). */
export const createReleaseGate = ({
  ownsScope,
  store
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  store: ReleaseControlStore;
}>): ReleaseGate => {
  const evaluate = async (
    scope: WorkspaceScope,
    decide: (snapshot: ReleaseSnapshot, workspaceId: string) => RolloutDecision
  ): Promise<RolloutDecision> => {
    if (!ownsScope(scope)) return deny("SCOPE_MISSING", false);
    let snapshot: ReleaseSnapshot;
    try {
      snapshot = await store.read();
    } catch {
      return deny("FLAGS_UNAVAILABLE", true);
    }
    return decide(snapshot, scope.workspaceId);
  };

  const decideIntakeFor = (scope: WorkspaceScope): Promise<RolloutDecision> =>
    evaluate(scope, decideIntake);
  const decideExecutionFor = (scope: WorkspaceScope): Promise<RolloutDecision> =>
    evaluate(scope, decideExecution);

  return Object.freeze({
    decideIntake: decideIntakeFor,
    decideExecution: decideExecutionFor,
    allowsIntake: async (scope: WorkspaceScope): Promise<boolean> =>
      (await decideIntakeFor(scope)).kind === "allow",
    claimGateFor: (scope: WorkspaceScope) => async (): Promise<boolean> =>
      (await decideExecutionFor(scope)).kind === "allow"
  });
};