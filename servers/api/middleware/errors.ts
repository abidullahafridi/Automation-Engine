import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import type { Logger } from "@workspace/logging";
import type { ApiErrorResponse } from "@workspace/types";
import { ERROR_CODES, ERROR_MESSAGES, HTTP_STATUS } from "../constants/index.js";
import { createApplicationError, isApplicationError } from "../errors/index.js";

export const createNotFoundHandler = (): RequestHandler => (request, _response, next) => {
  next(createApplicationError({
    code: ERROR_CODES.routeNotFound,
    message: ERROR_MESSAGES.routeNotFound,
    status: HTTP_STATUS.notFound,
    details: { method: request.method, path: request.path }
  }));
};

export const createErrorHandler = ({ logger }: { logger: Logger }): ErrorRequestHandler =>
  (error: unknown, _request, response, _next) => {
    if (error instanceof ZodError) {
      const body: ApiErrorResponse = {
        error: { code: ERROR_CODES.validation, message: ERROR_MESSAGES.validation, details: error.issues }
      };
      response.status(HTTP_STATUS.badRequest).json(body);
      return;
    }
    if (isApplicationError(error)) {
      const body: ApiErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {})
        }
      };
      response.status(error.status).json(body);
      return;
    }
    logger.error("Unhandled API error.", { error: error instanceof Error ? error.message : String(error) });
    const body: ApiErrorResponse = {
      error: { code: ERROR_CODES.internal, message: ERROR_MESSAGES.internal }
    };
    response.status(HTTP_STATUS.internalServerError).json(body);
  };
