import { createActionExecutor } from "./action.executor.js";
import type { ActionHandlerRegistry } from "./action.handler.js";
import { createLifecycleAuditPort } from "./audit.adapters.js";
import { createAuditRecorder } from "./audit.recorder.js";
import { createMongoAuditLog } from "./audit.repository.js";
import type { PolicyPort, WorkspaceScope } from "./automation.ports.js";
import { createMongoAutomationRepository } from "./automation.mongo-repository.js";
import type { Clock, Rng } from "./automation.service.js";
import { createAutomationTelemetry, type TelemetryLogger } from "./automation.telemetry.js";
import { createExecutionContextResolver, type CreatorStandingPort } from "./execution.context.js";
import { createLoopGuard, type LoopGuardLimits } from "./loop.guard.js";
import { createMongoQuotaStores } from "./quota.repository.js";
import { createQuotaService, type QuotaConfig, type QuotaOverridePort } from "./quota.service.js";
import { createRunExecutionHandler, type AutomationPauser } from "./run.execution.js";
import { createMongoRunRepository, type RecoveredRun } from "./run.repository.js";
import { createRunWorker } from "./run.worker.js";
import type { ReleaseGate } from "./release.gate.js";
import type { MetricsPort } from "./telemetry.metrics.js";
import { createTraceFactory, type TraceFactory } from "./telemetry.trace.js";
import { createMongoTriggerMatcher } from "./trigger.matcher.js";

/** Same handle the Mongo repositories take; derived so this file never imports the driver or integrations. */
type DatabaseHandle = Parameters<typeof createMongoRunRepository>[0]["database"];

/** Spec section 3.4 technical defaults. Tune by test. */
export const defaultLeaseDurationMs = 60_000;
export const defaultRenewIntervalMs = 20_000;
const recoveryBatchSize = 50;

export type AutomationRuntimeDependencies = Readonly<{
  database: DatabaseHandle;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  policy: PolicyPort;
  /** Required: release flags and kill switch gate both intake and new worker claims. */
  releaseGate: ReleaseGate;
  creators: CreatorStandingPort;
  handlers: ActionHandlerRegistry;
  /** Adapt @workspace/logging's Logger to this shape at the composition root. */
  logger: TelemetryLogger;
  metrics: MetricsPort;
  clock: Clock;
  ids: Rng;
  traces?: TraceFactory;
  pauser?: AutomationPauser;
  quotaOverrides?: QuotaOverridePort;
  quotaConfig?: QuotaConfig;
  loopLimits?: LoopGuardLimits;
  maxAttempts?: number;
}>;

export type WorkerOptions = Readonly<{
  workerId: string;
  leaseDurationMs?: number;
  renewIntervalMs?: number;
}>;

export const createAutomationRuntime = async (deps: AutomationRuntimeDependencies) => {
  const { database, ownsScope } = deps;
  const telemetry = createAutomationTelemetry({ logger: deps.logger, metrics: deps.metrics });
  const traces = deps.traces ?? createTraceFactory();

  const [automations, runs, auditLog, quotaStores] = await Promise.all([
    createMongoAutomationRepository({ database, ownsScope }),
    createMongoRunRepository({ database, ownsScope }),
    createMongoAuditLog({ database, ownsScope }),
    createMongoQuotaStores({ database, ownsScope })
  ]);

  const auditRecorder = createAuditRecorder({ ownsScope, log: auditLog, clock: deps.clock, ids: deps.ids });

  const quota = createQuotaService({
    ownsScope,
    counters: quotaStores.counters,
    clock: deps.clock,
    telemetry: telemetry.quotaTelemetry,
    ...(deps.quotaOverrides ? { overrides: deps.quotaOverrides } : {}),
    ...(deps.quotaConfig ? { config: deps.quotaConfig } : {})
  });

  const loopGuard = createLoopGuard({
    ownsScope,
    budget: quotaStores.chainBudget,
    telemetry: telemetry.loopGuardTelemetry,
    ...(deps.loopLimits ? { limits: deps.loopLimits } : {})
  });

  const matcher = await createMongoTriggerMatcher({
    database,
    ownsScope,
    protection: { loopGuard, quota },
    telemetry,
    intakeGate: deps.releaseGate.allowsIntake
  });

  const contexts = createExecutionContextResolver({ ownsScope, automations, creators: deps.creators });
  const executor = createActionExecutor({ ownsScope, policy: deps.policy, handlers: deps.handlers });
  const handler = createRunExecutionHandler({
    contexts,
    automations,
    runs,
    executor,
    telemetry,
    audit: auditRecorder,
    traces,
    clock: deps.clock,
    ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }),
    ...(deps.pauser ? { pauser: deps.pauser } : {})
  });

  /** One worker per trusted workspace scope. Scope must come from a trusted source (scheduler). */
  const createWorker = (scope: WorkspaceScope, options: WorkerOptions) => {
    const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
    const renewIntervalMs = options.renewIntervalMs ?? defaultRenewIntervalMs;
    if (renewIntervalMs >= leaseDurationMs) {
      throw new Error("renewIntervalMs must be smaller than leaseDurationMs.");
    }
    return createRunWorker({
      scope,
      workerId: options.workerId,
      runs,
      handler,
      clock: deps.clock,
      leaseDurationMs,
      renewIntervalMs,
      claimGate: deps.releaseGate.claimGateFor(scope)
    });
  };

  /** Reaper pass for one workspace. Schedule it from the process entrypoint. */
  const recoverExpired = async (scope: WorkspaceScope): Promise<readonly RecoveredRun[]> => {
    const recovered = await runs.recoverExpiredLeases(scope, deps.clock.now(), recoveryBatchSize);
    for (const item of recovered) {
      telemetry.logRun("warn", "Expired lease recovered.", {
        workspaceId: scope.workspaceId,
        runId: item.runId,
        fencingToken: item.previousFencingToken,
        errorCode: "LEASE_EXPIRED"
      });
    }
    return recovered;
  };

  return Object.freeze({
    matcher,
    telemetry,
    auditRecorder,
    auditLog,
    lifecycleAuditPort: createLifecycleAuditPort({ recorder: auditRecorder }),
    runs,
    automations,
    createWorker,
    recoverExpired
  });
};

export type AutomationRuntime = Awaited<ReturnType<typeof createAutomationRuntime>>;
