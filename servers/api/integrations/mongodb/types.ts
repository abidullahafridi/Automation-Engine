import type { Connection } from "mongoose";

export type MongoDatabase = NonNullable<Connection["db"]>;

export type TransactionSession = unknown;

export type TransactionOperation<TResult> = (session: unknown) => Promise<TResult>;

export type TransactionRunner = Readonly<{
  runTransaction: <TResult>(
    operation: (session: unknown) => Promise<TResult>,
    options?: Readonly<{ maxRetries?: number }>
  ) => Promise<Readonly<{ ok: true; value: TResult }> | Readonly<{ ok: false; kind: "transaction-failed"; error: unknown }>>;
}>;

export type MongoClient = Readonly<{
  connect: (uri: string) => Promise<unknown>;
  disconnect: () => Promise<void>;
  database?: () => MongoDatabase | undefined;
  transactionRunner?: () => TransactionRunner | undefined;
}>;

export type MongoDbIntegration = Readonly<{
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  database: () => MongoDatabase | undefined;
  transactionRunner: () => TransactionRunner | undefined;
}>;
