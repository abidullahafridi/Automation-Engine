import type { LogLevel } from "@workspace/logging";
import type { ApiEnvironment } from "@workspace/types";

export type ApiEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type ValidatedApiEnvironment = Readonly<{
  NODE_ENV: ApiEnvironment;
  API_HOST: string;
  API_PORT: number;
  API_REQUEST_TIMEOUT_MS: number;
  WEB_ORIGIN: string;
  AUTOMATION_API_ENABLED?: boolean | undefined;
  MONGODB_URI?: string | undefined;
  LOG_LEVEL: LogLevel;
}>;
