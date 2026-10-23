/**
 * Outbox transactional write service — ADR-0003
 *
 * Wraps domain mutations with a MongoDB multi-document transaction that also writes the
 * outbox record. Uses majority write concern, retries transient transaction errors, and
 * increments an abort counter for observability.
 *
 * Production feature flag: callers must check that outbox is enabled before calling this.
 */

import type { TransactionRunner } from "../../integrations/index.js";
import {
  getTransactionAbortCount,
  resetTransactionAbortCount
} from "../../integrations/index.js";
import type { WorkspaceScope } from "./automation.ports.js";
import type { OutboxRepository } from "./outbox.repository.js";

export { getTransactionAbortCount, resetTransactionAbortCount };

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

export type OutboxEventInput = Readonly<{
  outboxId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}>;

export type TransactionalOutboxWriteInput<TResult> = Readonly<{
  scope: WorkspaceScope;
  outboxEvent: OutboxEventInput;
  /**
   * The domain mutation to perform inside the transaction.
   * Receives the active session so it can pass it to any collection operations.
   */
  domainMutation: (session: unknown) => Promise<TResult>;
  outboxRepository: OutboxRepository;
  transactionRunner: TransactionRunner;
  /** Maximum number of retry attempts on transient errors (default: 3). */
  maxRetries?: number;
}>;

export type TransactionalOutboxWriteResult<TResult> =
  | Readonly<{ ok: true; domainResult: TResult }>
  | Readonly<{ ok: false; kind: "transaction-failed"; error: unknown }>;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Execute domainMutation and outbox insert in a single MongoDB multi-document transaction.
 * Delegates transaction lifecycle, commit/retry, and abort counting to TransactionRunner
 * provided by the integration layer.
 */
export const writeWithTransactionalOutbox = async <TResult>(
  input: TransactionalOutboxWriteInput<TResult>
): Promise<TransactionalOutboxWriteResult<TResult>> => {
  const {
    scope,
    outboxEvent,
    domainMutation,
    outboxRepository,
    transactionRunner,
    maxRetries = 3
  } = input;

  const result = await transactionRunner.runTransaction(
    async (session) => {
      // 1. Domain mutation participates in this session's transaction
      const domainResult = await domainMutation(session);

      // 2. Outbox insert in the same transaction
      await outboxRepository.insertPending(
        scope,
        {
          outboxId: outboxEvent.outboxId,
          workspaceId: scope.workspaceId,
          eventType: outboxEvent.eventType,
          payload: outboxEvent.payload,
          createdAt: outboxEvent.createdAt
        },
        session
      );

      return domainResult;
    },
    { maxRetries }
  );

  if (result.ok) {
    return Object.freeze({ ok: true, domainResult: result.value });
  }

  return Object.freeze({
    ok: false,
    kind: "transaction-failed",
    error: result.error
  });
};


