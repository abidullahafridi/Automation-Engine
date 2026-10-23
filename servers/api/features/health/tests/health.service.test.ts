import test from "node:test";
import assert from "node:assert/strict";
import { createHealthService } from "../services/index.js";

void test("health service reports its injected runtime identity", () => {
  const service = createHealthService({ environment: "test", serviceName: "api" });

  assert.deepEqual(service.getHealth(), {
    status: "ok",
    service: "api",
    environment: "test"
  });
});
