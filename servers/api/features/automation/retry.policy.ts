/**
 * Retry decision core (AE-T-032.1).
 *
 * Pure and deterministic: no I/O, no clock and no randomness of its own. The caller injects
 * `now` (ISO instant) and `jitter` (a function returning a number in [0, 1)).
 *
 * It decides what happens AFTER a failed action attempt. It does not persist state, schedule
 * timers or move runs between states; that is AE-T-032.2 and the run persistence work.
 *
 * Classes (BR-007, BR-008):
 *   transient => retry with bounded full-jitter backoff, within the attempt and age budgets
 *   permanent => stop, outcome "failed"
 *   ambiguous => stop, outcome "unknown_outcome" (never repeated blindly)
 */
import type { ActionExecutionResult } from "./action.executor.js";
import type { ActionErrorClass } from "./action.handler.js";
import type { ActionMetricsPort } from "./action.outcome.js";
import { actionRegistry, type ActionRegistry } from "./automation.registry.js";
import { isIsoInstant } from "./condition.validation.js";

export type RetryPolicy = Readonly<{
  /** Total attempts INCLUDING the first one. */
  maxAttempts: number;
  /** Backoff ceiling for the first retry; doubles with every further attempt. */
  baseDelayMs: number;
  /** Hard cap for the computed backoff. */
  maxDelayMs: number;
  /** Total time since the first attempt after which no further retry is scheduled. */
  maxAgeMs: number;
}>;

/**
 * Only maxAttempts (5) comes from spec section 3.4. The delay and age values are PROVISIONAL
 * proposals and must be confirmed by ADR-0007 and load tests before production use.
 */
export const retryPolicyDefaults: RetryPolicy = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  maxAgeMs: 3_600_000
});

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

/** Fails loudly on an invalid policy so a misconfiguration never becomes unbounded retrying. */
export const createRetryPolicy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => {
  const policy: RetryPolicy = { ...retryPolicyDefaults, ...overrides };
  if (!isPositiveInteger(policy.maxAttempts)) {
    throw new Error("Retry policy maxAttempts must be a positive integer.");
  }
  if (!isPositiveInteger(policy.baseDelayMs)) {
    throw new Error("Retry policy baseDelayMs must be a positive integer.");
  }
  if (!isPositiveInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error("Retry policy maxDelayMs must be a positive integer not below baseDelayMs.");
  }
  if (!isPositiveInteger(policy.maxAgeMs)) {
    throw new Error("Retry policy maxAgeMs must be a positive integer.");
  }
  return Object.freeze(policy);
};

export const defaultRetryPolicy: RetryPolicy = createRetryPolicy();

/** Returns a number in [0, 1). Production passes Math.random; tests pass fixed values. */
export type RetryJitter = () => number;

export type RetryInput = Readonly<{
  errorClass: ActionErrorClass;
  /** Attempts made so far INCLUDING the one that just failed (the first attempt is 1). */
  attempt: number;
  /** ISO instant at which the first attempt started. */
  firstAttemptAt: string;
  /** ISO instant of this decision. */
  now: string;
  /** The rule's executionPolicy.maxAttempts. It can only lower the policy cap, never raise it. */
  ruleMaxAttempts?: number;
  /** Provider Retry-After in milliseconds, already parsed (see parseRetryAfter). */
  retryAfterMs?: number;
}>;

export type RetryStopOutcome = "failed" | "unknown_outcome" | "dead_letter";

export type RetryStopReason =
  | "PERMANENT_FAILURE"
  | "AMBIGUOUS_OUTCOME"
  | "MAX_ATTEMPTS_EXHAUSTED"
  | "MAX_AGE_EXHAUSTED"
  | "INVALID_RETRY_INPUT";

export type RetryDecision =
  | Readonly<{
      decision: "retry";
      reason: "TRANSIENT_FAILURE";
      nextAttempt: number;
      delayMs: number;
      /** ISO instant at which the next attempt becomes eligible. */
      runAfter: string;
      /** true when the provider's Retry-After determined the delay. */
      honouredRetryAfter: boolean;
    }>
  | Readonly<{ decision: "stop"; outcome: RetryStopOutcome; reason: RetryStopReason }>
  | Readonly<{ decision: "none" }>;

const stop = (outcome: RetryStopOutcome, reason: RetryStopReason): RetryDecision =>
  Object.freeze({ decision: "stop" as const, outcome, reason });

/** Largest backoff exponent; keeps the multiplication far below Number.MAX_SAFE_INTEGER. */
const maxBackoffExponent = 30;
/** Largest value a jitter sample may take, so a faulty sample of 1 still stays below the ceiling. */
const maxJitterUnit = 0.999999;

/**
 * Full jitter (spec 11.6): random(0, min(maxDelay, base * 2^(attempt - 1))).
 * A non-finite jitter sample is treated as the maximum, which is the conservative choice.
 */
export const computeBackoffMs = (
  attempt: number,
  policy: RetryPolicy,
  jitter: RetryJitter
): number => {
  const exponent = Math.min(Math.max(attempt - 1, 0), maxBackoffExponent);
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const sample = jitter();
  const unit = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), maxJitterUnit) : maxJitterUnit;
  return Math.floor(unit * ceiling);
};

const httpDatePattern = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const maxRetryAfterHeaderLength = 64;

/**
 * Parses an HTTP Retry-After header (delta-seconds or IMF-fixdate) into milliseconds.
 * Anything else returns undefined so a malformed header never shortens or breaks a retry.
 */
export const parseRetryAfter = (value: string | undefined, nowMs: number): number | undefined => {
  if (value === undefined || !Number.isFinite(nowMs)) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxRetryAfterHeaderLength) return undefined;
  if (/^\d+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  if (!httpDatePattern.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
};

const effectiveMaxAttempts = (
  policy: RetryPolicy,
  ruleMaxAttempts: number | undefined
): number | undefined => {
  if (ruleMaxAttempts === undefined) return policy.maxAttempts;
  if (!isPositiveInteger(ruleMaxAttempts)) return undefined;
  return Math.min(policy.maxAttempts, ruleMaxAttempts);
};

const usableRetryAfter = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;

/**
 * Decides what follows a failed attempt. Deterministic for identical inputs and jitter samples.
 * Invalid input fails closed (no retry). Jitter is sampled only when a retry is scheduled.
 */
export const decideRetry = (
  input: RetryInput,
  policy: RetryPolicy,
  jitter: RetryJitter
): RetryDecision => {
  const limit = effectiveMaxAttempts(policy, input.ruleMaxAttempts);
  if (
    limit === undefined ||
    !isPositiveInteger(input.attempt) ||
    !isIsoInstant(input.now) ||
    !isIsoInstant(input.firstAttemptAt)
  ) {
    return stop("failed", "INVALID_RETRY_INPUT");
  }
  const nowMs = Date.parse(input.now);
  const firstMs = Date.parse(input.firstAttemptAt);
  if (nowMs < firstMs) return stop("failed", "INVALID_RETRY_INPUT");

  switch (input.errorClass) {
    case "permanent":
      return stop("failed", "PERMANENT_FAILURE");
    case "ambiguous":
      return stop("unknown_outcome", "AMBIGUOUS_OUTCOME");
    case "transient":
      break;
  }

  if (input.attempt >= limit) return stop("dead_letter", "MAX_ATTEMPTS_EXHAUSTED");

  const backoffMs = computeBackoffMs(input.attempt, policy, jitter);
  const retryAfterMs = usableRetryAfter(input.retryAfterMs);
  const delayMs = retryAfterMs === undefined ? backoffMs : Math.max(backoffMs, retryAfterMs);

  // Never retry earlier than the provider asked; if that exceeds the age budget, give up.
  if (nowMs + delayMs - firstMs > policy.maxAgeMs) return stop("dead_letter", "MAX_AGE_EXHAUSTED");

  return Object.freeze({
    decision: "retry" as const,
    reason: "TRANSIENT_FAILURE" as const,
    nextAttempt: input.attempt + 1,
    delayMs,
    runAfter: new Date(nowMs + delayMs).toISOString(),
    honouredRetryAfter: retryAfterMs !== undefined && delayMs === retryAfterMs
  });
};

/** Maps an executor result to a retry decision. A success needs no retry decision. */
export const decideRetryForActionResult = (
  result: ActionExecutionResult,
  context: Omit<RetryInput, "errorClass">,
  policy: RetryPolicy,
  jitter: RetryJitter
): RetryDecision => result.status === "succeeded"
  ? Object.freeze({ decision: "none" as const })
  : decideRetry({ ...context, errorClass: result.failure.errorClass }, policy, jitter);

/**
 * Emits low-cardinality metrics (spec 14.2). Unregistered action types are labelled
 * "unknown", so a user-supplied type can never create unbounded label values.
 * automation_retry_stopped_total is an addition for permanent and ambiguous stops.
 */
export const observeRetryDecision = (
  metrics: ActionMetricsPort,
  actionType: string,
  decision: RetryDecision,
  actions: ActionRegistry = actionRegistry
): void => {
  const registration = actions.get(actionType);
  const label = registration ? registration.type : "unknown";
  switch (decision.decision) {
    case "none":
      return;
    case "retry":
      metrics.increment("automation_retries_total", {
        action_type: label,
        reason: decision.reason
      });
      return;
    case "stop":
      if (decision.outcome === "dead_letter") {
        metrics.increment("automation_dead_letter_total", {
          action_type: label,
          reason: decision.reason
        });
      } else {
        metrics.increment("automation_retry_stopped_total", {
          action_type: label,
          outcome: decision.outcome,
          reason: decision.reason
        });
      }
  }
};