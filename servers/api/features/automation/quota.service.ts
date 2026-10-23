import type { WorkspaceScope } from "./automation.ports.js";

export type QuotaKind = "events" | "runs";

export type QuotaLimits = Readonly<{
  /** Fixed window length. */
  windowMs: number;
  /** Per-workspace limit inside one window. */
  workspaceLimit: number;
  /** Platform-wide limit inside one window; also the hard cap for admin overrides. */
  globalLimit: number;
}>;

export type QuotaConfig = Readonly<Record<QuotaKind, QuotaLimits>>;

/** PROVISIONAL starter values. Not plan entitlements. Tune from the AE-E06 load test. */
export const quotaDefaults: QuotaConfig = Object.freeze({
  events: Object.freeze({ windowMs: 60_000, workspaceLimit: 600, globalLimit: 6_000 }),
  runs: Object.freeze({ windowMs: 60_000, workspaceLimit: 300, globalLimit: 3_000 })
});

/** Spec D-28: alert admins at 80% of the workspace limit. */
export const quotaWarningRatio = 0.8;

const quotaKinds = ["events", "runs"] as const satisfies readonly QuotaKind[];

export type QuotaCounterKey = Readonly<{
  /** Bounded label, e.g. "runs:workspace". */
  name: string;
  windowStart: string;
  windowEnd: string;
}>;

export type QuotaCounterResult = Readonly<{ allowed: boolean; used: number }>;

/** Counters must be atomic. A denied consume must NOT change the counter. */
export type QuotaCounterPort = Readonly<{
  consume: (scope: WorkspaceScope, counter: QuotaCounterKey, limit: number) => Promise<QuotaCounterResult>;
  consumeGlobal: (counter: QuotaCounterKey, limit: number) => Promise<QuotaCounterResult>;
  /** Gives back one unit of a workspace counter (used when the global check denies afterwards). */
  refund: (scope: WorkspaceScope, counter: QuotaCounterKey) => Promise<void>;
}>;

/**
 * Admin override of the per-workspace limit. Setting overrides needs its own permission and audit
 * (not part of this task); this port only reads the stored value.
 */
export type QuotaOverridePort = Readonly<{
  workspaceLimit: (scope: WorkspaceScope, kind: QuotaKind) => Promise<number | undefined>;
}>;

export type QuotaDenialCode =
  | "SCOPE_MISSING"
  | "WORKSPACE_QUOTA_EXCEEDED"
  | "GLOBAL_QUOTA_EXCEEDED"
  | "QUOTA_UNAVAILABLE";

export type QuotaDecision =
  | Readonly<{ kind: "allow"; used: number; limit: number; overrideApplied: boolean }>
  | Readonly<{
      kind: "deny";
      code: QuotaDenialCode;
      /** Backpressure hint: milliseconds until the current window resets. */
      retryAfterMs: number;
      /** True for quota exhaustion and infrastructure faults. */
      retryable: boolean;
      /** Static, safe text. */
      message: string;
    }>;

export type QuotaRejectionSignal = Readonly<{
  code: QuotaDenialCode;
  kind: QuotaKind;
  workspaceId: string;
  retryAfterMs: number;
}>;

export type QuotaNearLimitSignal = Readonly<{
  kind: QuotaKind;
  workspaceId: string;
  used: number;
  limit: number;
}>;

/** Map `code` to the bounded metric label automation_quota_rejections_total{quota}. */
export type QuotaTelemetry = Readonly<{
  rejected: (signal: QuotaRejectionSignal) => void;
  nearLimit: (signal: QuotaNearLimitSignal) => void;
}>;

export type QuotaClock = Readonly<{ now: () => string }>;

export type QuotaService = Readonly<{
  admit: (scope: WorkspaceScope, kind: QuotaKind) => Promise<QuotaDecision>;
}>;

const denialMessages: Readonly<Record<QuotaDenialCode, string>> = {
  SCOPE_MISSING: "Trusted workspace scope is required; no work was admitted.",
  WORKSPACE_QUOTA_EXCEEDED: "Workspace automation quota is exhausted; retry after the window resets.",
  GLOBAL_QUOTA_EXCEEDED: "Platform automation capacity is saturated; retry after the window resets.",
  QUOTA_UNAVAILABLE: "Quota could not be evaluated; the work is deferred."
};

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

const emit = (action: () => void): void => {
  try {
    action();
  } catch {
    // Telemetry must never change an admission decision.
  }
};

export const createQuotaService = ({
  ownsScope,
  counters,
  clock,
  telemetry,
  overrides,
  config = quotaDefaults
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  counters: QuotaCounterPort;
  clock: QuotaClock;
  telemetry: QuotaTelemetry;
  overrides?: QuotaOverridePort;
  config?: QuotaConfig;
}>): QuotaService => {
  for (const kind of quotaKinds) {
    const limits = config[kind];
    if (
      !isPositiveInteger(limits.windowMs) ||
      !isPositiveInteger(limits.workspaceLimit) ||
      !isPositiveInteger(limits.globalLimit) ||
      limits.workspaceLimit > limits.globalLimit
    ) {
      throw new Error(`Quota limits for ${kind} must be positive integers with workspaceLimit <= globalLimit.`);
    }
  }

  const deny = (code: QuotaDenialCode, retryAfterMs: number): QuotaDecision => Object.freeze({
    kind: "deny",
    code,
    retryAfterMs,
    retryable: code !== "SCOPE_MISSING",
    message: denialMessages[code]
  });

  return Object.freeze({
    admit: async (scope: WorkspaceScope, kind: QuotaKind): Promise<QuotaDecision> => {
      // 1. Trusted scope first. Nothing else runs without it.
      if (!ownsScope(scope)) return deny("SCOPE_MISSING", 0);

      const limits = config[kind];
      const nowMs = Date.parse(clock.now());
      if (!Number.isFinite(nowMs)) return deny("QUOTA_UNAVAILABLE", limits.windowMs);

      const startMs = Math.floor(nowMs / limits.windowMs) * limits.windowMs;
      const endMs = startMs + limits.windowMs;
      const retryAfterMs = Math.max(1, endMs - nowMs);
      const windowStart = new Date(startMs).toISOString();
      const windowEnd = new Date(endMs).toISOString();
      const workspaceKey: QuotaCounterKey = Object.freeze({ name: `${kind}:workspace`, windowStart, windowEnd });
      const globalKey: QuotaCounterKey = Object.freeze({ name: `${kind}:global`, windowStart, windowEnd });
      const workspaceId = scope.workspaceId;

      const reject = (code: QuotaDenialCode): QuotaDecision => {
        emit(() => { telemetry.rejected(Object.freeze({ code, kind, workspaceId, retryAfterMs })); });
        return deny(code, retryAfterMs);
      };

      // 2. Admin override: only an integer between 1 and the global cap is honoured.
      let workspaceLimit = limits.workspaceLimit;
      let overrideApplied = false;
      if (overrides !== undefined) {
        try {
          const override = await overrides.workspaceLimit(scope, kind);
          if (override !== undefined && isPositiveInteger(override) && override <= limits.globalLimit) {
            workspaceLimit = override;
            overrideApplied = true;
          }
        } catch {
          // The configured limit applies when the override cannot be read.
        }
      }

      const refundWorkspace = async (): Promise<void> => {
        try {
          await counters.refund(scope, workspaceKey);
        } catch {
          // A failed refund only makes the counter conservative for the rest of the window.
        }
      };

      // 3. Workspace quota (a noisy workspace stops here and never touches the global counter).
      let own: QuotaCounterResult;
      try {
        own = await counters.consume(scope, workspaceKey, workspaceLimit);
      } catch {
        return reject("QUOTA_UNAVAILABLE");
      }
      if (!own.allowed) return reject("WORKSPACE_QUOTA_EXCEEDED");

      // 4. Global capacity. On denial the workspace unit is given back.
      let shared: QuotaCounterResult;
      try {
        shared = await counters.consumeGlobal(globalKey, limits.globalLimit);
      } catch {
        await refundWorkspace();
        return reject("QUOTA_UNAVAILABLE");
      }
      if (!shared.allowed) {
        await refundWorkspace();
        return reject("GLOBAL_QUOTA_EXCEEDED");
      }

      // 5. One-time warning per window at the 80% mark.
      if (own.used === Math.ceil(workspaceLimit * quotaWarningRatio)) {
        emit(() => {
          telemetry.nearLimit(Object.freeze({ kind, workspaceId, used: own.used, limit: workspaceLimit }));
        });
      }

      return Object.freeze({ kind: "allow", used: own.used, limit: workspaceLimit, overrideApplied });
    }
  });
};

export type InMemoryQuotaCounters = Readonly<{
  counters: QuotaCounterPort;
  /** Sum across windows for one workspace counter name, e.g. "runs:workspace". */
  used: (workspaceId: string, name: string) => number;
  usedGlobal: (name: string) => number;
}>;

export const createInMemoryQuotaCounters = (
  ownsScope: (scope: unknown) => scope is WorkspaceScope
): InMemoryQuotaCounters => {
  const workspaceCounters = new Map<string, number>();
  const globalCounters = new Map<string, number>();
  const separator = "\u0000";

  const take = (store: Map<string, number>, key: string, limit: number): QuotaCounterResult => {
    const used = store.get(key) ?? 0;
    if (used >= limit) return Object.freeze({ allowed: false, used });
    store.set(key, used + 1);
    return Object.freeze({ allowed: true, used: used + 1 });
  };

  const workspaceKeyOf = (workspaceId: string, counter: QuotaCounterKey): string =>
    [workspaceId, counter.name, counter.windowStart].join(separator);

  const counters: QuotaCounterPort = Object.freeze({
    consume: async (scope: WorkspaceScope, counter: QuotaCounterKey, limit: number): Promise<QuotaCounterResult> => {
      await Promise.resolve();
      if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
      return take(workspaceCounters, workspaceKeyOf(scope.workspaceId, counter), limit);
    },
    consumeGlobal: async (counter: QuotaCounterKey, limit: number): Promise<QuotaCounterResult> => {
      await Promise.resolve();
      return take(globalCounters, [counter.name, counter.windowStart].join(separator), limit);
    },
    refund: async (scope: WorkspaceScope, counter: QuotaCounterKey): Promise<void> => {
      await Promise.resolve();
      if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");
      const key = workspaceKeyOf(scope.workspaceId, counter);
      const used = workspaceCounters.get(key) ?? 0;
      if (used > 0) workspaceCounters.set(key, used - 1);
    }
  });

  return Object.freeze({
    counters,
    used: (workspaceId: string, name: string): number => {
      const prefix = [workspaceId, name, ""].join(separator);
      let total = 0;
      for (const [key, value] of workspaceCounters) if (key.startsWith(prefix)) total += value;
      return total;
    },
    usedGlobal: (name: string): number => {
      const prefix = [name, ""].join(separator);
      let total = 0;
      for (const [key, value] of globalCounters) if (key.startsWith(prefix)) total += value;
      return total;
    }
  });
};

export type InMemoryQuotaTelemetry = Readonly<{
  telemetry: QuotaTelemetry;
  rejections: () => readonly QuotaRejectionSignal[];
  nearLimits: () => readonly QuotaNearLimitSignal[];
  /** Bounded-cardinality view: counts per denial code only. */
  countsByCode: () => Readonly<Record<string, number>>;
}>;

export const createInMemoryQuotaTelemetry = (): InMemoryQuotaTelemetry => {
  const rejected: QuotaRejectionSignal[] = [];
  const near: QuotaNearLimitSignal[] = [];
  const telemetry: QuotaTelemetry = Object.freeze({
    rejected: (signal: QuotaRejectionSignal): void => { rejected.push(signal); },
    nearLimit: (signal: QuotaNearLimitSignal): void => { near.push(signal); }
  });
  return Object.freeze({
    telemetry,
    rejections: (): readonly QuotaRejectionSignal[] => Object.freeze([...rejected]),
    nearLimits: (): readonly QuotaNearLimitSignal[] => Object.freeze([...near]),
    countsByCode: (): Readonly<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const signal of rejected) counts[signal.code] = (counts[signal.code] ?? 0) + 1;
      return Object.freeze(counts);
    }
  });
};