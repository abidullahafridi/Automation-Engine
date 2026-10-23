import test from "node:test";
import assert from "node:assert/strict";
import type { Logger } from "@workspace/logging";
import { createShutdown } from "../bootstrap/index.js";

void test("graceful shutdown stops HTTP traffic before disconnecting persistence", async (): Promise<void> => {
  const calls: string[] = [];
  const logger: Logger = {
    info: (message, context): void => { calls.push(`${message}:${String(context?.signal)}`); },
    warn: (): void => undefined,
    error: (): void => undefined
  };
  const shutdown = createShutdown({
    logger,
    server: { stop: (): Promise<void> => { calls.push("server:stop"); return Promise.resolve(); } },
    database: { disconnect: (): Promise<void> => { calls.push("database:disconnect"); return Promise.resolve(); } }
  });

  await shutdown("SIGTERM");

  assert.deepEqual(calls, [
    "API shutdown requested.:SIGTERM",
    "server:stop",
    "database:disconnect"
  ]);
});
