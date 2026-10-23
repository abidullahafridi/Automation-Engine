import assert from "node:assert/strict";
import test from "node:test";
import type { ActionExecutionResult } from "../action.executor.js";
import { createActionExecutor } from "../action.executor.js";
import { createActionHandlerRegistry } from "../action.handler.js";
import { createPrincipalResolver } from "../automation.ports.js";
import { createNotificationSendHandler } from "../notification.action.js";
import { NotificationProviderError } from "../notification.ports.js";
import {
  createRetryPolicy,
  decideRetry,
  decideRetryForActionResult,
  defaultRetryPolicy,
  observeRetryDecision,
  parseRetryAfter,
  type RetryDecision,
  type RetryInput
} from "../retry.policy.js";

const T0 = "2026-10-17T10:00:00.000Z";
const at = (milliseconds: number): string => new Date(Date.parse(T0) + milliseconds).toISOString();

const input = (overrides: Partial<RetryInput> = {}): RetryInput => ({
  errorClass: "transient",
  attempt: 1,
  firstAttemptAt: T0,
  now: T0,
  ...overrides
});

const jitterOf = (value: number) => (): number => value;

const countingJitter = (value: number) => {
  const state = { calls: 0 };
  return {
    jitter: (): number => {
      state.calls += 1;
      return value;
    },
    calls: (): number => state.calls
  };
};

type RetryChoice = Extract<RetryDecision, { decision: "retry" }>;
type StopChoice = Extract<RetryDecision, { decision: "stop" }>;

const expectRetry = (decision: RetryDecision): RetryChoice => {
  if (decision.decision !== "retry") throw new Error(`Expected retry, got ${decision.decision}.`);
  return decision;
};

const expectStop = (decision: RetryDecision): StopChoice => {
  if (decision.decision !== "stop") throw new Error(`Expected stop, got ${decision.decision}.`);
  return decision;
};

void test("TC-0321 a transient failure is retried with exponential full-jitter backoff", () => {
  const expectedDelays = [500, 1_000, 2_000, 4_000];
  for (const [index, expected] of expectedDelays.entries()) {
    const attempt = index + 1;
    const decision = expectRetry(decideRetry(input({ attempt }), defaultRetryPolicy, jitterOf(0.5)));
    assert.equal(decision.reason, "TRANSIENT_FAILURE");
    assert.equal(decision.nextAttempt, attempt + 1);
    assert.equal(decision.delayMs, expected);
    assert.equal(decision.runAfter, at(expected));
    assert.equal(decision.honouredRetryAfter, false);
  }
  assert.equal(expectRetry(decideRetry(input(), defaultRetryPolicy, jitterOf(0))).delayMs, 0);
});

void test("TC-0322 permanent failures never retry and ambiguous outcomes are never repeated blindly", () => {
  const sampler = countingJitter(0.5);
  const permanent = expectStop(decideRetry(
    input({ errorClass: "permanent", retryAfterMs: 1_000 }),
    defaultRetryPolicy,
    sampler.jitter
  ));
  assert.deepEqual({ outcome: permanent.outcome, reason: permanent.reason }, {
    outcome: "failed",
    reason: "PERMANENT_FAILURE"
  });

  const ambiguous = expectStop(decideRetry(
    input({ errorClass: "ambiguous" }),
    defaultRetryPolicy,
    sampler.jitter
  ));
  assert.deepEqual({ outcome: ambiguous.outcome, reason: ambiguous.reason }, {
    outcome: "unknown_outcome",
    reason: "AMBIGUOUS_OUTCOME"
  });
  assert.equal(sampler.calls(), 0);
});

void test("TC-0323 the retry delay never exceeds the configured cap", () => {
  const policy = createRetryPolicy({
    maxAttempts: 10,
    baseDelayMs: 1_000,
    maxDelayMs: 5_000,
    maxAgeMs: 86_400_000
  });
  for (let attempt = 1; attempt <= 9; attempt += 1) {
    const decision = expectRetry(decideRetry(input({ attempt }), policy, jitterOf(0.999999)));
    assert.ok(decision.delayMs <= 5_000, `attempt ${String(attempt)} delay ${String(decision.delayMs)}`);
  }
  // a faulty jitter source can never push the delay past the cap
  for (const faulty of [1, 2, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    const decision = expectRetry(decideRetry(input({ attempt: 9 }), policy, jitterOf(faulty)));
    assert.ok(decision.delayMs >= 0 && decision.delayMs <= 5_000);
  }
});

void test("TC-0324 attempt and age budgets end retries", () => {
  const sampler = countingJitter(0.5);

  // the attempt budget counts the first attempt (default 5)
  assert.equal(decideRetry(input({ attempt: 4 }), defaultRetryPolicy, sampler.jitter).decision, "retry");
  for (const attempt of [5, 6]) {
    const decision = expectStop(decideRetry(input({ attempt }), defaultRetryPolicy, sampler.jitter));
    assert.deepEqual({ outcome: decision.outcome, reason: decision.reason }, {
      outcome: "dead_letter",
      reason: "MAX_ATTEMPTS_EXHAUSTED"
    });
  }

  // a rule can lower the cap but never raise it
  assert.equal(decideRetry(input({ ruleMaxAttempts: 2 }), defaultRetryPolicy, jitterOf(0.5)).decision, "retry");
  assert.equal(
    expectStop(decideRetry(input({ attempt: 2, ruleMaxAttempts: 2 }), defaultRetryPolicy, jitterOf(0.5))).reason,
    "MAX_ATTEMPTS_EXHAUSTED"
  );
  assert.equal(
    expectStop(decideRetry(input({ attempt: 1, ruleMaxAttempts: 1 }), defaultRetryPolicy, jitterOf(0.5))).reason,
    "MAX_ATTEMPTS_EXHAUSTED"
  );
  assert.equal(
    expectStop(decideRetry(input({ attempt: 5, ruleMaxAttempts: 100 }), defaultRetryPolicy, jitterOf(0.5))).reason,
    "MAX_ATTEMPTS_EXHAUSTED"
  );

  // the age budget: attempt 2 with jitter 0.5 waits 1,000 ms
  const agePolicy = createRetryPolicy({ maxAgeMs: 10_000 });
  const withinBudget = decideRetry(input({ attempt: 2, now: at(9_000) }), agePolicy, jitterOf(0.5));
  assert.equal(withinBudget.decision, "retry"); // 9,000 + 1,000 = exactly the budget
  const overBudget = expectStop(decideRetry(input({ attempt: 2, now: at(9_001) }), agePolicy, jitterOf(0.5)));
  assert.deepEqual({ outcome: overBudget.outcome, reason: overBudget.reason }, {
    outcome: "dead_letter",
    reason: "MAX_AGE_EXHAUSTED"
  });

  // jitter is sampled only when a retry is actually scheduled
  assert.equal(sampler.calls(), 1);
});

void test("TC-0325 provider Retry-After is respected within the policy", () => {
  const backoff = 500; // attempt 1, jitter 0.5

  const longer = expectRetry(decideRetry(input({ retryAfterMs: 30_000 }), defaultRetryPolicy, jitterOf(0.5)));
  assert.equal(longer.delayMs, 30_000);
  assert.equal(longer.honouredRetryAfter, true);
  assert.equal(longer.runAfter, at(30_000));

  // a shorter hint never shortens the backoff
  const shorter = expectRetry(decideRetry(input({ retryAfterMs: 100 }), defaultRetryPolicy, jitterOf(0.5)));
  assert.equal(shorter.delayMs, backoff);
  assert.equal(shorter.honouredRetryAfter, false);

  // the provider may ask for more than maxDelayMs, but never beyond the age budget
  const beyondCap = expectRetry(decideRetry(input({ retryAfterMs: 120_000 }), defaultRetryPolicy, jitterOf(0.5)));
  assert.equal(beyondCap.delayMs, 120_000);
  const beyondAge = expectStop(decideRetry(input({ retryAfterMs: 7_200_000 }), defaultRetryPolicy, jitterOf(0.5)));
  assert.equal(beyondAge.reason, "MAX_AGE_EXHAUSTED");

  // unusable hints are ignored
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const decision = expectRetry(decideRetry(input({ retryAfterMs: bad }), defaultRetryPolicy, jitterOf(0.5)));
    assert.equal(decision.delayMs, backoff);
    assert.equal(decision.honouredRetryAfter, false);
  }
});

void test("parseRetryAfter accepts delta-seconds and HTTP dates and rejects everything else", () => {
  const nowMs = Date.parse("2026-10-17T10:00:00.000Z");
  assert.equal(parseRetryAfter("120", nowMs), 120_000);
  assert.equal(parseRetryAfter(" 0 ", nowMs), 0);
  assert.equal(parseRetryAfter("Sat, 17 Oct 2026 10:01:00 GMT", nowMs), 60_000);
  assert.equal(parseRetryAfter("Sat, 17 Oct 2026 09:00:00 GMT", nowMs), 0);
  for (const invalid of [undefined, "", "soon", "-5", "1.5", "99999999999999999999", "x".repeat(65)]) {
    assert.equal(parseRetryAfter(invalid, nowMs), undefined);
  }
  assert.equal(parseRetryAfter("5", Number.NaN), undefined);
});

void test("invalid input fails closed without sampling jitter", () => {
  const sampler = countingJitter(0.5);
  const invalidInputs: readonly RetryInput[] = [
    input({ attempt: 0 }),
    input({ attempt: 1.5 }),
    input({ attempt: Number.NaN }),
    input({ now: "not-a-date" }),
    input({ firstAttemptAt: "also-not-a-date" }),
    input({ now: at(-1) }),
    input({ ruleMaxAttempts: 0 }),
    input({ ruleMaxAttempts: 2.5 })
  ];
  for (const invalid of invalidInputs) {
    const decision = expectStop(decideRetry(invalid, defaultRetryPolicy, sampler.jitter));
    assert.deepEqual({ outcome: decision.outcome, reason: decision.reason }, {
      outcome: "failed",
      reason: "INVALID_RETRY_INPUT"
    });
  }
  assert.equal(sampler.calls(), 0);
});

void test("decisions are deterministic for identical input and jitter", () => {
  const first = decideRetry(input({ attempt: 3, retryAfterMs: 2_000 }), defaultRetryPolicy, jitterOf(0.25));
  const second = decideRetry(input({ attempt: 3, retryAfterMs: 2_000 }), defaultRetryPolicy, jitterOf(0.25));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
});

void test("an invalid policy fails loudly", () => {
  assert.throws(() => createRetryPolicy({ maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createRetryPolicy({ maxAttempts: 1.5 }), /maxAttempts/);
  assert.throws(() => createRetryPolicy({ baseDelayMs: 0 }), /baseDelayMs/);
  assert.throws(() => createRetryPolicy({ baseDelayMs: 2_000, maxDelayMs: 1_000 }), /maxDelayMs/);
  assert.throws(() => createRetryPolicy({ maxAgeMs: -1 }), /maxAgeMs/);
  assert.equal(defaultRetryPolicy.maxAttempts, 5);
  assert.equal(Object.isFrozen(defaultRetryPolicy), true);
});

void test("executor results map to retry decisions", () => {
  const failure = (errorClass: "transient" | "permanent" | "ambiguous"): ActionExecutionResult => ({
    status: "failed",
    handlerInvoked: true,
    failure: { code: "ACTION_HANDLER_ERROR", errorClass, message: "Action failed." }
  });
  const context = { attempt: 1, firstAttemptAt: T0, now: T0 };

  const succeeded: ActionExecutionResult = {
    status: "succeeded",
    handlerInvoked: true,
    idempotencyKey: "key",
    output: {}
  };
  assert.deepEqual(decideRetryForActionResult(succeeded, context, defaultRetryPolicy, jitterOf(0.5)), {
    decision: "none"
  });
  assert.equal(
    decideRetryForActionResult(failure("transient"), context, defaultRetryPolicy, jitterOf(0.5)).decision,
    "retry"
  );
  assert.equal(
    expectStop(decideRetryForActionResult(failure("permanent"), context, defaultRetryPolicy, jitterOf(0.5))).outcome,
    "failed"
  );

  // an executor timeout of a non-idempotent action is ambiguous and must not be retried blindly
  const timedOut: ActionExecutionResult = {
    status: "timed_out",
    handlerInvoked: true,
    timeoutMs: 5_000,
    idempotencyKey: "key",
    failure: { code: "ACTION_TIMEOUT", errorClass: "ambiguous", message: "Action exceeded its time limit." }
  };
  assert.equal(
    expectStop(decideRetryForActionResult(timedOut, context, defaultRetryPolicy, jitterOf(0.5))).outcome,
    "unknown_outcome"
  );
});

void test("a real notification.send failure flows from the executor into the retry decision", async () => {
  const resolver = createPrincipalResolver({
    authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
    hasWorkspaceMembership: () => Promise.resolve(true)
  });
  const resolved = await resolver.resolve({ credential: "creator-1", requestedWorkspaceId: "workspace-1" });
  if (resolved.kind !== "resolved") throw new Error("Test resolver must resolve the workspace.");
  const scope = resolved.scope;

  const executorFor = (error: Error) => createActionExecutor({
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => Promise.resolve(true) },
    handlers: createActionHandlerRegistry([createNotificationSendHandler({
      directory: { findProjectLeadForRun: () => Promise.resolve({ userId: "lead-1", status: "active" }) },
      notifications: { send: () => Promise.reject(error) },
      variables: { forRun: () => Promise.resolve({ taskTitle: "t", actorName: "a" }) }
    })])
  });
  const request = {
    scope,
    run: { runId: "run-1", workspaceId: "workspace-1", automationId: "automation-1" },
    creatorId: "creator-1",
    actionIndex: 0,
    action: {
      type: "notification.send",
      config: { recipient: { type: "project_lead" }, template: "task_completed" }
    }
  };
  const context = { attempt: 1, firstAttemptAt: T0, now: T0 };

  const transient = await executorFor(new NotificationProviderError("transient", "down")).execute(request);
  assert.equal(
    decideRetryForActionResult(transient, context, defaultRetryPolicy, jitterOf(0.5)).decision,
    "retry"
  );

  const permanent = await executorFor(new NotificationProviderError("permanent", "rejected")).execute(request);
  const stopped = expectStop(decideRetryForActionResult(permanent, context, defaultRetryPolicy, jitterOf(0.5)));
  assert.equal(stopped.outcome, "failed");
});

void test("retry decisions emit low-cardinality metrics and never raw action types", () => {
  const counters: string[] = [];
  const metrics = {
    increment: (name: string, labels: Readonly<Record<string, string>>): void => {
      counters.push(`${name}:${Object.values(labels).join(":")}`);
    }
  };

  observeRetryDecision(metrics, "notification.send", decideRetry(input(), defaultRetryPolicy, jitterOf(0.5)));
  observeRetryDecision(
    metrics,
    "notification.send",
    decideRetry(input({ attempt: 5 }), defaultRetryPolicy, jitterOf(0.5))
  );
  observeRetryDecision(
    metrics,
    "notification.send",
    decideRetry(input({ errorClass: "permanent" }), defaultRetryPolicy, jitterOf(0.5))
  );
  observeRetryDecision(
    metrics,
    "evil.<script>-user-supplied",
    decideRetry(input({ errorClass: "ambiguous" }), defaultRetryPolicy, jitterOf(0.5))
  );
  observeRetryDecision(metrics, "notification.send", { decision: "none" });

  assert.deepEqual(counters, [
    "automation_retries_total:notification.send:TRANSIENT_FAILURE",
    "automation_dead_letter_total:notification.send:MAX_ATTEMPTS_EXHAUSTED",
    "automation_retry_stopped_total:notification.send:failed:PERMANENT_FAILURE",
    "automation_retry_stopped_total:unknown:unknown_outcome:AMBIGUOUS_OUTCOME"
  ]);
});