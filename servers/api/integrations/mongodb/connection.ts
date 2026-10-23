import mongoose from "mongoose";
import type { Logger } from "@workspace/logging";
import type { MongoClient, MongoDbIntegration, TransactionRunner } from "./types.js";

type MongoDbIntegrationDependencies = Readonly<{
  uri?: string;
  logger: Logger;
  client?: MongoClient;
}>;

const TRANSIENT_TRANSACTION_ERROR_LABEL = "TransientTransactionError";
const UNKNOWN_TRANSACTION_COMMIT_RESULT_LABEL = "UnknownTransactionCommitResult";

let transactionAbortCount = 0;

export const getTransactionAbortCount = (): number => transactionAbortCount;
export const resetTransactionAbortCount = (): void => { transactionAbortCount = 0; };

const isTransient = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const labels: unknown = (error as Record<string, unknown>)["errorLabels"];
  if (!Array.isArray(labels)) return false;
  return (
    labels.includes(TRANSIENT_TRANSACTION_ERROR_LABEL) ||
    labels.includes(UNKNOWN_TRANSACTION_COMMIT_RESULT_LABEL)
  );
};

export const createMongooseTransactionRunner = (): TransactionRunner => ({
  runTransaction: async <TResult>(
    operation: (session: unknown) => Promise<TResult>,
    options?: Readonly<{ maxRetries?: number }>
  ): Promise<
    | Readonly<{ ok: true; value: TResult }>
    | Readonly<{ ok: false; kind: "transaction-failed"; error: unknown }>
  > => {
    const maxRetries = options?.maxRetries ?? 3;
    const client = mongoose.connection.getClient();
    const session = client.startSession();

    let attempt = 0;
    try {
      while (attempt <= maxRetries) {
        attempt += 1;
        session.startTransaction({
          writeConcern: { w: "majority" },
          readConcern: { level: "snapshot" }
        });
        try {
          const value = await operation(session);

          for (let commitAttempt = 0; commitAttempt <= maxRetries; commitAttempt += 1) {
            try {
              await session.commitTransaction();
              return Object.freeze({ ok: true, value });
            } catch (commitError) {
              if (isTransient(commitError) && commitAttempt < maxRetries) {
                continue;
              }
              throw commitError;
            }
          }
          throw new Error("Transaction commit retry loop exited unexpectedly.");
        } catch (transactionError) {
          transactionAbortCount += 1;
          await session.abortTransaction().catch(() => undefined);
          if (isTransient(transactionError) && attempt <= maxRetries) {
            continue;
          }
          return Object.freeze({ ok: false, kind: "transaction-failed" as const, error: transactionError });
        }
      }

      return Object.freeze({
        ok: false,
        kind: "transaction-failed",
        error: new Error("Transaction exceeded maximum retry attempts.")
      });
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }
});

const defaultTransactionRunner = createMongooseTransactionRunner();

const mongooseClient: MongoClient = Object.freeze({
  connect: (uri: string): Promise<unknown> => mongoose.connect(uri),
  disconnect: (): Promise<void> => mongoose.disconnect(),
  database: () => mongoose.connection.db,
  transactionRunner: () => defaultTransactionRunner
});

export const createMongoDbIntegration = ({
  uri,
  logger,
  client = mongooseClient
}: MongoDbIntegrationDependencies): MongoDbIntegration => {
  if (!uri) {
    return Object.freeze({
      connect: (): Promise<void> => {
        logger.info("MongoDB connection is not configured; starting without persistence.");
        return Promise.resolve();
      },
      database: () => undefined,
      disconnect: (): Promise<void> => Promise.resolve(),
      transactionRunner: () => undefined
    });
  }

  return Object.freeze({
    connect: async (): Promise<void> => {
      await client.connect(uri);
      logger.info("MongoDB connection established.");
    },
    disconnect: async (): Promise<void> => {
      await client.disconnect();
    },
    database: () => client.database?.(),
    transactionRunner: () => client.transactionRunner?.()
  });
};
