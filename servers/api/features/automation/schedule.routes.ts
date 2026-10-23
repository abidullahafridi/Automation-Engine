import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { AutomationApplicationService } from "./automation.service.js";
import type { PolicyPort, PrincipalResolution, PrincipalResolver } from "./automation.ports.js";
import { validateSchedule } from "./schedule.occurrence.js";
import type { ScheduleService } from "./schedule.scheduler.js";

const definitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), everyMs: z.number().int().positive(), anchorAt: z.string() }).strict(),
  z.object({ kind: z.literal("daily"), time: z.string() }).strict()
]);
const scheduleSchema = z.object({ timezone: z.string(), definition: definitionSchema }).strict();

const error = (response: Response, status: number, code: string, message: string): void => {
  response.status(status).json({ error: { code, message } });
};

const resolutionError = (response: Response, result: PrincipalResolution): boolean => {
  if (result.kind === "resolved") return false;
  if (result.kind === "unauthenticated") error(response, 401, "AUTOMATION_UNAUTHENTICATED", "Authentication is required.");
  else if (result.kind === "service-unavailable") error(response, 503, "AUTOMATION_SERVICE_UNAVAILABLE", "Automation authorization is unavailable.");
  else error(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
  return true;
};

const bearer = (value: string | undefined): string | undefined => {
  const match = value === undefined ? undefined : /^Bearer\s+(\S+)$/i.exec(value);
  return match?.[1];
};

export type ScheduleApiDependencies = Readonly<{
  resolver: PrincipalResolver;
  policy: PolicyPort;
  automations: AutomationApplicationService;
  schedules: ScheduleService;
}>;

export const createScheduleRoutes = ({ resolver, policy, automations, schedules }: ScheduleApiDependencies): Router => {
  const router = Router();
  const base = "/api/v1/workspaces/:workspaceId/automations/:automationId/schedule";

  const authorize = async (request: Request, response: Response, permission: string) => {
    const workspaceId = request.params.workspaceId;
    const automationId = request.params.automationId;
    if (typeof workspaceId !== "string" || !workspaceId || typeof automationId !== "string" || !automationId) {
      error(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return undefined;
    }
    const resolution = await resolver.resolve({
      credential: bearer(request.get("authorization")),
      requestedWorkspaceId: workspaceId
    });
    if (resolutionError(response, resolution) || resolution.kind !== "resolved") return undefined;
    const automation = await automations.findById(resolution.scope, automationId);
    if (!automation || !await policy.authorize(resolution.principal, permission, { type: "automation", id: automationId })) {
      error(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return undefined;
    }
    return Object.freeze({ resolution, automation, automationId });
  };

  router.post(`${base}/validate`, async (request, response) => {
    const context = await authorize(request, response, "automation.schedule.manage");
    if (!context) return;
    const body = scheduleSchema.safeParse(request.body);
    if (!body.success) {
      error(response, 400, "AUTOMATION_INVALID_REQUEST", "Schedule definition is invalid.");
      return;
    }
    const issues = validateSchedule(body.data.timezone, body.data.definition);
    response.status(200).json({ valid: issues.length === 0, issues });
  });

  router.post(base, async (request, response) => {
    const context = await authorize(request, response, "automation.schedule.manage");
    if (!context) return;
    const body = scheduleSchema.safeParse(request.body);
    if (!body.success) {
      error(response, 400, "AUTOMATION_INVALID_REQUEST", "Schedule definition is invalid.");
      return;
    }
    const result = await schedules.register(context.resolution.scope, {
      automationId: context.automationId,
      ...body.data,
      enabled: false
    });
    if (result.kind === "invalid") {
      response.status(400).json({ valid: false, issues: result.issues });
      return;
    }
    if (result.kind === "exists") {
      error(response, 409, "AUTOMATION_SCHEDULE_EXISTS", "A schedule already exists; update it instead.");
      return;
    }
    response.set("ETag", `"${String(result.cursor.rev)}"`).status(201).json({ schedule: result.cursor });
  });

  router.get(base, async (request, response) => {
    const context = await authorize(request, response, "automation.schedule.read");
    if (!context) return;
    const cursor = await schedules.find(context.resolution.scope, context.automationId);
    if (!cursor) {
      error(response, 404, "AUTOMATION_SCHEDULE_NOT_FOUND", "Schedule was not found.");
      return;
    }
    const occurrences = await schedules.listOccurrences(context.resolution.scope, context.automationId);
    response.status(200).json({ schedule: cursor, occurrences });
  });

  router.put(base, async (request, response) => {
    const context = await authorize(request, response, "automation.schedule.manage");
    if (!context) return;
    const body = scheduleSchema.safeParse(request.body);
    if (!body.success) {
      error(response, 400, "AUTOMATION_INVALID_REQUEST", "Schedule definition is invalid.");
      return;
    }
    const ifMatch = request.get("if-match")?.trim().replace(/^"|"$/g, "");
    const expectedRev = ifMatch && /^\d{1,15}$/.test(ifMatch) ? Number(ifMatch) : undefined;
    if (expectedRev === undefined || !Number.isSafeInteger(expectedRev)) {
      error(response, 400, "AUTOMATION_INVALID_REQUEST", "A valid If-Match revision is required.");
      return;
    }
    const result = await schedules.update(context.resolution.scope, {
      automationId: context.automationId,
      ...body.data,
      expectedRev
    });
    if (result === "invalid") {
      response.status(400).json({ valid: false, issues: validateSchedule(body.data.timezone, body.data.definition) });
      return;
    }
    if (result !== "updated") {
      error(response, result === "conflict" ? 409 : 404, result === "conflict" ? "AUTOMATION_REVISION_CONFLICT" : "AUTOMATION_SCHEDULE_NOT_FOUND", "Schedule could not be updated.");
      return;
    }
    const cursor = await schedules.find(context.resolution.scope, context.automationId);
    if (!cursor) {
      error(response, 404, "AUTOMATION_SCHEDULE_NOT_FOUND", "Schedule was not found.");
      return;
    }
    response.set("ETag", `"${String(cursor.rev)}"`).status(200).json({ schedule: cursor });
  });

  router.post(`${base}/:operation`, async (request, response) => {
    const operation = request.params.operation;
    if (operation !== "enable" && operation !== "disable") {
      error(response, 404, "AUTOMATION_NOT_FOUND", "Route was not found.");
      return;
    }
    const context = await authorize(request, response, "automation.schedule.manage");
    if (!context) return;
    const cursor = await schedules.find(context.resolution.scope, context.automationId);
    if (!cursor) {
      error(response, 404, "AUTOMATION_SCHEDULE_NOT_FOUND", "Schedule was not found.");
      return;
    }
    if (operation === "enable" && context.automation.status !== "enabled") {
      error(response, 409, "AUTOMATION_SCHEDULE_REQUIRES_ENABLED_AUTOMATION", "Enable the automation before enabling its schedule.");
      return;
    }
    const revisionHeader = request.get("if-match")?.trim().replace(/^"|"$/g, "");
    const expectedRev = revisionHeader && /^\d{1,15}$/.test(revisionHeader) ? Number(revisionHeader) : undefined;
    if (expectedRev === undefined || !Number.isSafeInteger(expectedRev)) {
      error(response, 400, "AUTOMATION_INVALID_REQUEST", "A valid If-Match revision is required.");
      return;
    }
    const result = await schedules.setEnabled(context.resolution.scope, context.automationId, operation === "enable", expectedRev);
    if (result !== "updated") {
      error(response, result === "conflict" ? 409 : 404, result === "conflict" ? "AUTOMATION_REVISION_CONFLICT" : "AUTOMATION_SCHEDULE_NOT_FOUND", "Schedule state could not be changed.");
      return;
    }
    const updated = await schedules.find(context.resolution.scope, context.automationId);
    if (!updated) {
      error(response, 404, "AUTOMATION_SCHEDULE_NOT_FOUND", "Schedule was not found.");
      return;
    }
    response.set("ETag", `"${String(updated.rev)}"`).status(200).json({ schedule: updated });
  });
  return router;
};
