import type { RequestHandler } from "express";
import { HTTP_STATUS } from "../constants/index.js";

export const createCorsMiddleware = ({ origin }: { origin: string }): RequestHandler =>
  (request, response, next) => {
    const requestOrigin = request.headers.origin;
    const allowedOrigin =
      requestOrigin && (
        requestOrigin === origin ||
        requestOrigin === "http://localhost:3000" ||
        requestOrigin === "http://127.0.0.1:3000"
      )
        ? requestOrigin
        : origin;

    response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    response.setHeader("Vary", "Origin");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Idempotency-Key, If-Match, Accept"
    );
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (request.method === "OPTIONS") {
      response.sendStatus(HTTP_STATUS.noContent);
      return;
    }
    next();
  };
