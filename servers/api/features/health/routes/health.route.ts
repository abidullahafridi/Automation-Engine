import { Router } from "express";
import { createHealthController } from "../controllers/index.js";
import { createHealthService, type HealthServiceDependencies } from "../services/index.js";

export type HealthRouteDependencies = HealthServiceDependencies;

export const createHealthRoutes = (dependencies: HealthRouteDependencies): Router => {
  const router = Router();
  const service = createHealthService(dependencies);
  const controller = createHealthController({ service });

  router.get("/health", controller);
  return router;
};
