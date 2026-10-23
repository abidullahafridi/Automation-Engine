import test from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "@workspace/logging";
import { createMongoDbIntegration, type MongoClient } from "../integrations/index.js";

void test("keeps persistence optional when MongoDB is not configured", async (): Promise<void> => {
  const messages: string[] = [];
  const logger: Logger = {
    info: (message): void => { messages.push(message); },
    warn: (): void => undefined,
    error: (): void => undefined
  };
  const integration = createMongoDbIntegration({ logger });

  await integration.connect();
  await integration.disconnect();

  assert.deepEqual(messages, ["MongoDB connection is not configured; starting without persistence."]);
});

void test("composes the server-owned MongoDB integration when configured", async (): Promise<void> => {
  const calls: string[] = [];
  const client: MongoClient = {
    connect: (uri): Promise<void> => {
      calls.push(`connect:${uri}`);
      return Promise.resolve();
    },
    disconnect: (): Promise<void> => {
      calls.push("disconnect");
      return Promise.resolve();
    }
  };
  const logger: Logger = {
    info: (message): void => { calls.push(`log:${message}`); },
    warn: (): void => undefined,
    error: (): void => undefined
  };
  const integration = createMongoDbIntegration({
    uri: "mongodb://example.test/workspace",
    client,
    logger
  });

  await integration.connect();
  await integration.disconnect();

  assert.deepEqual(calls, [
    "connect:mongodb://example.test/workspace",
    "log:MongoDB connection established.",
    "disconnect"
  ]);
});
