import type { ApiHealthResponse } from "@workspace/types";

export type HealthServiceDependencies = Readonly<{
  environment: ApiHealthResponse["environment"];
  serviceName: ApiHealthResponse["service"];
}>;

export type HealthService = Readonly<{
  getHealth: () => ApiHealthResponse;
}>;

export const createHealthService = ({
  environment,
  serviceName
}: HealthServiceDependencies): HealthService => ({
  getHealth: () => ({ status: "ok", service: serviceName, environment })
});
