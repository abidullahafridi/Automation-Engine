import type { PolicyPort, Principal, WorkspaceScope } from "./automation.ports.js";
import type { Clock, Rng } from "./automation.service.js";
import type {
  ReleaseActor,
  ReleaseAuditDetails,
  ReleaseAuditPort,
  ReleaseChange
} from "./release.audit.js";
import {
  killSwitchModes,
  normalizeFlagState,
  releaseFlagNames,
  type KillSwitchMode,
  type KillSwitchState,
  type ReleaseFlagName,
  type ReleaseSnapshot,
  type RolloutMode
} from "./release.flags.js";
import type { ReleaseControlStore } from "./release.store.js";

/** [VERIFY] These names must exist in the platform policy engine. */
export const releasePermissions = Object.freeze({
  flagWrite: "automation.release.flag.write",
  killSwitchEngage: "automation.release.killswitch.engage",
  killSwitchRelease: "automation.release.killswitch.release"
});

export type ReleaseInvalidCode =
  | "RELEASE_SCOPE_MISSING"
  | "RELEASE_INVALID_PRINCIPAL"
  | "RELEASE_INVALID_REVISION"
  | "RELEASE_REASON_REQUIRED"
  | "RELEASE_UNKNOWN_FLAG"
  | "RELEASE_INVALID_ROLLOUT"
  | "RELEASE_INVALID_KILL_SWITCH_MODE"
  | "RELEASE_REVIEW_REQUIRED";

export type ReleaseControlResult =
  | Readonly<{
      kind: "applied";
      snapshot: ReleaseSnapshot;
      /** false when the audit record could not be written. The change itself is still applied. */
      audited: boolean;
    }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "invalid"; code: ReleaseInvalidCode }>
  | Readonly<{ kind: "already-engaged" }>
  | Readonly<{ kind: "not-engaged" }>
  | Readonly<{ kind: "unavailable" }>;

export type SetRolloutRequest = Readonly<{
  flag: ReleaseFlagName;
  mode: RolloutMode;
  /** Required (1 to 100) for shadow and cohort. Ignored for off and all. */
  workspaceIds: readonly string[];
  expectedRevision: number;
  /** 1 to 200 characters. Never put secrets in it. */
  reason: string;
}>;

export type EngageKillSwitchRequest = Readonly<{
  mode: KillSwitchMode;
  expectedRevision: number;
  reason: string;
}>;

export type ReleaseKillSwitchRequest = Readonly<{
  expectedRevision: number;
  reason: string;
  /** Operator confirms the cause was reviewed. Resuming is never automatic. */
  reviewConfirmed: boolean;
}>;

export type ReleaseControlService = Readonly<{
  setRollout: (scope: WorkspaceScope, principal: Principal, request: SetRolloutRequest) => Promise<ReleaseControlResult>;
  engageKillSwitch: (scope: WorkspaceScope, principal: Principal, request: EngageKillSwitchRequest) => Promise<ReleaseControlResult>;
  releaseKillSwitch: (scope: WorkspaceScope, principal: Principal, request: ReleaseKillSwitchRequest) => Promise<ReleaseControlResult>;
}>;

const maxReasonLength = 200;

const cleanReason = (value: string): string | undefined => {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return cleaned.length >= 1 && cleaned.length <= maxReasonLength ? cleaned : undefined;
};

type Parts = Readonly<{ flags: ReleaseSnapshot["flags"]; killSwitch: KillSwitchState }>;

type Plan =
  | Readonly<{ ok: true; parts: Parts; details: ReleaseAuditDetails }>
  | Readonly<{ ok: false; result: ReleaseControlResult }>;

const invalid = (code: ReleaseInvalidCode): ReleaseControlResult => Object.freeze({ kind: "invalid", code });
const fail = (result: ReleaseControlResult): Plan => Object.freeze({ ok: false, result });
const failInvalid = (code: ReleaseInvalidCode): Plan => fail(invalid(code));

const toActor = (principal: Principal): ReleaseActor | undefined =>
  principal.type === "user" || principal.type === "system"
    ? Object.freeze({ type: principal.type, id: principal.id })
    : undefined;

export const createReleaseControlService = ({
  ownsScope,
  store,
  policy,
  audit,
  clock,
  rng
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  store: ReleaseControlStore;
  policy: PolicyPort;
  audit: ReleaseAuditPort;
  clock: Clock;
  rng: Rng;
}>): ReleaseControlService => {
  const record = async (event: Parameters<ReleaseAuditPort["append"]>[0]): Promise<boolean> => {
    try {
      await audit.append(event);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Order: trusted scope, principal type, permission, then revision and validation.
   * Authorization comes first so a caller without permission learns nothing.
   * The change is applied before it is audited so an emergency stop can never be blocked by audit storage.
   */
  const execute = async (
    scope: WorkspaceScope,
    principal: Principal,
    spec: Readonly<{
      permission: string;
      change: ReleaseChange;
      target: string;
      expectedRevision: number;
      plan: (snapshot: ReleaseSnapshot, now: string, actor: ReleaseActor) => Plan;
    }>
  ): Promise<ReleaseControlResult> => {
    if (!ownsScope(scope)) return invalid("RELEASE_SCOPE_MISSING");
    const actor = toActor(principal);
    if (actor === undefined) return invalid("RELEASE_INVALID_PRINCIPAL");

    const occurredAt = clock.now();
    const correlationId = rng.nextId();

    let allowed: boolean;
    try {
      allowed = await policy.authorize(
        principal,
        spec.permission,
        { type: "workspace", id: scope.workspaceId }
      );
    } catch {
      return Object.freeze({ kind: "unavailable" });
    }
    if (!allowed) {
      await record({
        actor,
        change: spec.change,
        target: spec.target,
        outcome: "denied",
        occurredAt,
        correlationId,
        details: Object.freeze({})
      });
      return Object.freeze({ kind: "denied" });
    }

    if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 0) {
      return invalid("RELEASE_INVALID_REVISION");
    }
    let snapshot: ReleaseSnapshot;
    try {
      snapshot = await store.read();
    } catch {
      return Object.freeze({ kind: "unavailable" });
    }
    if (snapshot.revision !== spec.expectedRevision) return Object.freeze({ kind: "conflict" });

    const plan = spec.plan(snapshot, occurredAt, actor);
    if (!plan.ok) return plan.result;

    const next: ReleaseSnapshot = Object.freeze({
      revision: snapshot.revision + 1,
      updatedAt: occurredAt,
      flags: plan.parts.flags,
      killSwitch: plan.parts.killSwitch
    });
    let stored: "updated" | "conflict";
    try {
      stored = await store.compareAndSet(snapshot.revision, next);
    } catch {
      return Object.freeze({ kind: "unavailable" });
    }
    if (stored === "conflict") return Object.freeze({ kind: "conflict" });

    const audited = await record({
      actor,
      change: spec.change,
      target: spec.target,
      outcome: "succeeded",
      occurredAt,
      correlationId,
      details: Object.freeze({ ...plan.details, revision: next.revision })
    });
    return Object.freeze({ kind: "applied", snapshot: next, audited });
  };

  return Object.freeze({
    setRollout: (scope, principal, request) => execute(scope, principal, {
      permission: releasePermissions.flagWrite,
      change: "rollout",
      target: releaseFlagNames.includes(request.flag) ? request.flag : "unknown",
      expectedRevision: request.expectedRevision,
      plan: (snapshot): Plan => {
        const reason = cleanReason(request.reason);
        if (reason === undefined) return failInvalid("RELEASE_REASON_REQUIRED");
        if (!releaseFlagNames.includes(request.flag)) return failInvalid("RELEASE_UNKNOWN_FLAG");
        const state = normalizeFlagState(request.mode, request.workspaceIds);
        if (state === undefined) return failInvalid("RELEASE_INVALID_ROLLOUT");
        const flags: ReleaseSnapshot["flags"] = request.flag === "ingest"
          ? Object.freeze({ ingest: state, execute: snapshot.flags.execute })
          : Object.freeze({ ingest: snapshot.flags.ingest, execute: state });
        return Object.freeze({
          ok: true,
          parts: Object.freeze({ flags, killSwitch: snapshot.killSwitch }),
          details: Object.freeze({
            flag: request.flag,
            fromMode: snapshot.flags[request.flag].mode,
            toMode: state.mode,
            cohortSize: state.workspaceIds.length,
            reason
          })
        });
      }
    }),

    engageKillSwitch: (scope, principal, request) => execute(scope, principal, {
      permission: releasePermissions.killSwitchEngage,
      change: "killswitch.engage",
      target: "killswitch",
      expectedRevision: request.expectedRevision,
      plan: (snapshot, now, actor): Plan => {
        const reason = cleanReason(request.reason);
        if (reason === undefined) return failInvalid("RELEASE_REASON_REQUIRED");
        if (!killSwitchModes.includes(request.mode)) return failInvalid("RELEASE_INVALID_KILL_SWITCH_MODE");
        if (snapshot.killSwitch.engaged) return fail(Object.freeze({ kind: "already-engaged" }));
        return Object.freeze({
          ok: true,
          parts: Object.freeze({
            flags: snapshot.flags,
            killSwitch: Object.freeze({
              engaged: true as const,
              mode: request.mode,
              engagedBy: actor.id,
              engagedAt: now,
              reason
            })
          }),
          details: Object.freeze({ mode: request.mode, reason })
        });
      }
    }),

    releaseKillSwitch: (scope, principal, request) => execute(scope, principal, {
      permission: releasePermissions.killSwitchRelease,
      change: "killswitch.release",
      target: "killswitch",
      expectedRevision: request.expectedRevision,
      plan: (snapshot): Plan => {
        const reason = cleanReason(request.reason);
        if (reason === undefined) return failInvalid("RELEASE_REASON_REQUIRED");
        if (!snapshot.killSwitch.engaged) return fail(Object.freeze({ kind: "not-engaged" }));
        // Resuming needs an explicit review confirmation. Flags are NOT changed: nothing auto-resumes.
        if (!request.reviewConfirmed) return failInvalid("RELEASE_REVIEW_REQUIRED");
        return Object.freeze({
          ok: true,
          parts: Object.freeze({
            flags: snapshot.flags,
            killSwitch: Object.freeze({ engaged: false as const })
          }),
          details: Object.freeze({
            previousMode: snapshot.killSwitch.mode,
            reviewConfirmed: true,
            reason
          })
        });
      }
    })
  });
};