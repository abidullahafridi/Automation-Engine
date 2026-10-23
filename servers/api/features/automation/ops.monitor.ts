import type { WorkspaceScope } from "./automation.ports.js";
import type { Clock } from "./automation.service.js";
import {
  evaluateAlerts,
  type Alert,
  type AlertEvaluation,
  type AlertThresholds
} from "./ops.alerts.js";
import { collectOpsSignals, type OpsSignalSources } from "./ops.signals.js";

export type AlertTransition = Readonly<{
  kind: "firing" | "resolved";
  workspaceId: string;
  alert: Alert;
}>;

/** Adapter point for paging/ticketing. Failures are swallowed and retried on the next tick. */
export type AlertSink = Readonly<{
  notify: (transition: AlertTransition) => Promise<void>;
}>;

export type MonitorTick = Readonly<{
  evaluation: AlertEvaluation;
  /** Only transitions that were delivered. */
  transitions: readonly AlertTransition[];
  sinkFailures: number;
}>;

export type OpsMonitor = Readonly<{
  tick: (scope: WorkspaceScope) => Promise<MonitorTick>;
}>;

export const createOpsMonitor = ({
  ownsScope,
  sources,
  thresholds,
  sink,
  clock
}: Readonly<{
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
  sources: OpsSignalSources;
  thresholds: AlertThresholds;
  sink: AlertSink;
  clock: Clock;
}>): OpsMonitor => {
  // Alerts already delivered, per workspace and dedupe key. Only a delivered transition updates it.
  const active = new Map<string, Map<string, Alert>>();

  const deliver = async (transition: AlertTransition): Promise<boolean> => {
    try {
      await sink.notify(transition);
      return true;
    } catch {
      return false;
    }
  };

  return Object.freeze({
    tick: async (scope: WorkspaceScope): Promise<MonitorTick> => {
      const signals = await collectOpsSignals({ ownsScope, sources, scope, now: clock.now() });
      const evaluation = evaluateAlerts(signals, thresholds);
      const workspaceId = scope.workspaceId;

      const state = active.get(workspaceId) ?? new Map<string, Alert>();
      active.set(workspaceId, state);

      const transitions: AlertTransition[] = [];
      let sinkFailures = 0;
      const current = new Set<string>();

      for (const alert of evaluation.alerts) {
        current.add(alert.dedupeKey);
        const previous = state.get(alert.dedupeKey);
        if (previous !== undefined && previous.level === alert.level) continue;
        const transition: AlertTransition = Object.freeze({ kind: "firing" as const, workspaceId, alert });
        if (await deliver(transition)) {
          state.set(alert.dedupeKey, alert);
          transitions.push(transition);
        } else {
          sinkFailures += 1;
        }
      }

      for (const [key, previous] of [...state.entries()]) {
        if (current.has(key)) continue;
        const transition: AlertTransition = Object.freeze({
          kind: "resolved" as const,
          workspaceId,
          alert: previous
        });
        if (await deliver(transition)) {
          state.delete(key);
          transitions.push(transition);
        } else {
          sinkFailures += 1;
        }
      }

      return Object.freeze({ evaluation, transitions: Object.freeze(transitions), sinkFailures });
    }
  });
};