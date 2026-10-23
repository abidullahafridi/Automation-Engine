import {
  validateApiEnvironment
} from "../validation/env.validation.js";
import type { ApiEnvironmentSource, ValidatedApiEnvironment } from "../types/index.js";

export const readApiEnvironment = (
  source: ApiEnvironmentSource = process.env
): ValidatedApiEnvironment => validateApiEnvironment({
  NODE_ENV: source.NODE_ENV,
  API_HOST: source.API_HOST,
  API_PORT: source.API_PORT,
  API_REQUEST_TIMEOUT_MS: source.API_REQUEST_TIMEOUT_MS,
  WEB_ORIGIN: source.WEB_ORIGIN,
  AUTOMATION_API_ENABLED: source.AUTOMATION_API_ENABLED,
  MONGODB_URI: source.MONGODB_URI,
  LOG_LEVEL: source.LOG_LEVEL
});
