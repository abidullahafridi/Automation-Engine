import type { WorkspaceScope } from "./automation.ports.js";

export type LoopGuardLimits = Readonly<{
  /** Maximum automation-to-automation hops allowed in one chain. */
  maxHops: number;
  /** Maximum runs created for one chain (execution budget). Provisional until load-tested. */
  maxRunsPerChain: number;
}>;

export const loopGuardDefaults: LoopGuardLimits = Object.freeze({ maxHops: 5, maxRunsPerChain: 25 });

/** Lineage carried by an automation-generated event (spec section 10.1). */
export type EventOrigin = Readonly<{ automationId: string; runId: string; hop: number }>;

export type LoopGuardInput = Readonly<{
  workspaceId: string;
  /** Automation that is about to get a run. */
  automationId: string;
  eventId: string;
  /** Stable id of the whole chain, e.g. the root event's correlationId. */
  chainKey: string;
  /** Undefined for events caused by a user or the system. */
  origin: EventOrigin | undefined;
}>;

export type LoopBlockCode =
  | "SCOPE_MISSING"
  | "LINEAGE_INVALID"
  | "SELF_TRIGGER"
  | "HOP_LIMIT_EXCEEDED"
  | "CHAIN_BUDGET_EXCEEDED"
  | "BUDGET_UNAVAILABLE";

export type LoopDecision =
  | Readonly<{ kind: "allow"; hop: number }>
  | Readonly<{
      kind: "block";
      code: LoopBlockCode;
      hop: number;
      /** Static, safe, actionable text. Never contains submitted values. */
      message: string;
      /** True only for infrastructure faults. */
      retryable: boolean;
    }>;

export type LoopSignal = Readonly<{
  code: LoopBlockCode;
  workspaceId: string;
  automationId: string;
  eventId: string;
  hop: number;
  message: string;
}>;

/** Operator signal. Map `code` to the bounded metric label automation_loop_guard_trips_total{reason}. */
export type LoopGuardTelemetry = Readonly<{
  tripped: (signal: LoopSignal) => void;
}>;

export type ChainBudgetResult = Readonly<{ allowed: boolean; used: number }>;

/** Must be atomic: concurrent callers can never exceed `limit`. Denied calls must not consume budget. */
export type ChainBudgetPort = Readonly<{
  consume: (scope: WorkspaceScope, chainKey: string, limit: number) => Promise<ChainBudgetResult>;
}>;

const blockMessages: Readonly<Record<LoopBlockCode, string>> = {
  SCOPE_MISSING: "Trusted workspace scope is required; no run was created.",
  LINEAGE_INVALID: "Event lineage is invalid; no run was created.",
  SELF_TRIGGER: "Automation was triggered by its own output; disable the self-triggering action or trigger.",
  HOP_LIMIT_EXCEEDED: "Automation chain exceeded the maximum hop count; review chained automations for a cycle.",
  CHAIN_BUDGET_EXCEEDED: "Automation chain exceeded its run budget; review fan-out in chained automations.",
  BUDGET_UNAVAILABLE: "Chain budget could not be evaluated; the run will be retried."
};

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const isValidOrigin = (origin: EventOrigin): boolean =>
  origin.automationId.length > 0 &&
  origin.runId.length > 0 &&
  Number.isSafeInteger(origin.hop) &&
  origin.hop >= 1;

export type LoopGuard = Readonly<{
  evaluate: (scope: WorkspaceScope, input: LoopGuardInput) => Promise<LoopDecision>;
}>;

export const createLoopGuard = ({
  ownsScope,
  budget,
  telemetry,
  limits = loopGuardDefaults
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  budget: ChainBudgetPort;
  telemetry: LoopGuardTelemetry;
  limits?: LoopGuardLimits;
}>): LoopGuard => {
  if (!isPositiveInteger(limits.maxHops) || !isPositiveInteger(limits.maxRunsPerChain)) {
    throw new Error("Loop guard limits must be positive safe integers.");
  }

  const block = (input: LoopGuardInput, code: LoopBlockCode, hop: number): LoopDecision => {
    const message = blockMessages[code];
    try {
      telemetry.tripped(Object.freeze({
        code,
        workspaceId: input.workspaceId,
        automationId: input.automationId,
        eventId: input.eventId,
        hop,
        message
      }));
    } catch {
      // A telemetry failure must never turn a block into an allow.
    }
    return Object.freeze({ kind: "block", code, hop, message, retryable: code === "BUDGET_UNAVAILABLE" });
  };

  return Object.freeze({
    evaluate: async (scope, input): Promise<LoopDecision> => {
      // 1. Trusted scope first. Nothing else runs without it.
      if (!ownsScope(scope) || input.workspaceId !== scope.workspaceId) {
        return block(input, "SCOPE_MISSING", 0);
      }

      // 2. Lineage must be well formed.
      if (input.automationId.length === 0 || input.chainKey.length === 0) {
        return block(input, "LINEAGE_INVALID", 0);
      }
      const origin = input.origin;
      if (origin !== undefined && !isValidOrigin(origin)) return block(input, "LINEAGE_INVALID", 0);
      const hop = origin === undefined ? 0 : origin.hop;

      // 3. Direct self-trigger is stopped even while the hop budget remains.
      if (origin !== undefined && origin.automationId === input.automationId) {
        return block(input, "SELF_TRIGGER", hop);
      }

      // 4. Hard hop cap.
      if (hop > limits.maxHops) return block(input, "HOP_LIMIT_EXCEEDED", hop);

      // 5. Per-chain execution budget (consumed last so blocked runs spend nothing).
      let result: ChainBudgetResult;
      try {
        result = await budget.consume(scope, input.chainKey, limits.maxRunsPerChain);
      } catch {
        return block(input, "BUDGET_UNAVAILABLE", hop);
      }
      if (!result.allowed) return block(input, "CHAIN_BUDGET_EXCEEDED", hop);

      return Object.freeze({ kind: "allow", hop });
    }
  });
};

export type InMemoryChainBudget = Readonly<{
  budget: ChainBudgetPort;
  used: (workspaceId: string, chainKey: string) => number;
}>;

export const createInMemoryChainBudget = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryChainBudget => {
  const counters = new Map<string, number>();
  const keyOf = (workspaceId: string, chainKey: string): string => `${workspaceId}\u0000${chainKey}`;

  const budget: ChainBudgetPort = Object.freeze({
    consume: async (
      scope: WorkspaceScope,
      chainKey: string,
      limit: number
    ): Promise<ChainBudgetResult> => {
      await Promise.resolve();
      if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
      const key = keyOf(scope.workspaceId, chainKey);
      const used = counters.get(key) ?? 0;
      if (used >= limit) return Object.freeze({ allowed: false, used });
      counters.set(key, used + 1);
      return Object.freeze({ allowed: true, used: used + 1 });
    }
  });

  return Object.freeze({
    budget,
    used: (workspaceId: string, chainKey: string): number => counters.get(keyOf(workspaceId, chainKey)) ?? 0
  });
};
export type InMemoryLoopTelemetry = Readonly<{
  telemetry: LoopGuardTelemetry;
  signals: () => readonly LoopSignal[];
  /** Bounded-cardinality view: counts per reason code only. */
  countsByCode: () => Readonly<Record<string, number>>;
}>;

export const createInMemoryLoopTelemetry = (): InMemoryLoopTelemetry => {
  const recorded: LoopSignal[] = [];
  return Object.freeze({
    telemetry: Object.freeze({ tripped: (signal: LoopSignal): void => { recorded.push(signal); } }),
    signals: () => Object.freeze([...recorded]),
    countsByCode: () => {
      const counts: Record<string, number> = {};
      for (const signal of recorded) counts[signal.code] = (counts[signal.code] ?? 0) + 1;
      return Object.freeze(counts);
    }
  });
};

/* ---------------- Authoring-time analysis (spec 11.7) ---------------- */

export type AutomationGraphNode = Readonly<{
  automationId: string;
  triggerType: string;
  /** Event types this automation's actions can emit. */
  emittedEventTypes: readonly string[];
  /** Trigger option allowAutomationOrigin. Without it, spec D-13 already prevents chaining. */
  allowsAutomationOrigin: boolean;
}>;

export type AuthoringLoopIssue = Readonly<{
  severity: "error" | "warning";
  code: "SELF_CYCLE" | "INDIRECT_CYCLE";
  automationIds: readonly string[];
}>;

export const maxGraphNodes = 1_000;

export const findAutomationCycles = (
  nodes: readonly AutomationGraphNode[]
): readonly (readonly string[])[] => {
  if (nodes.length > maxGraphNodes) throw new RangeError("Automation graph is too large to analyze.");

  const byId = new Map<string, AutomationGraphNode>();
  const byTrigger = new Map<string, string[]>();
  for (const node of nodes) {
    byId.set(node.automationId, node);
    if (!node.allowsAutomationOrigin) continue;
    const ids = byTrigger.get(node.triggerType) ?? [];
    ids.push(node.automationId);
    byTrigger.set(node.triggerType, ids);
  }

  const successors = (node: AutomationGraphNode): readonly string[] => {
    const ids = new Set<string>();
    for (const type of node.emittedEventTypes) {
      for (const id of byTrigger.get(type) ?? []) ids.add(id);
    }
    return [...ids];
  };

  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    const node = byId.get(id);
    if (!node) return;
    state.set(id, "visiting");
    path.push(id);
    for (const next of successors(node)) {
      const nextState = state.get(next);
      if (nextState === "visiting") cycles.push(path.slice(path.indexOf(next)));
      else if (nextState === undefined) visit(next);
    }
    path.pop();
    state.set(id, "done");
  };

  for (const node of nodes) {
    if (state.get(node.automationId) === undefined) visit(node.automationId);
  }
  return Object.freeze(cycles.map((cycle) => Object.freeze(cycle)));
};

export const analyzeAuthoringLoops = (
  nodes: readonly AutomationGraphNode[]
): readonly AuthoringLoopIssue[] =>
  Object.freeze(findAutomationCycles(nodes).map((cycle): AuthoringLoopIssue =>
    cycle.length === 1
      ? Object.freeze({ severity: "error", code: "SELF_CYCLE", automationIds: cycle })
      : Object.freeze({ severity: "warning", code: "INDIRECT_CYCLE", automationIds: cycle })));