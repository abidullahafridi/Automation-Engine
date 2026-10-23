/**
 * Release flags, rollout cohorts and kill-switch decisions (AE-T-071.1).
 *
 * Pure: no I/O, no clock. Everything fails closed. Spec 16.4 and Part B section 26.
 * All defaults are OFF. The kill switch always wins over a flag.
 */

export const releaseFlagNames = Object.freeze(["ingest", "execute"] as const);
export type ReleaseFlagName = (typeof releaseFlagNames)[number];

/** shadow = match and plan without effects. cohort = real effects for listed workspaces only. */
export type RolloutMode = "off" | "shadow" | "cohort" | "all";
export const rolloutModes: readonly RolloutMode[] = Object.freeze(["off", "shadow", "cohort", "all"]);

export type FlagState = Readonly<{
  mode: RolloutMode;
  /** Used only by shadow and cohort. Always empty for off and all. */
  workspaceIds: readonly string[];
}>;

/**
 * pause-execution: workers stop claiming new runs; events are still accepted and stored.
 * pause-intake: also stops matching new events into runs. Nothing is deleted in either mode.
 */
export type KillSwitchMode = "pause-execution" | "pause-intake";
export const killSwitchModes: readonly KillSwitchMode[] = Object.freeze(["pause-execution", "pause-intake"]);

export type KillSwitchState =
  | Readonly<{ engaged: false }>
  | Readonly<{
      engaged: true;
      mode: KillSwitchMode;
      engagedBy: string;
      engagedAt: string;
      reason: string;
    }>;

export type ReleaseSnapshot = Readonly<{
  /** Optimistic-concurrency revision of the whole release configuration. */
  revision: number;
  updatedAt: string;
  flags: Readonly<Record<ReleaseFlagName, FlagState>>;
  killSwitch: KillSwitchState;
}>;

export type FlagDefinition = Readonly<{
  name: ReleaseFlagName;
  owner: string;
  purpose: string;
  defaultMode: "off";
  /** Spec 26.3: every flag has a review/expiry date. PROVISIONAL until the owner confirms. */
  reviewBy: string;
}>;

export const flagDefinitions: Readonly<Record<ReleaseFlagName, FlagDefinition>> = Object.freeze({
  ingest: Object.freeze({
    name: "ingest" as const,
    owner: "Abid Ullah",
    purpose: "Gates matching of accepted domain events into runs (ADR-0003 production gate).",
    defaultMode: "off" as const,
    reviewBy: "2027-01-31T00:00:00.000Z"
  }),
  execute: Object.freeze({
    name: "execute" as const,
    owner: "Abid Ullah",
    purpose: "Gates claiming and executing runs.",
    defaultMode: "off" as const,
    reviewBy: "2027-01-31T00:00:00.000Z"
  })
});

export const maxCohortSize = 100;
const maxIdLength = 200;

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/** Non-empty, bounded, no whitespace and no control characters. */
export const isSafeWorkspaceId = (value: string): boolean => {
  if (value.length === 0 || value.length > maxIdLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }
  return true;
};

/** Returns undefined for an invalid mode or cohort, so callers reject instead of guessing. */
export const normalizeFlagState = (
  mode: RolloutMode,
  workspaceIds: readonly string[]
): FlagState | undefined => {
  if (!rolloutModes.includes(mode)) return undefined;
  if (mode === "off" || mode === "all") {
    return Object.freeze({ mode, workspaceIds: Object.freeze([]) });
  }
  const unique = [...new Set(workspaceIds)];
  if (unique.length === 0 || unique.length > maxCohortSize || !unique.every(isSafeWorkspaceId)) {
    return undefined;
  }
  return Object.freeze({ mode, workspaceIds: Object.freeze(unique.sort(compareText)) });
};

const offState: FlagState = Object.freeze({ mode: "off" as const, workspaceIds: Object.freeze([]) });

export const createDefaultReleaseSnapshot = (now: string): ReleaseSnapshot => Object.freeze({
  revision: 0,
  updatedAt: now,
  flags: Object.freeze({ ingest: offState, execute: offState }),
  killSwitch: Object.freeze({ engaged: false as const })
});

export type RolloutDenyCode =
  | "SCOPE_MISSING"
  | "KILL_SWITCH"
  | "FLAG_OFF"
  | "NOT_IN_COHORT"
  | "FLAGS_UNAVAILABLE";

export type RolloutDecision =
  | Readonly<{ kind: "allow" }>
  | Readonly<{ kind: "shadow" }>
  | Readonly<{
      kind: "deny";
      code: RolloutDenyCode;
      /** True only when waiting can help (kill switch released, flags readable again). */
      retryable: boolean;
    }>;

const allow: RolloutDecision = Object.freeze({ kind: "allow" });
const shadow: RolloutDecision = Object.freeze({ kind: "shadow" });

export const deny = (code: RolloutDenyCode, retryable: boolean): RolloutDecision =>
  Object.freeze({ kind: "deny", code, retryable });

const decideFlag = (state: FlagState, workspaceId: string): RolloutDecision => {
  switch (state.mode) {
    case "off":
      return deny("FLAG_OFF", false);
    case "all":
      return allow;
    case "cohort":
      return state.workspaceIds.includes(workspaceId) ? allow : deny("NOT_IN_COHORT", false);
    case "shadow":
      return state.workspaceIds.includes(workspaceId) ? shadow : deny("NOT_IN_COHORT", false);
  }
};

/** Intake stops only for pause-intake. Under pause-execution events are still accepted. */
export const decideIntake = (snapshot: ReleaseSnapshot, workspaceId: string): RolloutDecision => {
  if (snapshot.killSwitch.engaged && snapshot.killSwitch.mode === "pause-intake") {
    return deny("KILL_SWITCH", true);
  }
  return decideFlag(snapshot.flags.ingest, workspaceId);
};

/** Any engaged kill switch stops new claims. */
export const decideExecution = (snapshot: ReleaseSnapshot, workspaceId: string): RolloutDecision => {
  if (snapshot.killSwitch.engaged) return deny("KILL_SWITCH", true);
  return decideFlag(snapshot.flags.execute, workspaceId);
};

/** Names of flags whose review date has passed (spec 26.3 stale-flag report). */
export const findExpiredFlagDefinitions = (now: string): readonly ReleaseFlagName[] => {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return Object.freeze([...releaseFlagNames]);
  return Object.freeze(releaseFlagNames.filter((name) => {
    const reviewMs = Date.parse(flagDefinitions[name].reviewBy);
    return !Number.isFinite(reviewMs) || reviewMs <= nowMs;
  }));
};

/**
 * Documented policy for work that is already running when the kill switch is engaged (TC-0712):
 * the current run finishes; no new run is claimed. Completed external effects are never rolled back.
 */
export const inFlightPolicy = "finish-current-run" as const;