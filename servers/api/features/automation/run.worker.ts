/**
 * Run worker loop — AE-T-030.2.
 *
 * Claims one run at a time for a trusted workspace scope, heartbeats the lease while the
 * handler runs, aborts the handler if the lease is lost, and shuts down gracefully:
 * no new claims, grace period for in-flight runs, then controlled interruption.
 * The executor (AE-T-031.1) plugs in as the handler and owns run/action completion.
 */
import type { WorkspaceScope } from "./automation.ports.js";
import type { Clock } from "./automation.service.js";
import type { RunRepository, StoredRun } from "./run.repository.js";

export type RunHandlerContext = Readonly<{
  scope: WorkspaceScope;
  run: StoredRun;
  /** Aborted on lease loss or shutdown timeout. Handlers must stop promptly. */
  signal: AbortSignal;
}>;

export type RunHandler = (context: RunHandlerContext) => Promise<void>;

export type Scheduler = Readonly<{
  every: (intervalMs: number, callback: () => void) => () => void;
}>;

const intervalScheduler: Scheduler = Object.freeze({
  every: (intervalMs, callback) => {
    const timer = setInterval(callback, intervalMs);
    return () => { clearInterval(timer); };
  }
});

export type TickOutcome = "idle" | "stopped" |"paused" | "processed" | "lease_lost" | "handler_error";

export type ShutdownReport = Readonly<{
  drained: number;
  interrupted: number;
  notInterrupted: number;
}>;

type InFlight = Readonly<{
  runId: string;
  fencingToken: number;
  controller: AbortController;
  done: Promise<void>;
}>;

export const createRunWorker = ({
  scope,
  workerId,
  runs,
  handler,
  clock,
  leaseDurationMs,
  renewIntervalMs,
  scheduler = intervalScheduler,
  claimGate
}: Readonly<{
  scope: WorkspaceScope;
  workerId: string;
  runs: RunRepository;
  handler: RunHandler;
  clock: Clock;
  leaseDurationMs: number;
  /** Rule of thumb: leaseDurationMs / 3. */
  renewIntervalMs: number;
  scheduler?: Scheduler;
  /** Release gate / kill switch. Must never throw; a throw is treated as closed. */
  claimGate?: () => Promise<boolean>;
}>) => {
  const inFlight = new Map<string, InFlight>();
  let shuttingDown = false;
  // A function call (not a variable read) so TypeScript does not narrow it across awaits.
  const stopping = (): boolean => shuttingDown;

  const gateOpen = async (): Promise<boolean> => {
    if (claimGate === undefined) return true;
    try {
      return await claimGate();
    } catch {
      return false;
    }
  };

  const tick = async (): Promise<TickOutcome> => {
    if (stopping()) return "stopped";
    if (!await gateOpen()) return "paused";
    const claim = await runs.claimNext(scope, workerId, clock.now(), leaseDurationMs);
    if (claim.kind === "none") return "idle";
    const run = claim.run;

    // Shutdown may have started while the claim was in flight: hand the run straight back.
    if (stopping()) {
      await runs.interruptRun(scope, run.runId, run.fencingToken, clock.now(), "WORKER_SHUTDOWN");
      return "stopped";
    }

    const controller = new AbortController();
    const flags = { leaseLost: false, handlerFailed: false };

    const stopHeartbeat = scheduler.every(renewIntervalMs, () => {
      void runs.renewLease(scope, run.runId, workerId, run.fencingToken, clock.now(), leaseDurationMs)
        .then((result) => {
          if (result.kind === "stale") {
            flags.leaseLost = true;
            controller.abort();
          }
        })
        .catch(() => {
          // Transient storage error: keep working. If the lease really lapses, the next renew or the reaper decides.
        });
    });

    const done = (async (): Promise<void> => {
      try {
        await handler({ scope, run, signal: controller.signal });
      } catch {
        // Leave state untouched; the lease expires and the reaper recovers the run.
        flags.handlerFailed = true;
      } finally {
        stopHeartbeat();
        inFlight.delete(run.runId);
      }
    })();

    inFlight.set(run.runId, { runId: run.runId, fencingToken: run.fencingToken, controller, done });
    await done;

    if (flags.leaseLost) return "lease_lost";
    return flags.handlerFailed ? "handler_error" : "processed";
  };

  const shutdown = async ({ graceMs }: Readonly<{ graceMs: number }>): Promise<ShutdownReport> => {
    shuttingDown = true;
    const pending = [...inFlight.values()];
    if (pending.length === 0) return Object.freeze({ drained: 0, interrupted: 0, notInterrupted: 0 });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); });
    await Promise.race([Promise.allSettled(pending.map((item) => item.done)), timeout]);
    if (timer !== undefined) clearTimeout(timer);

    const stillRunning = pending.filter((item) => inFlight.has(item.runId));
    let interrupted = 0;
    let notInterrupted = 0;
    for (const item of stillRunning) {
      item.controller.abort();
      const result = await runs.interruptRun(scope, item.runId, item.fencingToken, clock.now(), "WORKER_SHUTDOWN");
      if (result === "requeued") interrupted += 1;
      else notInterrupted += 1; // already settled or lease moved on
    }
    return Object.freeze({ drained: pending.length - stillRunning.length, interrupted, notInterrupted });
  };

  return Object.freeze({
    tick,
    shutdown,
    isShuttingDown: stopping,
    inFlightCount: () => inFlight.size
  });
};

export type RunWorker = ReturnType<typeof createRunWorker>;