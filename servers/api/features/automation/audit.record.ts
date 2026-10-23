import { createHash } from "node:crypto";
import { isIsoInstant } from "./condition.validation.js";
import { isSensitiveKey, redactedText, scrubText } from "./telemetry.redaction.js";

export const auditActorTypes = Object.freeze(["user", "system", "automation"] as const);
export const auditActions = Object.freeze([
  "automation.enable",
  "automation.pause",
  "automation.resume",
  "automation.disable",
  "automation.archive",
  "execution.denied",
  "run.retry",
  "run.replay",
  "quota.override",
  "flag.change"
] as const);
export const auditOutcomes = Object.freeze(["succeeded", "denied", "failed"] as const);
export const auditTargetTypes = Object.freeze(["automation", "run", "workspace", "flag"] as const);

export type AuditActorType = (typeof auditActorTypes)[number];
export type AuditAction = (typeof auditActions)[number];
export type AuditOutcome = (typeof auditOutcomes)[number];
export type AuditTargetType = (typeof auditTargetTypes)[number];

export type AuditActor = Readonly<{ type: AuditActorType; id: string }>;
export type AuditTarget = Readonly<{ type: AuditTargetType; id: string }>;
export type AuditDetailValue = string | number | boolean | null;

export type AuditRecord = Readonly<{
  recordId: string;
  workspaceId: string;
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  outcome: AuditOutcome;
  occurredAt: string;
  correlationId: string;
  /** Bounded, redacted, scalar-only. Callers pass codes, never free text or payloads. */
  details: Readonly<Record<string, AuditDetailValue>>;
  /** sha256 over every other field. Detects modification after the fact. */
  contentHash: string;
}>;

export type AuditInput = Readonly<{
  actor: AuditActor;
  action: AuditAction;
  target: AuditTarget;
  outcome: AuditOutcome;
  correlationId: string;
  occurredAt: string;
  details: Readonly<Record<string, unknown>>;
}>;

export type AuditRejectionCode =
  | "INVALID_RECORD_ID"
  | "INVALID_WORKSPACE"
  | "INVALID_ACTOR"
  | "INVALID_ACTION"
  | "INVALID_TARGET"
  | "INVALID_OUTCOME"
  | "INVALID_CORRELATION"
  | "INVALID_TIME"
  | "INVALID_DETAILS";

export type BuildAuditResult =
  | Readonly<{ ok: true; record: AuditRecord }>
  | Readonly<{ ok: false; code: AuditRejectionCode }>;

export const maxAuditDetailKeys = 20;
const maxIdLength = 200;
const detailKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Non-empty, bounded, no whitespace and no control characters. */
const isSafeId = (value: string): boolean => {
  if (value.length === 0 || value.length > maxIdLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code === 127) return false;
  }
  return true;
};

const sanitizeDetails = (
  raw: Readonly<Record<string, unknown>>
): Readonly<Record<string, AuditDetailValue>> | undefined => {
  const entries = Object.entries(raw);
  if (entries.length > maxAuditDetailKeys) return undefined;
  const output: Record<string, AuditDetailValue> = {};
  for (const [key, value] of entries) {
    if (!detailKeyPattern.test(key)) return undefined;
    if (isSensitiveKey(key)) {
      output[key] = redactedText;
    } else if (value === null || typeof value === "boolean") {
      output[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return undefined;
      output[key] = value;
    } else if (typeof value === "string") {
      output[key] = scrubText(value);
    } else {
      output[key] = "[UNSUPPORTED]";
    }
  }
  return Object.freeze(output);
};

const compareText = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

type HashableRecord = Omit<AuditRecord, "contentHash">;

const hashRecord = (record: HashableRecord): string =>
  createHash("sha256")
    .update(JSON.stringify([
      record.recordId,
      record.workspaceId,
      record.actor.type,
      record.actor.id,
      record.action,
      record.target.type,
      record.target.id,
      record.outcome,
      record.occurredAt,
      record.correlationId,
      Object.entries(record.details).sort(([left], [right]) => compareText(left, right))
    ]), "utf8")
    .digest("hex");

export const verifyAuditRecord = (record: AuditRecord): boolean =>
  record.contentHash === hashRecord(record);

/** Returns a new, deeply frozen copy. Never mutates the input. */
export const freezeAuditRecord = (record: AuditRecord): AuditRecord => Object.freeze({
  recordId: record.recordId,
  workspaceId: record.workspaceId,
  actor: Object.freeze({ type: record.actor.type, id: record.actor.id }),
  action: record.action,
  target: Object.freeze({ type: record.target.type, id: record.target.id }),
  outcome: record.outcome,
  occurredAt: record.occurredAt,
  correlationId: record.correlationId,
  details: Object.freeze({ ...record.details }),
  contentHash: record.contentHash
});

export const buildAuditRecord = ({
  recordId,
  workspaceId,
  input
}: Readonly<{ recordId: string; workspaceId: string; input: AuditInput }>): BuildAuditResult => {
  const fail = (code: AuditRejectionCode): BuildAuditResult => Object.freeze({ ok: false, code });

  if (!isSafeId(recordId)) return fail("INVALID_RECORD_ID");
  if (!isSafeId(workspaceId)) return fail("INVALID_WORKSPACE");
  if (!auditActorTypes.includes(input.actor.type) || !isSafeId(input.actor.id)) return fail("INVALID_ACTOR");
  if (!auditActions.includes(input.action)) return fail("INVALID_ACTION");
  if (!auditTargetTypes.includes(input.target.type) || !isSafeId(input.target.id)) return fail("INVALID_TARGET");
  if (!auditOutcomes.includes(input.outcome)) return fail("INVALID_OUTCOME");
  if (!isSafeId(input.correlationId)) return fail("INVALID_CORRELATION");
  if (!isIsoInstant(input.occurredAt)) return fail("INVALID_TIME");
  const details = sanitizeDetails(input.details);
  if (details === undefined) return fail("INVALID_DETAILS");

  const unsigned: HashableRecord = {
    recordId,
    workspaceId,
    actor: input.actor,
    action: input.action,
    target: input.target,
    outcome: input.outcome,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    details
  };
  const record = freezeAuditRecord({ ...unsigned, contentHash: hashRecord(unsigned) });
  return Object.freeze({ ok: true, record });
};