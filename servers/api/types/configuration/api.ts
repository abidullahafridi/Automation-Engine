import type { LogLevel } from "@workspace/logging";
import type { ApiEnvironment } from "@workspace/types";

export type ApiConfig = Readonly<{
  environment: ApiEnvironment;
  host: string;
  port: number;
  requestTimeoutMs: number;
  webOrigin: string;
  automationApiEnabled?: boolean;
  mongodbUri?: string;
  logLevel: LogLevel;
}>;
