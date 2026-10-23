import test from "node:test";
import assert from "node:assert/strict";
import { createApiConfiguration } from "../config/api";
import { readWebEnvironment } from "../config/env";

test("derives API configuration from validated environment input", () => {
  const environment = readWebEnvironment({ NEXT_PUBLIC_API_BASE_URL: "https://api.example.test" });
  assert.deepEqual(createApiConfiguration(environment), { baseUrl: "https://api.example.test" });
});

test("rejects an invalid API URL", () => {
  assert.throws(() => readWebEnvironment({ NEXT_PUBLIC_API_BASE_URL: "not-a-url" }));
});

test("requires the API URL from the environment", () => {
  assert.throws(() => readWebEnvironment({}), /NEXT_PUBLIC_API_BASE_URL/);
});
