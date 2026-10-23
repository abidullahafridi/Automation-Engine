import type { Request, Response } from "express";
import { HTTP_STATUS } from "../../../constants/index.js";
import type { HealthService } from "../services/index.js";

type HealthResponse = Pick<Response, "json" | "status">;

export type HealthControllerDependencies = Readonly<{
  service: Pick<HealthService, "getHealth">;
}>;

export const createHealthController = ({ service }: HealthControllerDependencies) =>
  (_request: Request, response: HealthResponse): void => {
    response.status(HTTP_STATUS.ok).json(service.getHealth());
  };
