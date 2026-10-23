import type { WorkspaceScope } from "./automation.ports.js";
import type { AuditRecorder } from "./audit.recorder.js";

export type ReleaseActor = Readonly<{ type: "user" | "system"; id: string }>;
export type ReleaseChange = "rollout" | "killswitch.engage" | "killswitch.release";
export type ReleaseAuditDetails = Readonly<Record<string, string | number | boolean | null>>;

export type ReleaseAuditEvent = Readonly<{
  actor: ReleaseActor;
  change: ReleaseChange;
  /** Flag name, or "killswitch". */
  target: string;
  outcome: "succeeded" | "denied";
  occurredAt: string;
  correlationId: string;
  /** Scalar values only. The recorder scrubs and bounds them again. */
  details: ReleaseAuditDetails;
}>;

export type ReleaseAuditPort = Readonly<{
  append: (event: ReleaseAuditEvent) => Promise<void>;
}>;

export type InMemoryReleaseAuditStore = Readonly<{
  port: ReleaseAuditPort;
  events: () => readonly ReleaseAuditEvent[];
}>;

export const createInMemoryReleaseAuditStore = (): InMemoryReleaseAuditStore => {
  const recorded: ReleaseAuditEvent[] = [];
  return Object.freeze({
    port: Object.freeze({
      append: (event: ReleaseAuditEvent): Promise<void> => {
        recorded.push(Object.freeze({
          actor: Object.freeze({ type: event.actor.type, id: event.actor.id }),
          change: event.change,
          target: event.target,
          outcome: event.outcome,
          occurredAt: event.occurredAt,
          correlationId: event.correlationId,
          details: Object.freeze({ ...event.details })
        }));
        return Promise.resolve();
      }
    }),
    events: (): readonly ReleaseAuditEvent[] => Object.freeze([...recorded])
  });
};

/**
 * Durable adapter over the existing append-only audit log. The log is workspace-scoped, so the
 * composition root supplies the trusted scope of the platform operations workspace.
 */
export const createRecorderReleaseAuditPort = ({
  recorder,
  scope
}: Readonly<{ recorder: AuditRecorder; scope: WorkspaceScope }>): ReleaseAuditPort => Object.freeze({
  append: async (event: ReleaseAuditEvent): Promise<void> => {
    const result = await recorder.record(scope, {
      // Deterministic id: a retried append of the same change is idempotent.
      recordId: `release-${event.correlationId}`,
      actor: { type: event.actor.type, id: event.actor.id },
      action: "flag.change",
      target: { type: "flag", id: event.target },
      outcome: event.outcome,
      correlationId: event.correlationId,
      occurredAt: event.occurredAt,
      details: { change: event.change, ...event.details }
    });
    if (result.kind === "rejected" || result.kind === "unavailable") {
      throw new Error("Release audit record could not be stored.");
    }
  }
});