import test from "node:test";
import assert from "node:assert/strict";
import { createApiConfig, readApiEnvironment } from "../config/index.js";

void test("derives API configuration from validated environment input", () => {
  const environment = readApiEnvironment({
    NODE_ENV: "production",
    API_HOST: "0.0.0.0",
    API_PORT: "8080",
    API_REQUEST_TIMEOUT_MS: "30000",
    WEB_ORIGIN: "https://example.test",
    MONGODB_URI: "mongodb://localhost:27017/automation",
    LOG_LEVEL: "warn"
  });
  assert.deepEqual(createApiConfig(environment), {
    environment: "production",
    host: "0.0.0.0",
    port: 8080,
    requestTimeoutMs: 30000,
    webOrigin: "https://example.test",
    automationApiEnabled: false,
    mongodbUri: "mongodb://localhost:27017/automation",
    logLevel: "warn"
  });
});

void test("automation API flag is enabled only by explicit true", () => {
  const enabled = createApiConfig(readApiEnvironment({
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "4000",
    API_REQUEST_TIMEOUT_MS: "30000",
    WEB_ORIGIN: "http://localhost:3000",
    AUTOMATION_API_ENABLED: "true",
    LOG_LEVEL: "silent"
  }));
  const disabled = createApiConfig(readApiEnvironment({
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "4000",
    API_REQUEST_TIMEOUT_MS: "30000",
    WEB_ORIGIN: "http://localhost:3000",
    LOG_LEVEL: "silent"
  }));
  assert.equal(enabled.automationApiEnabled, true);
  assert.equal(disabled.automationApiEnabled, false);
});

void test("TC-0705 rejects missing required configuration without exposing a secret", () => {
  // Synthetic credential assembled at runtime; no credential-shaped literal is committed
  // (AE-T-072.1 / SEC-002). The runtime value is still a full URI used to prove non-leakage.
  const secret = `mongodb://${["private-user", "private-password"].join(":")}@database.example.test/automation`;
  assert.throws(() => readApiEnvironment({
    NODE_ENV: "production",
    API_HOST: "0.0.0.0",
    API_PORT: "4000",
    API_REQUEST_TIMEOUT_MS: "30000",
    WEB_ORIGIN: "https://example.test",
    LOG_LEVEL: "warn"
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /MONGODB_URI is required/);
    assert.doesNotMatch(error.message, /private-password|database\.example/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

void test("TC-0706 rejects an invalid runtime timeout with a safe field-only error", () => {
  assert.throws(() => readApiEnvironment({
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "4000",
    API_REQUEST_TIMEOUT_MS: "999999",
    WEB_ORIGIN: "http://localhost:3000",
    LOG_LEVEL: "silent"
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /API_REQUEST_TIMEOUT_MS/);
    assert.doesNotMatch(error.message, /999999/);
    return true;
  });
});

void test("TC-0707 never includes a supplied secret in the validation error", () => {
  // Synthetic credential assembled at runtime so no credential-shaped literal is committed
  // (AE-T-072.1); the runtime value is still a full URI used to prove non-leakage.
  const secret = `mongodb://${["private-user", "private-password"].join(":")}@database.example.test/automation`;
  assert.throws(() => readApiEnvironment({
    NODE_ENV: "production",
    API_HOST: "0.0.0.0",
    API_PORT: "invalid-port",
    API_REQUEST_TIMEOUT_MS: "30000",
    WEB_ORIGIN: "https://example.test",
    MONGODB_URI: secret,
    LOG_LEVEL: "warn"
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /private-user|private-password|database\.example/);
    return true;
  });
});
