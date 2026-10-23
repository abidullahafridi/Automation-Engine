import type { ApiConfig, ValidatedApiEnvironment } from "../types/index.js";

export const createApiConfig = (environment: ValidatedApiEnvironment): ApiConfig => Object.freeze({
  environment: environment.NODE_ENV,
  host: environment.API_HOST,
  port: environment.API_PORT,
  requestTimeoutMs: environment.API_REQUEST_TIMEOUT_MS,
  webOrigin: environment.WEB_ORIGIN,
  automationApiEnabled: environment.AUTOMATION_API_ENABLED === true,
  logLevel: environment.LOG_LEVEL,
  ...(environment.MONGODB_URI ? { mongodbUri: environment.MONGODB_URI } : {})
});
