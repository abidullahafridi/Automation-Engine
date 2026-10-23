import type { ApiConfiguration, ValidatedWebEnvironment } from "@/types";

export const createApiConfiguration = (
  environment: ValidatedWebEnvironment
): ApiConfiguration => Object.freeze({
  baseUrl: environment.NEXT_PUBLIC_API_BASE_URL
});
