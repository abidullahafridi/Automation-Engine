import { Router, type Request, type Response } from "express";
import type { PolicyPort, PrincipalResolver } from "./automation.ports.js";
import { evaluateAlerts, type AlertThresholds } from "./ops.alerts.js";
import { collectOpsSignals, type OpsSignalSources } from "./ops.signals.js";
import type { Clock } from "./automation.service.js";

export type OperationsApiDependencies = Readonly<{
  resolver: PrincipalResolver;
  policy: PolicyPort;
  sources: OpsSignalSources;
  thresholds: AlertThresholds;
  clock: Clock;
}>;

const fail = (response: Response, status: number, code: string, message: string): void => {
  response.status(status).json({ error: { code, message } });
};

const credential = (request: Request): string | undefined => {
  const match = /^Bearer\s+(\S+)$/i.exec(request.get("authorization") ?? "");
  return match?.[1];
};

export const createOperationsRoutes = ({ resolver, policy, sources, thresholds, clock }: OperationsApiDependencies): Router => {
  const router = Router();
  router.get("/api/v1/workspaces/:workspaceId/automation-ops", async (request, response) => {
    const workspaceId = request.params.workspaceId;
    if (typeof workspaceId !== "string" || workspaceId.length === 0) {
      fail(response, 404, "AUTOMATION_NOT_FOUND", "Workspace was not found.");
      return;
    }
    const resolution = await resolver.resolve({ credential: credential(request), requestedWorkspaceId: workspaceId });
    if (resolution.kind === "unauthenticated") {
      fail(response, 401, "AUTOMATION_UNAUTHENTICATED", "Authentication is required.");
      return;
    }
    if (resolution.kind === "not-found") {
      fail(response, 404, "AUTOMATION_NOT_FOUND", "Workspace was not found.");
      return;
    }
    if (resolution.kind === "service-unavailable") {
      fail(response, 503, "AUTOMATION_SERVICE_UNAVAILABLE", "Automation authorization is unavailable.");
      return;
    }
    if (!await policy.authorize(resolution.principal, "automation.ops.read", { type: "workspace", id: workspaceId })) {
      fail(response, 404, "AUTOMATION_NOT_FOUND", "Workspace was not found.");
      return;
    }
    const signals = await collectOpsSignals({ ownsScope: resolver.ownsScope, sources, scope: resolution.scope, now: clock.now() });
    response.status(200).json({ signals, alerts: evaluateAlerts(signals, thresholds) });
  });
  return router;
};
