import { z } from "zod";
import type { ValidatedWebEnvironment } from "@/types";

export const webEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_BASE_URL: z.url()
}) satisfies z.ZodType<ValidatedWebEnvironment>;

const safeIssueDescription = (issue: z.core.$ZodIssue): string =>
  `${issue.path.join(".") || "environment"} ${issue.message}`;

export const validateWebEnvironment = (input: unknown): ValidatedWebEnvironment => {
  const result = webEnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid web environment: ${result.error.issues.map(safeIssueDescription).join("; ")}.`);
  }
  return Object.freeze(result.data);
};
