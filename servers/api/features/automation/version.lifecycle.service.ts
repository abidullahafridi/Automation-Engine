import { createHash } from "node:crypto";
import { checkAutomationJsonBounds } from "./condition.validation.js";
import {
  validateRuleDraft,
  type RuleDocument,
  type RuleValidationIssue
} from "./rule.validation.js";
import { isIsoInstant } from "./condition.validation.js";

export type PublishedRuleVersion = Readonly<{
  automationId: string;
  version: number;
  schemaVersion: 1;
  contentHash: string;
  rule: RuleDocument;
}>;

export type AutomationLifecycleStatus = "draft" | "enabled" | "paused" | "disabled" | "archived";
export type LifecycleAuditAction = "enable" | "pause" | "resume" | "disable" | "archive";
export type LifecycleAuditOutcome = "succeeded" | "denied";

export type LifecycleAuditEvent = Readonly<{
  workspaceId: string;
  actor: Readonly<{ type: "user" | "system"; id: string }>;
  action: LifecycleAuditAction;
  target: Readonly<{ type: "automation"; id: string }>;
  occurredAt: string;
  outcome: LifecycleAuditOutcome;
  correlationId: string;
  change: Readonly<{
    status: Readonly<{ from: AutomationLifecycleStatus; to: AutomationLifecycleStatus }>;
    version: number | null;
  }>;
}>;

export type AutomationLifecycleState = Readonly<{
  automationId: string;
  revision: number;
  draft: unknown;
  hasDraft: boolean;
  versions: readonly PublishedRuleVersion[];
  activeVersion: number | null;
  status: AutomationLifecycleStatus;
  auditEvents: readonly LifecycleAuditEvent[];
}>;

export type AutomationRunVersionPin = Readonly<{
  automationId: string;
  version: number;
  contentHash: string;
}>;

export type LifecycleIssue = Readonly<{
  code:
    | RuleValidationIssue["code"]
    | "AUTOMATION_INVALID_REVISION"
    | "AUTOMATION_VERSION_NOT_FOUND"
    | "AUTOMATION_VERSION_HASH_MISMATCH";
  path: string;
  message: string;
}>;

export type LifecycleMutationResult =
  | Readonly<{ ok: true; state: AutomationLifecycleState }>
  | Readonly<{
      ok: false;
      kind: "conflict";
      code: "AUTOMATION_REVISION_CONFLICT";
      expectedRevision: number;
      actualRevision: number;
    }>
  | Readonly<{
      ok: false;
      kind: "denied";
      state: AutomationLifecycleState;
      auditEvent: LifecycleAuditEvent;
    }>
  | Readonly<{ ok: false; kind: "invalid"; issues: readonly LifecycleIssue[] }>;

export type PublishedVersionResult =
  | Readonly<{ ok: true; version: PublishedRuleVersion }>
  | Readonly<{ ok: false; issue: LifecycleIssue }>;

export type LifecycleAuditActor = Readonly<{ type: "user" | "system"; id: string }>;

type CanonicalJsonResult =
  | Readonly<{ success: true; json: string }>
  | Readonly<{ success: false; path: string; message: string }>;

const pointer = (path: string, segment: string | number): string =>
  `${path}/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const canonicalizeValue = (value: unknown, path: string): CanonicalJsonResult => {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return Object.freeze({ success: true, json: JSON.stringify(value) });
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? Object.freeze({ success: true, json: JSON.stringify(value) })
      : Object.freeze({ success: false, path, message: "Rule numbers must be finite." });
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        return Object.freeze({ success: false, path: pointer(path, index), message: "Rule arrays must not contain holes." });
      }
      const item = canonicalizeValue(value[index], pointer(path, index));
      if (!item.success) return item;
      items.push(item.json);
    }
    return Object.freeze({ success: true, json: `[${items.join(",")}]` });
  }
  if (typeof value !== "object" || !isPlainRecord(value)) {
    return Object.freeze({ success: false, path, message: "Rule must contain only plain JSON data." });
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    return Object.freeze({ success: false, path, message: "Rule objects must not contain symbol keys." });
  }

  const fields: string[] = [];
  const keys = Reflect.ownKeys(value);
  const stringKeys = keys.filter((key): key is string => typeof key === "string");
  if (stringKeys.length !== keys.length) {
    return Object.freeze({ success: false, path, message: "Rule objects must use string keys." });
  }
  for (const key of stringKeys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return Object.freeze({ success: false, path: pointer(path, key), message: "Rule properties must be enumerable data values." });
    }
    const field = canonicalizeValue(descriptor.value, pointer(path, key));
    if (!field.success) return field;
    fields.push(`${JSON.stringify(key)}:${field.json}`);
  }
  return Object.freeze({ success: true, json: `{${fields.join(",")}}` });
};

const canonicalJson = (input: unknown): CanonicalJsonResult => {
  const boundsIssue = checkAutomationJsonBounds(input);
  if (boundsIssue) {
    return Object.freeze({
      success: false,
      path: boundsIssue.path,
      message: boundsIssue.message
    });
  }
  return canonicalizeValue(input, "");
};

const invalidIssue = (
  path: string,
  message: string,
  code: LifecycleIssue["code"] = "AUTOMATION_INVALID_RULE"
): LifecycleIssue => Object.freeze({ code, path, message });

const lifecycleIssues = (issue: LifecycleIssue): readonly LifecycleIssue[] =>
  Object.freeze([issue]);

const snapshotJson = (input: unknown):
  | Readonly<{ success: true; value: unknown }>
  | Readonly<{ success: false; issue: LifecycleIssue }> => {
  const canonical = canonicalJson(input);
  if (!canonical.success) {
    const boundsIssue = checkAutomationJsonBounds(input);
    return Object.freeze({
      success: false,
      issue: invalidIssue(
        canonical.path,
        canonical.message,
        boundsIssue?.code === "AUTOMATION_LIMIT_EXCEEDED"
          ? "AUTOMATION_LIMIT_EXCEEDED"
          : "AUTOMATION_INVALID_RULE"
      )
    });
  }
  const copy: unknown = JSON.parse(canonical.json);
  return Object.freeze({ success: true, value: freezeDeep(copy) });
};

const freezeDeep = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

const compareRevision = (
  state: AutomationLifecycleState,
  expectedRevision: number
): LifecycleMutationResult | undefined => {
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || state.revision >= Number.MAX_SAFE_INTEGER) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(invalidIssue(
        "/revision",
        "Current revision is outside the supported safe-integer range.",
        "AUTOMATION_INVALID_REVISION"
      ))
    });
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(invalidIssue(
        "/expectedRevision",
        "Expected revision must be a non-negative safe integer.",
        "AUTOMATION_INVALID_REVISION"
      ))
    });
  }
  if (expectedRevision !== state.revision) {
    return Object.freeze({
      ok: false,
      kind: "conflict",
      code: "AUTOMATION_REVISION_CONFLICT",
      expectedRevision,
      actualRevision: state.revision
    });
  }
  return undefined;
};

// Hashing is accepted by ADR-0006; durable storage and cross-process enforcement remain adapter work.
export const hashRuleDocument = (
  input: unknown
):
  | Readonly<{ success: true; contentHash: string }>
  | Readonly<{ success: false; issue: LifecycleIssue }> => {
  const canonical = canonicalJson(input);
  if (!canonical.success) {
    const boundsIssue = checkAutomationJsonBounds(input);
    return Object.freeze({
      success: false,
      issue: invalidIssue(
        canonical.path,
        canonical.message,
        boundsIssue?.code === "AUTOMATION_LIMIT_EXCEEDED"
          ? "AUTOMATION_LIMIT_EXCEEDED"
          : "AUTOMATION_INVALID_RULE"
      )
    });
  }
  return Object.freeze({
    success: true,
    contentHash: createHash("sha256").update(canonical.json, "utf8").digest("hex")
  });
};

export const createAutomationLifecycle = (automationId: string): AutomationLifecycleState => {
  if (automationId.length === 0) throw new Error("Automation ID must not be empty.");
  return Object.freeze({
    automationId,
    revision: 0,
    draft: null,
    hasDraft: false,
    versions: Object.freeze([]),
    activeVersion: null,
    status: "draft",
    auditEvents: Object.freeze([])
  });
};

// This state helper is in-memory only; repository-backed publication uses the ADR-0006 CAS port.
export const saveAutomationDraft = (
  state: AutomationLifecycleState,
  expectedRevision: number,
  draft: unknown
): LifecycleMutationResult => {
  const revisionResult = compareRevision(state, expectedRevision);
  if (revisionResult) return revisionResult;
  const snapshot = snapshotJson(draft);
  if (!snapshot.success) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(snapshot.issue)
    });
  }
  return Object.freeze({
    ok: true,
    state: Object.freeze({
      ...state,
      revision: state.revision + 1,
      draft: snapshot.value,
      hasDraft: true
    })
  });
};

export type LifecycleTransitionInput = Readonly<{
  action: LifecycleAuditAction;
  expectedRevision: number;
  authorized: boolean;
  audit: Readonly<{
    workspaceId: string;
    actor: LifecycleAuditActor;
    occurredAt: string;
    correlationId: string;
  }>;
}>;

export const nextLifecycleStatus = (
  status: AutomationLifecycleStatus,
  action: LifecycleAuditAction,
  hasPublishedVersion: boolean
): AutomationLifecycleStatus | undefined => {
  if (action === "enable" && hasPublishedVersion && (status === "draft" || status === "disabled")) {
    return "enabled";
  }
  if (action === "pause" && status === "enabled") return "paused";
  if (action === "resume" && status === "paused" && hasPublishedVersion) return "enabled";
  if (action === "disable" && (status === "enabled" || status === "paused")) return "disabled";
  if (action === "archive" && status === "disabled") return "archived";
  return undefined;
};

const makeLifecycleAuditEvent = (
  state: AutomationLifecycleState,
  input: LifecycleTransitionInput,
  outcome: LifecycleAuditOutcome,
  nextStatus: AutomationLifecycleStatus
): LifecycleAuditEvent => Object.freeze({
  workspaceId: input.audit.workspaceId,
  actor: Object.freeze({ type: input.audit.actor.type, id: input.audit.actor.id }),
  action: input.action,
  target: Object.freeze({ type: "automation", id: state.automationId }),
  occurredAt: input.audit.occurredAt,
  outcome,
  correlationId: input.audit.correlationId,
  change: Object.freeze({
    status: Object.freeze({ from: state.status, to: nextStatus }),
    version: state.activeVersion
  })
});

// Authorization and scope provenance are supplied by a future boundary; this pure
// provisional service only records the caller's decision and never authorizes access.
export const transitionAutomationLifecycle = (
  state: AutomationLifecycleState,
  input: LifecycleTransitionInput
): LifecycleMutationResult => {
  const revisionResult = compareRevision(state, input.expectedRevision);
  if (revisionResult) return revisionResult;

  if (
    input.audit.workspaceId.length === 0 ||
    input.audit.actor.id.length === 0 ||
    input.audit.correlationId.length === 0 ||
    !isIsoInstant(input.audit.occurredAt)
  ) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(invalidIssue(
        "/audit",
        "Audit context must include workspace, actor, correlation ID, and a valid timestamp."
      ))
    });
  }

  const nextStatus = nextLifecycleStatus(state.status, input.action, state.activeVersion !== null);
  if (!nextStatus) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(invalidIssue("/action", "Lifecycle transition is not allowed from the current status."))
    });
  }

  const outcome = input.authorized ? "succeeded" : "denied";
  const effectiveStatus = input.authorized ? nextStatus : state.status;
  const auditEvent = makeLifecycleAuditEvent(state, input, outcome, effectiveStatus);
  const nextState = Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: effectiveStatus,
    auditEvents: Object.freeze([...state.auditEvents, auditEvent])
  });

  return input.authorized
    ? Object.freeze({ ok: true, state: nextState })
    : Object.freeze({ ok: false, kind: "denied", state: nextState, auditEvent });
};

export const publishAutomationDraft = (
  state: AutomationLifecycleState,
  expectedRevision: number
): LifecycleMutationResult => {
  const revisionResult = compareRevision(state, expectedRevision);
  if (revisionResult) return revisionResult;
  if (!state.hasDraft) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(invalidIssue("", "Automation has no draft."))
    });
  }

  const validation = validateRuleDraft(state.draft);
  if (!validation.valid) {
    const issues = validation.errors.map((error: RuleValidationIssue) =>
      invalidIssue(error.path, error.message, error.code));
    return Object.freeze({ ok: false, kind: "invalid", issues: Object.freeze(issues) });
  }

  const immutableRule = freezeDeep(structuredClone(validation.rule));
  const hash = hashRuleDocument(immutableRule);
  if (!hash.success) {
    return Object.freeze({
      ok: false,
      kind: "invalid",
      issues: lifecycleIssues(hash.issue)
    });
  }

  const latestVersion = state.versions[state.versions.length - 1]?.version ?? 0;
  const version: PublishedRuleVersion = freezeDeep({
    automationId: state.automationId,
    version: latestVersion + 1,
    schemaVersion: 1,
    contentHash: hash.contentHash,
    rule: immutableRule
  });
  // This active-version pointer is only an in-memory lifecycle transition, not runtime activation.
  return Object.freeze({
    ok: true,
    state: Object.freeze({
      ...state,
      revision: state.revision + 1,
      versions: Object.freeze([...state.versions, version]),
      activeVersion: version.version
    })
  });
};

export const pinActiveVersion = (
  state: AutomationLifecycleState
): AutomationRunVersionPin | undefined => {
  // The pin is an in-memory reference; durable run/version retention remains deferred.
  if (state.activeVersion === null) return undefined;
  const version = state.versions.find((item) => item.version === state.activeVersion);
  if (!version) return undefined;
  return Object.freeze({
    automationId: version.automationId,
    version: version.version,
    contentHash: version.contentHash
  });
};

export const resolvePinnedVersion = (
  state: AutomationLifecycleState,
  pin: AutomationRunVersionPin
): PublishedVersionResult => {
  const version = state.versions.find((item) =>
    item.automationId === pin.automationId && item.version === pin.version);
  if (!version) {
    return Object.freeze({
      ok: false,
      issue: invalidIssue("", "Pinned automation version was not found.", "AUTOMATION_VERSION_NOT_FOUND")
    });
  }

  const hash = hashRuleDocument(version.rule);
  if (!hash.success || hash.contentHash !== version.contentHash || pin.contentHash !== version.contentHash) {
    return Object.freeze({
      ok: false,
      issue: invalidIssue("", "Published version content hash does not match.", "AUTOMATION_VERSION_HASH_MISMATCH")
    });
  }
  return Object.freeze({ ok: true, version });
};

export const verifyPublishedVersionHash = (version: PublishedRuleVersion): boolean => {
  const hash = hashRuleDocument(version.rule);
  return hash.success && hash.contentHash === version.contentHash;
};
