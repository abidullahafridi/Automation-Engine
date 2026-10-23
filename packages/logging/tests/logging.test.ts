import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { DestinationStream } from "pino";
import { createLogger } from "../src/index.js";

const isLogEntry = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

void test("writes machine-readable JSON application logs", () => {
  const messages: string[] = [];
  const destination: DestinationStream = { write: (message: string) => { messages.push(message); } };
  const logger = createLogger({ service: "test-service", destination });
  logger.info("runtime ready", { port: 4000 });
  const entry: unknown = JSON.parse(messages[0] ?? "null");
  assert.deepEqual(isLogEntry(entry) ? {
    service: entry.service,
    message: entry.msg,
    port: entry.port
  } : null, { service: "test-service", message: "runtime ready", port: 4000 });
});

void test("writes readable structured terminal logs", () => {
  const messages: string[] = [];
  const destination = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      messages.push(chunk.toString("utf8"));
      callback();
    }
  });
  const logger = createLogger({
    service: "test-service",
    destination,
    format: "pretty",
    colorize: false
  });

  logger.info("API server started.", { host: "127.0.0.1", port: 4000 });

  const output = messages.join("");
  assert.match(output, /INFO.*\(test-service\): API server started\./);
  assert.match(output, /host: "127\.0\.0\.1"/);
  assert.match(output, /port: 4000/);
  assert.doesNotMatch(output, /^\{/);
});
