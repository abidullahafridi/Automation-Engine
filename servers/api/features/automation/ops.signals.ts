import type { WorkspaceScope } from "./automation.ports.js";
import type { OutboxRepository } from "./outbox.repository.js";
import type { DeadLetterBacklog } from "./run.repository.js";

/** Health of the run queue (spec 14.2 gauges). Measured by a read-only adapter. */
export type RunQueueHealth = Readonly<{
  queuedCount: number;
  /** Age of the oldest queued run that is already eligible (runAfter <= now). Undefined when none. */
  oldestEligibleAgeMs: number | undefined;
  /** Runs still marked running whose lease expired and were not recovered yet (reaper or worker fault). */
  expiredRunningCount: number;
}>;

export type RunQueueHealthPort = Readonly<{
  read: (scope: WorkspaceScope, now: string) => Promise<RunQueueHealth>;
}>;

export type OutboxHealth = Readonly<{
  pendingCount: number;
  oldestPendingAgeMs: number | undefined;
}>;

export type SignalSource<T> = (scope: WorkspaceScope, now: string) => Promise<T>;

export const opsSignalNames = Object.freeze(["queue", "outbox", "deadLetter", "tenantScope"] as const);
export type OpsSignalName = (typeof opsSignalNames)[number];

/** A source that is not provided is "unmonitored". A source that throws is "failed". */
export type OpsSignalSources = Readonly<{
  queue?: SignalSource<RunQueueHealth>;
  outbox?: SignalSource<OutboxHealth>;
  deadLetter?: SignalSource<DeadLetterBacklog>;
  /** Number of tenant-scope violations observed. Must stay 0. */
  tenantScope?: SignalSource<number>;
}>;

export type OpsSignals = Readonly<{
  collectedAt: string;
  queue: RunQueueHealth | undefined;
  outbox: OutboxHealth | undefined;
  deadLetter: DeadLetterBacklog | undefined;
  tenantScopeViolations: number | undefined;
  /** Sources that were configured but threw. Blind monitoring is itself a fault. */
  failed: readonly OpsSignalName[];
}>;

export const createOutboxHealthSource = (outbox: OutboxRepository): SignalSource<OutboxHealth> =>
  async (scope, now) => {
    const [pendingCount, oldestPendingAgeMs] = await Promise.all([
      outbox.countByStatus(scope, "pending"),
      outbox.getOldestPendingAgeMs(scope, now)
    ]);
    return Object.freeze({ pendingCount, oldestPendingAgeMs });
  };

const isCount = (value: number): boolean => Number.isFinite(value) && value >= 0;

/** Never throws for a failing source. An invalid scope throws, like every repository. */
export const collectOpsSignals = async ({
  ownsScope,
  sources,
  scope,
  now
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  sources: OpsSignalSources;
  scope: WorkspaceScope;
  now: string;
}>): Promise<OpsSignals> => {
  if (!ownsScope(scope)) throw new Error("A resolver-minted workspace scope is required.");

  const failed = new Set<OpsSignalName>();
  const read = async <T>(
    name: OpsSignalName,
    source: SignalSource<T> | undefined
  ): Promise<T | undefined> => {
    if (source === undefined) return undefined;
    try {
      return await source(scope, now);
    } catch {
      failed.add(name);
      return undefined;
    }
  };

  const [queue, outbox, deadLetter, tenantScope] = await Promise.all([
    read("queue", sources.queue),
    read("outbox", sources.outbox),
    read("deadLetter", sources.deadLetter),
    read("tenantScope", sources.tenantScope)
  ]);

  let tenantScopeViolations: number | undefined = tenantScope;
  if (tenantScopeViolations !== undefined && !isCount(tenantScopeViolations)) {
    failed.add("tenantScope");
    tenantScopeViolations = undefined;
  }

  return Object.freeze({
    collectedAt: now,
    queue,
    outbox,
    deadLetter,
    tenantScopeViolations,
    failed: Object.freeze(opsSignalNames.filter((name) => failed.has(name)))
  });
};