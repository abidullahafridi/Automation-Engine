import type { ActionExecutionResult, ActionExecutor } from "./action.executor.js";
import { executionDenialAuditRequest } from "./audit.adapters.js";
import type { AuditRecorder } from "./audit.recorder.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type { AutomationRepository } from "./automation.repository.js";
import type { AutomationLogFields, AutomationTelemetry } from "./automation.telemetry.js";
import {
  toActionExecutionRequest,
  type ExecutionContextResolver,
  type ExecutionDenialCode
} from "./execution.context.js";
import type { ActionAttempt, ActionStatus, RunRepository } from "./run.repository.js";
import type { RunHandler } from "./run.worker.js";
import type { TraceFactory } from "./telemetry.trace.js";
import { createRetryPolicy, decideRetry, type RetryPolicy } from "./retry.policy.js";

/** Total attempts including the first (spec section 3.4). Attempt number = fencing token. */
export const defaultMaxAttempts = 5;

/** Applies spec D-12 (auto-pause with reason). The real adapter needs a status-update method that does not exist yet. */
export type AutomationPauser = Readonly<{
  pause: (scope: WorkspaceScope, automationId: string, reason: ExecutionDenialCode) => Promise<void>;
}>;

export type RunExecutionDependencies = Readonly<{
  contexts: ExecutionContextResolver;
  automations: Pick<AutomationRepository, "listVersions">;
  runs: Pick<RunRepository, "transition" | "insertActionAttempt" | "updateActionAttempt" | "scheduleRetry" | "deadLetterRun" | "listActionAttempts">;
  executor: ActionExecutor;
  telemetry: AutomationTelemetry;
  audit: AuditRecorder;
  traces: TraceFactory;
  clock: Readonly<{ now: () => string }>;
  maxAttempts?: number;
  retryPolicy?: RetryPolicy;
  retryJitter?: () => number;
  pauser?: AutomationPauser;
}>;

type PlannedAction = Readonly<{ type: string; config: unknown }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads the published rule defensively; the version content hash was already verified. */
const readActions = (rule: unknown): readonly PlannedAction[] | undefined => {
  if (!isRecord(rule) || !Array.isArray(rule.actions)) return undefined;
  const items: readonly unknown[] = rule.actions;
  const planned: PlannedAction[] = [];
  for (const item of items) {
    if (!isRecord(item) || typeof item.type !== "string") return undefined;
    planned.push(Object.freeze({ type: item.type, config: item.config }));
  }
  return Object.freeze(planned);
};

const readTriggerType = (rule: unknown): string | undefined =>
  isRecord(rule) && isRecord(rule.trigger) && typeof rule.trigger.type === "string"
    ? rule.trigger.type
    : undefined;

const elapsedMs = (from: string, to: string): number => {
  const difference = Date.parse(to) - Date.parse(from);
  return Number.isFinite(difference) && difference > 0 ? difference : 0;
};

const attemptStatusOf = (result: ActionExecutionResult): ActionStatus => {
  if (result.status === "succeeded") return "succeeded";
  return result.failure.errorClass === "ambiguous" ? "unknown_outcome" : "failed";
};

export const createRunExecutionHandler = (deps: RunExecutionDependencies): RunHandler => {
  const maxAttempts = deps.maxAttempts ?? deps.retryPolicy?.maxAttempts ?? defaultMaxAttempts;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer.");
  }

  return async ({ scope, run, signal }) => {
    const startedAt = deps.clock.now();
    const trace = deps.traces.child(run.traceparent);
    const base: AutomationLogFields = Object.freeze({
      workspaceId: run.workspaceId,
      automationId: run.automationId,
      automationVersion: run.version,
      runId: run.runId,
      eventId: run.eventId,
      traceId: trace.traceId,
      fencingToken: run.fencingToken,
      attempt: run.fencingToken,
      ...(run.chainKey === undefined ? {} : { correlationId: run.chainKey })
    });
    const state = { triggerType: "unknown" };
    const retryPolicy = createRetryPolicy({ ...deps.retryPolicy, maxAttempts });
    const jitter = deps.retryJitter ?? Math.random;
    let ruleMaxAttempts: number | undefined;
    // A function call (not a property read) so TypeScript does not narrow it across awaits.
    const aborted = (): boolean => signal.aborted;

    const finish = async (to: "completed" | "failed", errorCode?: string): Promise<void> => {
      const now = deps.clock.now();
      const result = await deps.runs.transition(
        scope, run.runId, run.revision, "running", to, now, run.fencingToken
      );
      if (result !== "updated") {
        // Another worker owns the run now. Nothing is recorded as this worker's outcome.
        deps.telemetry.logRun("warn", "Run outcome rejected: lease was lost.", { ...base, errorCode: "STALE_WRITE" });
        return;
      }
      const durationMs = elapsedMs(startedAt, now);
      deps.telemetry.recordRun(to, state.triggerType);
      deps.telemetry.recordRunDuration(to, durationMs);
      deps.telemetry.logRun(
        to === "completed" ? "info" : "warn",
        to === "completed" ? "Run completed." : "Run failed.",
        { ...base, durationMs, ...(errorCode === undefined ? {} : { errorCode }) }
      );
    };

    /** Leaves the run for the reaper while attempts remain, otherwise fails it. */
    const retryOrFail = async (code: string, actionType: string): Promise<void> => {
      const now = deps.clock.now();
      const firstAttemptAt = run.firstAttemptAt ?? startedAt;
      const decision = decideRetry({ errorClass: "transient", attempt: run.fencingToken, firstAttemptAt, now,
        ...(ruleMaxAttempts === undefined ? {} : { ruleMaxAttempts }) }, retryPolicy, jitter);
      if (decision.decision === "retry") {
        const scheduled = await deps.runs.scheduleRetry(scope, run.runId, run.revision, run.fencingToken, now, decision.runAfter, firstAttemptAt, code);
        if (scheduled !== "updated") {
          deps.telemetry.logRun("warn", "Retry scheduling rejected: lease was lost.", { ...base, errorCode: "STALE_WRITE" });
          return;
        }
        deps.telemetry.recordRetry(actionType, "transient");
        deps.telemetry.logRun("warn", "Run scheduled for retry.", { ...base, errorCode: code, retryDecision: "retry", runAfter: decision.runAfter, delayMs: decision.delayMs });
        return;
      }
      if (decision.decision === "stop" && decision.outcome === "dead_letter") {
        const deadLettered = await deps.runs.deadLetterRun(scope, run.runId, run.fencingToken, now, {
          reason: decision.reason,
          attempts: run.fencingToken,
          firstAttemptAt,
          failureCode: code,
          errorClass: "transient"
        });
        if (deadLettered === "dead_lettered") {
          deps.telemetry.recordRetry(actionType, "exhausted");
          deps.telemetry.recordRun("dead_letter", state.triggerType);
        } else {
          deps.telemetry.logRun("warn", "Dead-letter write rejected: lease was lost.", { ...base, errorCode: "STALE_WRITE" });
        }
        return;
      }
      await finish("failed", code);
    };

    const execute = async (): Promise<void> => {
      deps.telemetry.logRun("info", "Run started.", base);

      if (run.fencingToken > maxAttempts) {
        await finish("failed", "ATTEMPTS_EXHAUSTED");
        return;
      }

      // 1. Trusted context: scope, enabled automation, creator standing (re-checked every run).
      const resolved = await deps.contexts.resolve(scope, {
        runId: run.runId,
        workspaceId: run.workspaceId,
        automationId: run.automationId
      });
      if (resolved.kind === "denied") {
        if (resolved.retryable) {
          await retryOrFail(resolved.code, "run.context");
          return;
        }
        const audited = await deps.audit.record(scope, executionDenialAuditRequest({
          automationId: run.automationId,
          runId: run.runId,
          code: resolved.code,
          pauseAutomation: resolved.pauseAutomation,
          retryable: resolved.retryable,
          correlationId: run.chainKey
        }));
        if (audited.kind !== "recorded" && audited.kind !== "idempotent") {
          await retryOrFail("AUDIT_UNAVAILABLE", "run.context");
          return;
        }
        if (resolved.pauseAutomation && deps.pauser !== undefined) {
          try {
            await deps.pauser.pause(scope, run.automationId, resolved.code);
          } catch (error) {
            deps.telemetry.logFailure("Automation could not be paused.", error, { ...base, errorCode: resolved.code });
          }
        }
        await finish("failed", resolved.code);
        return;
      }

      // 2. Pinned immutable version, integrity verified (INV-02).
      let versions: Awaited<ReturnType<AutomationRepository["listVersions"]>>;
      try {
        versions = await deps.automations.listVersions(scope, run.automationId);
      } catch {
        await retryOrFail("VERSION_LOOKUP_UNAVAILABLE", "run.version");
        return;
      }
      const published = versions.find((item) => item.version === run.version);
      if (published === undefined) {
        await finish("failed", "VERSION_NOT_FOUND");
        return;
      }
      if (published.contentHash !== run.contentHash) {
        await finish("failed", "VERSION_INTEGRITY");
        return;
      }
      if (isRecord(published.rule) && isRecord(published.rule.executionPolicy) && typeof published.rule.executionPolicy.maxAttempts === "number") {
        ruleMaxAttempts = published.rule.executionPolicy.maxAttempts;
      }
      state.triggerType = readTriggerType(published.rule) ?? "unknown";
      const actions = readActions(published.rule);
      if (actions === undefined) {
        await finish("failed", "VERSION_INVALID");
        return;
      }

      // 3. Actions in order. The executor re-checks scope, schema and permission before every handler.
      const persistedAttempts = await deps.runs.listActionAttempts(scope, run.runId);
      for (const [actionIndex, action] of actions.entries()) {
        if (aborted()) {
          deps.telemetry.logRun("warn", "Run stopped: lease lost or shutdown.", { ...base, actionIndex, errorCode: "ABORTED" });
          return;
        }
        const priorAttempts = persistedAttempts.filter((attempt) => attempt.actionIndex === actionIndex);
        if (priorAttempts.some((attempt) => attempt.status === "succeeded")) {
          deps.telemetry.logRun("info", "Action already succeeded; skipping duplicate execution.", { ...base, actionIndex, actionType: action.type });
          continue;
        }
        if (priorAttempts.some((attempt) => attempt.status === "unknown_outcome" || attempt.status === "running")) {
          await finish("failed", "ACTION_OUTCOME_UNKNOWN");
          return;
        }
        const actionStartedAt = deps.clock.now();
        const attempt: ActionAttempt = Object.freeze({
          runId: run.runId,
          workspaceId: run.workspaceId,
          actionIndex,
          attempt: run.fencingToken,
          status: "running",
          createdAt: actionStartedAt,
          updatedAt: actionStartedAt,
          actionType: action.type
        });
        const writeAhead = await deps.runs.insertActionAttempt(scope, attempt);
        if (writeAhead !== "created") {
          await finish("failed", "ACTION_ATTEMPT_ALREADY_EXISTS");
          return;
        }
        const result = await deps.executor.execute(
          toActionExecutionRequest(resolved.context, { actionIndex, action, signal })
        );
        const actionEndedAt = deps.clock.now();
        const durationMs = elapsedMs(actionStartedAt, actionEndedAt);
        deps.telemetry.recordAction({ actionType: action.type, outcome: result.status, durationMs });

        const updatedAttempt = await deps.runs.updateActionAttempt(scope, Object.freeze({
          ...attempt,
          status: attemptStatusOf(result),
          updatedAt: actionEndedAt
        }));
        if (updatedAttempt !== "updated") {
          deps.telemetry.logRun("warn", "Action outcome rejected: attempt record is no longer writable.", { ...base, actionIndex, errorCode: "STALE_ACTION_ATTEMPT" });
          return;
        }

        if (result.status === "succeeded") {
          deps.telemetry.logRun("info", "Action succeeded.", {
            ...base, actionIndex, actionType: action.type, durationMs
          });
          continue;
        }

        const fields: AutomationLogFields = {
          ...base, actionIndex, actionType: action.type, durationMs, errorCode: result.failure.code
        };
        if (aborted()) {
          deps.telemetry.logRun("warn", "Action interrupted by lease loss or shutdown.", fields);
          return;
        }
        deps.telemetry.logRun("warn", "Action failed.", fields);
        if (result.failure.errorClass === "transient") {
          await retryOrFail(result.failure.code, action.type);
          return;
        }
        // Permanent: stop. Ambiguous: the attempt is unknown_outcome and is never repeated blindly.
        await finish("failed", result.failure.code);
        return;
      }

      await finish("completed");
    };

    try {
      await execute();
    } catch (error) {
      deps.telemetry.logFailure("Run execution failed unexpectedly.", error, base);
      throw error;
    }
  };
};
