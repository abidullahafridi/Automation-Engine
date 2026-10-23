import test from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { HTTP_STATUS } from "../../../constants/index.js";
import { createHealthController } from "../controllers/index.js";

void test("health controller maps service output to the HTTP response", () => {
  const health = { status: "ok", service: "api", environment: "test" } as const;
  let statusCode: number | undefined;
  let responseBody: unknown;
  const response = {
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    json: (body: unknown) => {
      responseBody = body;
      return response;
    }
  } as unknown as Pick<Response, "json" | "status">;
  const controller = createHealthController({ service: { getHealth: () => health } });

  controller({} as Request, response);

  assert.equal(statusCode, HTTP_STATUS.ok);
  assert.deepEqual(responseBody, health);
});
