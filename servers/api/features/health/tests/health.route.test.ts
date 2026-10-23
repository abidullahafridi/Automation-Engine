import { createServer } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { HTTP_STATUS } from "../../../constants/index.js";
import { createHealthRoutes } from "../index.js";

void test("GET /health exposes the composed feature behavior", async (context) => {
  const app = express();
  app.use(createHealthRoutes({ environment: "test", serviceName: "api" }));
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  context.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${String(address.port)}/health`);

  assert.equal(response.status, HTTP_STATUS.ok);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "api",
    environment: "test"
  });
});
