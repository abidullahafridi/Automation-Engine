/**
 * Outbox relay service — AE-T-020.2
 *
 * Implements the minimal relay processing loop:
 * - Claim next pending record (atomic lease).
 * - Hand to a publish handler (e.g. event dispatcher / bus).
 * - If handler succeeds, mark record published.
 * - If handler fails, the lease is allowed to expire (or optionally released early),
 *   allowing recovery by subsequent relay iterations.
 * - Processing is bounded by batch size and scoped to a workspace.
 * - Relay loop runs behind the outbox feature flag (default OFF).
 */

import type { WorkspaceScope } from "./automation.ports.js";
import type {
  ClaimOutboxResult,
  OutboxRecord,
  OutboxRepository
} from "./outbox.repository.js";

export type OutboxPublishHandler = (
  record: OutboxRecord
) => Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error?: unknown }>>;

export type ProcessOutboxBatchOptions = Readonly<{
  batchSize?: number;
  leaseDurationMs?: number;
}>;

export type ProcessOutboxBatchResult = Readonly<{
  processed: number;
  published: number;
  failed: number;
}>;

export type OutboxRelay = Readonly<{
  processNextBatch: (
    scope: WorkspaceScope,
    now: string,
    handler: OutboxPublishHandler,
    options?: ProcessOutboxBatchOptions
  ) => Promise<ProcessOutboxBatchResult>;
}>;

export const createOutboxRelay = ({
  outboxRepository,
  enabled = false
}: Readonly<{
  outboxRepository: OutboxRepository;
  enabled?: boolean;
}>): OutboxRelay => Object.freeze({
  processNextBatch: async (
    scope: WorkspaceScope,
    now: string,
    handler: OutboxPublishHandler,
    options?: ProcessOutboxBatchOptions
  ): Promise<ProcessOutboxBatchResult> => {
    if (!enabled) {
      return Object.freeze({ processed: 0, published: 0, failed: 0 });
    }

    const batchSize = Math.max(1, Math.min(options?.batchSize ?? 10, 100));
    const leaseDurationMs = options?.leaseDurationMs ?? 30_000;

    let processed = 0;
    let published = 0;
    let failed = 0;

    for (let i = 0; i < batchSize; i += 1) {
      const claimResult: ClaimOutboxResult = await outboxRepository.claimNextPending(
        scope,
        now,
        leaseDurationMs
      );

      if (claimResult.kind === "none") {
        break; // No more pending/expired records to claim
      }

      processed += 1;
      const record = claimResult.record;

      try {
        const handlerResult = await handler(record);
        if (handlerResult.ok) {
          await outboxRepository.markPublished(scope, record.outboxId, now);
          published += 1;
        } else {
          // Failure leaves the lease to expire (or recover after leaseExpiresAt)
          failed += 1;
        }
      } catch {
        // Crash / uncaught error in handler: lease will expire naturally
        failed += 1;
      }
    }

    return Object.freeze({ processed, published, failed });
  }
});

