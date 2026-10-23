import type { LoopGuardTelemetry, LoopSignal } from "./loop.guard.js";
import type {
  QuotaDenialCode,
  QuotaNearLimitSignal,
  QuotaRejectionSignal,
  QuotaTelemetry
} from "./quota.service.js";
import type { MetricsPort } from "./telemetry.metrics.js";
import { redactError, redactValue } from "./telemetry.redaction.js";
import { parseTraceparent } from "./telemetry.trace.js";

/**
 * Minimal log sink. Structurally compatible with the Logger from @workspace/logging
 * (info/warn/error with a message and a context object).
 */
export type TelemetryLogger = Readonly<{
  info: (message: string, context: Readonly<Record<string, unknown>>) => void;
  warn: (message: string, context: Readonly<Record<string, unknown>>) => void;
  error: (message: string, context: Readonly<Record<string, unknown>>) => void;
}>;

/** Spec 14.1 required fields. Anything else is dropped. */
export type AutomationLogFields = Readonly<{
  workspaceId?: string;
  automationId?: string;
  automationVersion?: number;
  runId?: string;
  actionIndex?: number;
  actionType?: string;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
  traceId?: string;
  attempt?: number;
  durationMs?: number;
  errorCode?: string;
  retryDecision?: string;
  fencingToken?: number;
  runAfter?: string;
  delayMs?: number;
}>;

const logFieldKeys = [
  "workspaceId", "automationId", "automationVersion", "runId", "actionIndex", "actionType",
  "eventId", "correlationId", "causationId", "traceId", "attempt", "durationMs",
  "errorCode", "retryDecision", "fencingToken", "runAfter", "delayMs"
] as const satisfies readonly (keyof AutomationLogFields)[];

export const toLogContext = (fields: AutomationLogFields): Readonly<Record<string, unknown>> => {
  const context: Record<string, unknown> = {};
  for (const key of logFieldKeys) {
    const value = fields[key];
    if (value !== undefined) context[key] = redactValue(value);
  }
  return Object.freeze(context);
};

/** Trace id to put in log fields when a record carries a traceparent. */
export const traceIdOf = (traceparent: string | undefined): string | undefined =>
  parseTraceparent(traceparent)?.traceId;

const quotaLabel: Readonly<Record<QuotaDenialCode, string>> = {
  SCOPE_MISSING: "scope",
  WORKSPACE_QUOTA_EXCEEDED: "workspace",
  GLOBAL_QUOTA_EXCEEDED: "global",
  QUOTA_UNAVAILABLE: "unavailable"
};

/** Telemetry must never throw and never change a business decision. */
const safely = (action: () => void): void => {
  try {
    action();
  } catch {
    // A failing sink is not allowed to affect execution.
  }
};

export type ActionRecord = Readonly<{
  actionType: string;
  outcome: string;
  durationMs: number;
}>;

export const createAutomationTelemetry = ({
  logger,
  metrics
}: Readonly<{
  logger: TelemetryLogger;
  metrics: MetricsPort;
}>) => {
  const loopGuardTelemetry: LoopGuardTelemetry = Object.freeze({
    tripped: (signal: LoopSignal): void => {
      safely(() => {
        metrics.increment("automation_loop_guard_trips_total", { reason: signal.code });
      });
      safely(() => {
        logger.warn("Automation loop guard tripped.", toLogContext({
          workspaceId: signal.workspaceId,
          automationId: signal.automationId,
          eventId: signal.eventId,
          errorCode: signal.code
        }));
      });
    }
  });

  const quotaTelemetry: QuotaTelemetry = Object.freeze({
    rejected: (signal: QuotaRejectionSignal): void => {
      safely(() => {
        metrics.increment("automation_quota_rejections_total", { quota: quotaLabel[signal.code] });
      });
      safely(() => {
        logger.warn("Automation quota rejected work.", toLogContext({
          workspaceId: signal.workspaceId,
          errorCode: signal.code
        }));
      });
    },
    nearLimit: (signal: QuotaNearLimitSignal): void => {
      safely(() => {
        logger.info("Workspace automation quota is near its limit.", Object.freeze({
          ...toLogContext({ workspaceId: signal.workspaceId }),
          quota: signal.kind,
          used: signal.used,
          limit: signal.limit
        }));
      });
    }
  });

  return Object.freeze({
    loopGuardTelemetry,
    quotaTelemetry,
    logRun: (level: "info" | "warn", message: string, fields: AutomationLogFields): void => {
      safely(() => { logger[level](message, toLogContext(fields)); });
    },
    /** Exception path: the error is reduced to name, code and a scrubbed message. No stack. */
    logFailure: (message: string, error: unknown, fields: AutomationLogFields): void => {
      safely(() => {
        logger.error(message, Object.freeze({
          ...toLogContext(fields),
          error: error instanceof Error ? redactError(error) : redactValue(error)
        }));
      });
    },
    recordEvent: (eventType: string, result: string): void => {
      safely(() => { metrics.increment("automation_events_total", { event_type: eventType, result }); });
    },
    recordRun: (status: string, triggerType: string): void => {
      safely(() => { metrics.increment("automation_runs_total", { status, trigger_type: triggerType }); });
    },
    recordRunDuration: (status: string, durationMs: number): void => {
      safely(() => { metrics.observe("automation_run_duration_seconds", { status }, durationMs / 1000); });
    },
    recordAction: (record: ActionRecord): void => {
      safely(() => {
        metrics.increment("automation_action_attempts_total", {
          action_type: record.actionType,
          outcome: record.outcome
        });
      });
      safely(() => {
        metrics.observe("automation_action_duration_seconds", { action_type: record.actionType }, record.durationMs / 1000);
      });
    },
    recordRetry: (actionType: string, reason: string): void => {
      safely(() => { metrics.increment("automation_retries_total", { action_type: actionType, reason }); });
    }
  });
};

export type AutomationTelemetry = ReturnType<typeof createAutomationTelemetry>;
