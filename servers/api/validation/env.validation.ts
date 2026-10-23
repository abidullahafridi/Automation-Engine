import { z } from "zod";
import type { ValidatedApiEnvironment } from "../types/index.js";

export const apiEnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  API_HOST: z.string().min(1),
  API_PORT: z.coerce.number().int().min(1).max(65_535),
  API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000),
  WEB_ORIGIN: z.url(),
  AUTOMATION_API_ENABLED: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
  MONGODB_URI: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
}).superRefine((environment, context) => {
  if (environment.NODE_ENV === "production" && !environment.MONGODB_URI) {
    context.addIssue({
      code: "custom",
      path: ["MONGODB_URI"],
      message: "is required when NODE_ENV is production"
    });
  }
}) satisfies z.ZodType<ValidatedApiEnvironment>;

const safeIssueDescription = (issue: z.core.$ZodIssue): string =>
  `${issue.path.join(".") || "environment"} ${issue.message}`;

export const validateApiEnvironment = (input: unknown): ValidatedApiEnvironment => {
  const result = apiEnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid API environment: ${result.error.issues.map(safeIssueDescription).join("; ")}.`);
  }
  return Object.freeze(result.data);
};
