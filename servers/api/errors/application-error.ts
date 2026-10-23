import type { ApplicationError } from "./types.js";

type ApplicationErrorInput = Omit<ApplicationError, "kind">;

export const createApplicationError = (input: ApplicationErrorInput): ApplicationError =>
  Object.freeze({ kind: "application-error", ...input });

export const isApplicationError = (error: unknown): error is ApplicationError =>
  typeof error === "object" && error !== null && "kind" in error && error.kind === "application-error";
