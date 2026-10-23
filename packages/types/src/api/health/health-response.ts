import type { ApiEnvironment } from "../environment/index.js";

export type ApiHealthResponse = Readonly<{
  status: "ok";
  service: string;
  environment: ApiEnvironment;
}>;
