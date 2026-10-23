import { createHash } from "node:crypto";

/** Spec section 3.4: minimum schedule interval is 1 minute. */
export const minScheduleIntervalMs = 60_000;

export type ScheduleDefinition =
  | Readonly<{ kind: "interval"; everyMs: number; anchorAt: string }>
  | Readonly<{ kind: "daily"; time: string }>;

export type ScheduleIssueCode =
  | "INVALID_TIMEZONE"
  | "INVALID_INTERVAL"
  | "INTERVAL_TOO_SHORT"
  | "INVALID_ANCHOR"
  | "INVALID_TIME"
  | "INVALID_DEFINITION";

export type ScheduleIssue = Readonly<{ code: ScheduleIssueCode; message: string }>;

/** Spec D-22: occurrences that were missed and not caught up are recorded, never silently dropped. */
export type OccurrenceSkipReason = "MISSED_SKIPPED";

export type ScheduleOccurrence = Readonly<{
  /** Deterministic: the same (workspace, automation, instant) always yields the same id. */
  occurrenceId: string;
  workspaceId: string;
  automationId: string;
  /** UTC instant, ISO-8601 with milliseconds and Z. */
  scheduledFor: string;
  timezone: string;
  createdAt: string;
  /** Present only when the occurrence was skipped by the missed-run policy. */
  skipReason?: OccurrenceSkipReason;
}>;

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const issue = (code: ScheduleIssueCode, message: string): ScheduleIssue =>
  Object.freeze({ code, message });

const toIso = (milliseconds: number): string | undefined =>
  Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8.64e15
    ? new Date(milliseconds).toISOString()
    : undefined;

/** IANA zone names only (Area/City) plus UTC. Validity is checked by the runtime's tz database. */
export const isValidTimeZone = (timezone: string): boolean => {
  if (timezone.length === 0 || timezone.length > 64) return false;
  if (timezone !== "UTC" && !timezone.includes("/")) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return formatter.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
};

const parseTime = (time: string): Readonly<{ hour: number; minute: number }> | undefined => {
  const match = timePattern.exec(time);
  if (match === null) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return Number.isInteger(hour) && Number.isInteger(minute)
    ? Object.freeze({ hour, minute })
    : undefined;
};

export const validateSchedule = (
  timezone: string,
  definition: ScheduleDefinition
): readonly ScheduleIssue[] => {
  const issues: ScheduleIssue[] = [];
  if (!isValidTimeZone(timezone)) {
    issues.push(issue("INVALID_TIMEZONE", "Schedule requires a valid IANA time zone."));
  }
  if (definition.kind === "interval") {
    if (!Number.isSafeInteger(definition.everyMs) || definition.everyMs <= 0) {
      issues.push(issue("INVALID_INTERVAL", "Interval must be a positive integer number of milliseconds."));
    } else if (definition.everyMs < minScheduleIntervalMs) {
      issues.push(issue("INTERVAL_TOO_SHORT", "Interval must be at least one minute."));
    }
    if (!Number.isFinite(Date.parse(definition.anchorAt))) {
      issues.push(issue("INVALID_ANCHOR", "Interval anchor must be a valid ISO-8601 instant."));
    }
  } else if (parseTime(definition.time) === undefined) {
    issues.push(issue("INVALID_TIME", "Daily time must be HH:mm (24-hour)."));
  }
  return Object.freeze(issues);
};

type WallClock = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

const wallClock = (timezone: string, milliseconds: number): WallClock => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = formatter.formatToParts(new Date(milliseconds));
  const read = (type: string): number => {
    const part = parts.find((item) => item.type === type);
    return part === undefined ? Number.NaN : Number(part.value);
  };
  return Object.freeze({
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour") % 24,
    minute: read("minute"),
    second: read("second")
  });
};

/** UTC offset (local minus UTC) in ms that applies at the given instant. */
const offsetMs = (timezone: string, milliseconds: number): number => {
  const wall = wallClock(timezone, milliseconds);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(milliseconds / 1000) * 1000;
};

const dayMs = 86_400_000;

export type LocalTimeKind = "normal" | "gap" | "fold";

export type LocalTimeResolution = Readonly<{
  /** UTC instant in epoch milliseconds. */
  instant: number;
  kind: LocalTimeKind;
}>;

/**
 * First instant (second resolution) within (fromMs, toMs] whose UTC offset differs from the
 * offset at fromMs. Assumes a single offset transition inside the window.
 */
const firstOffsetChange = (timezone: string, fromMs: number, toMs: number): number => {
  const startOffset = offsetMs(timezone, fromMs);
  let low = Math.floor(fromMs / 1000);
  let high = Math.floor(toMs / 1000);
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (offsetMs(timezone, middle * 1000) === startOffset) low = middle;
    else high = middle;
  }
  return high * 1000;
};

/**
 * Local wall time to a UTC instant with an explicit DST policy.
 * - normal: exactly one valid instant.
 * - gap (spring forward, spec D-23): the local time does not exist, so the first valid
 *   instant after the gap (the transition instant) is returned.
 * - fold (fall back, spec D-24): the local time exists twice, so the FIRST occurrence is returned.
 */
export const resolveLocalTime = (
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): LocalTimeResolution => {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetMs(timezone, guess - dayMs);
  const after = offsetMs(timezone, guess + dayMs);
  const offsets = before === after ? [before] : [before, after];

  const valid: number[] = [];
  for (const offset of offsets) {
    const candidate = guess - offset;
    if (offsetMs(timezone, candidate) === offset) valid.push(candidate);
  }
  valid.sort((left, right) => left - right);

  const first = valid[0];
  if (first === undefined) {
    return Object.freeze({
      instant: firstOffsetChange(timezone, guess - dayMs, guess + dayMs),
      kind: "gap" as const
    });
  }
  return Object.freeze({
    instant: first,
    kind: valid.length > 1 ? ("fold" as const) : ("normal" as const)
  });
};

/**
 * First occurrence strictly AFTER `afterIso`, as a UTC ISO instant.
 * Returns undefined for an invalid schedule or input; callers must fail closed.
 */
export const computeNextOccurrence = (
  timezone: string,
  definition: ScheduleDefinition,
  afterIso: string
): string | undefined => {
  const afterMs = Date.parse(afterIso);
  if (!Number.isFinite(afterMs) || !isValidTimeZone(timezone)) return undefined;

  if (definition.kind === "interval") {
    const anchor = Date.parse(definition.anchorAt);
    const every = definition.everyMs;
    if (!Number.isFinite(anchor) || !Number.isSafeInteger(every) || every < minScheduleIntervalMs) {
      return undefined;
    }
    if (afterMs < anchor) return toIso(anchor);
    const steps = Math.floor((afterMs - anchor) / every) + 1;
    return toIso(anchor + steps * every);
  }

  const time = parseTime(definition.time);
  if (time === undefined) return undefined;
  const start = wallClock(timezone, afterMs);
  for (let offset = 0; offset <= 2; offset += 1) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const resolved = resolveLocalTime(
      timezone,
      day.getUTCFullYear(),
      day.getUTCMonth() + 1,
      day.getUTCDate(),
      time.hour,
      time.minute
    );
    if (resolved.instant > afterMs) return toIso(resolved.instant);
  }
  return undefined;
};

/** Stable identity for one intended occurrence (spec 9.2: unique automationId + scheduledFor). */
export const occurrenceKey = (
  workspaceId: string,
  automationId: string,
  scheduledFor: string
): string =>
  createHash("sha256")
    .update(JSON.stringify([workspaceId, automationId, scheduledFor]), "utf8")
    .digest("hex");