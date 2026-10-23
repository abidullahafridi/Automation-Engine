import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { checkAutomationJsonBounds } from "./condition.validation.js";
import { validateRuleDraft } from "./rule.validation.js";
import { buildDryRunPreview, dryRunSampleSchema } from "./dry-run.preview.js";
import type { RunHistoryCursor } from "./run.history.repository.js";
import type { RunHistoryService } from "./run.history.service.js";
import type { AutomationApplicationService } from "./automation.service.js";
import type { PrincipalResolution, WorkspaceScope } from "./automation.ports.js";
import type { PolicyPort, PrincipalResolver } from "./automation.ports.js";
import type { AutomationLifecycleTransitionService } from "./lifecycle.transition.service.js";
import type { LifecycleAuditAction } from "./version.lifecycle.service.js";
import type { RecoveryOutcome, RunRecoveryService } from "./run.recovery.service.js";
import { createScheduleRoutes } from "./schedule.routes.js";
import type { ScheduleService } from "./schedule.scheduler.js";
import { createOperationsRoutes } from "./operations.routes.js";
import type { OperationsApiDependencies } from "./operations.routes.js";
import type { MatchResult, TriggerMatcher } from "./trigger.matcher.js";
import type { PublishVersionResult } from "./version.repository.service.js";

export type AutomationPublisher = (input: Readonly<{
  scope: WorkspaceScope;
  automationId: string;
  expectedRevision: number;
  publishKey: string;
}>) => Promise<PublishVersionResult>;

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  draft: z.unknown().refine((value) => value !== undefined)
}).strict();

const validationBodySchema = z.object({
  draft: z.unknown().refine((value) => value !== undefined)
}).strict();

const dryRunBodySchema = z.object({
  sample: dryRunSampleSchema
}).strict();

const cursorSchema = z.object({
  createdAt: z.string().min(1),
  automationId: z.string().min(1)
}).strict();

const runCursorSchema = z.object({
  createdAt: z.string().min(1),
  runId: z.string().min(1)
}).strict();

const errorResponse = (
  response: Response,
  status: number,
  code: string,
  message: string,
  path?: string
): void => {
  response.status(status).json({
    error: {
      code,
      message,
      ...(path === undefined ? {} : { path })
    }
  });
};

const recoveryBodySchema = z.object({
  reason: z.string(),
  confirmedActionIndexes: z.array(z.number().int().nonnegative()).max(10).optional()
}).strict();

const sendRecoveryOutcome = (response: Response, result: RecoveryOutcome): void => {
  switch (result.kind) {
    case "requeued":
      response.status(200).json({
        recovery: {
          operation: "retry",
          runId: result.runId,
          revision: result.revision,
          idempotentReplay: result.idempotentReplay
        }
      });
      return;
    case "replayed":
      response.status(result.idempotentReplay ? 200 : 201).json({
        recovery: {
          operation: "replay",
          runId: result.runId,
          replayRunId: result.replayRunId,
          idempotentReplay: result.idempotentReplay
        }
      });
      return;
    case "blocked":
      errorResponse(
        response, 409, "AUTOMATION_RUN_RECOVERY_BLOCKED",
        `Recovery is blocked (${result.code}); reconcile or confirm the listed actions first.`
      );
      return;
    case "not-retryable":
      errorResponse(response, 409, "AUTOMATION_RUN_NOT_RETRYABLE", "The run is not in a state that allows this recovery.");
      return;
    case "conflict":
      errorResponse(response, 409, "AUTOMATION_REVISION_CONFLICT", "Run was modified; reload and retry with the current revision.");
      return;
    case "not-found":
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation run was not found.");
      return;
    case "invalid":
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", `Recovery request is invalid (${result.code}).`);
      return;
    case "idempotency-conflict":
      errorResponse(response, 422, "AUTOMATION_IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different request.");
      return;
    case "in-progress":
      errorResponse(response, 409, "AUTOMATION_REQUEST_IN_PROGRESS", "A request with this Idempotency-Key is still being processed.");
      return;
  }
};

const lifecycleActions = [
  "enable",
  "pause",
  "resume",
  "disable",
  "archive"
] as const satisfies readonly LifecycleAuditAction[];

const parseIfMatch = (header: string | undefined): number | undefined => {
  if (header === undefined) return undefined;
  const digits = /^"?(\d{1,15})"?$/.exec(header.trim())?.[1];
  if (digits === undefined) return undefined;
  const value = Number(digits);
  return Number.isSafeInteger(value) ? value : undefined;
};

const bearerCredential = (authorization: string | undefined): string | undefined => {
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1];
};

const resolveRequestPrincipal = async (
  request: Request,
  resolver: PrincipalResolver
): Promise<PrincipalResolution> => {
  const workspaceId = request.params.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return Object.freeze({ kind: "not-found" });
  }
  return resolver.resolve({
    credential: bearerCredential(request.get("authorization")),
    requestedWorkspaceId: workspaceId
  });
};

const denyUnauthenticatedOrMissing = (
  response: Response,
  result: PrincipalResolution
): boolean => {
  if (result.kind === "service-unavailable") {
    errorResponse(response, 503, "AUTOMATION_SERVICE_UNAVAILABLE", result.message);
    return true;
  }
  if (result.kind === "unauthenticated") {
    errorResponse(response, 401, "AUTOMATION_UNAUTHENTICATED", "Authentication is required.");
    return true;
  }
  if (result.kind === "not-found") {
    errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
    return true;
  }
  return false;
};

const decodeCursor = (cursor: string | undefined):
  | Readonly<{ success: true; value: Readonly<{ createdAt: string; automationId: string }> | undefined }>
  | Readonly<{ success: false }> => {
  if (cursor === undefined) return Object.freeze({ success: true, value: undefined });
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return Object.freeze({ success: false });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return Object.freeze({ success: false });
    throw error;
  }
  const parsed = cursorSchema.safeParse(decoded);
  return parsed.success
    ? Object.freeze({ success: true, value: parsed.data })
    : Object.freeze({ success: false });
};

const encodeCursor = (cursor: Readonly<{ createdAt: string; automationId: string }>): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

const decodeRunCursor = (cursor: string | undefined):
  | Readonly<{ success: true; value: RunHistoryCursor | undefined }>
  | Readonly<{ success: false }> => {
  if (cursor === undefined) return Object.freeze({ success: true, value: undefined });
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return Object.freeze({ success: false });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return Object.freeze({ success: false });
    throw error;
  }
  const parsed = runCursorSchema.safeParse(decoded);
  return parsed.success
    ? Object.freeze({ success: true, value: parsed.data })
    : Object.freeze({ success: false });
};

const encodeRunCursor = (cursor: RunHistoryCursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

export type AutomationApiDependencies = Readonly<{
  resolver: PrincipalResolver;
  policy: PolicyPort;
  service: AutomationApplicationService;
  lifecycle?: AutomationLifecycleTransitionService;
  runHistory?: RunHistoryService;
  recovery?: RunRecoveryService;
  schedules?: ScheduleService;
  operations?: OperationsApiDependencies;
  /** Explicit publisher is injected by a runtime that owns the repositories and audit policy. */
  publisher?: AutomationPublisher;
  /** Event intake is only mounted when a runtime explicitly supplies a matcher. */
  eventMatcher?: TriggerMatcher;
}>;

export const createAutomationRoutes = ({
  resolver,
  policy,
  service,
  lifecycle,
  runHistory,
  recovery,
  schedules,
  operations,
  publisher,
  eventMatcher
}: AutomationApiDependencies): Router => {
  const router = Router();
  const base = "/api/v1/workspaces/:workspaceId/automations";
  if (schedules !== undefined) {
    router.use(createScheduleRoutes({ resolver, policy, automations: service, schedules }));
  }
  if (operations !== undefined) router.use(createOperationsRoutes(operations));

  if (eventMatcher !== undefined) {
    router.post("/api/v1/workspaces/:workspaceId/automation-events/task-status-changed", async (request, response) => {
      const resolution = await resolveRequestPrincipal(request, resolver);
      if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
      if (!await policy.authorize(resolution.principal, "automation.event.create", {
        type: "workspace", id: resolution.scope.workspaceId
      })) {
        errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Workspace was not found.");
        return;
      }
      const body = z.object({
        sample: dryRunSampleSchema,
        eventId: z.string().min(1).max(200).optional()
      }).strict().safeParse(request.body);
      if (!body.success) {
        errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Sample event is invalid.", "/sample");
        return;
      }
      const task = body.data.sample.task;
      if (!task.status || !task.previousStatus || !task.priority || task.isArchived === undefined) {
        errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "A live event needs status, previousStatus, priority, and isArchived.", "/sample/task");
        return;
      }
      const event = {
        eventId: body.data.eventId ?? randomUUID(),
        eventType: "task.status_changed",
        schemaVersion: 1,
        occurredAt: new Date().toISOString(),
        workspaceId: resolution.scope.workspaceId,
        actor: { type: "user", id: resolution.principal.id },
        aggregate: { type: "task", id: `local-demo-${randomUUID()}` },
        payload: { task }
      } as const;
      const result: MatchResult = await eventMatcher.match(resolution.scope, event);
      if (result.kind === "rejected") {
        errorResponse(response, result.reason === "intake-paused" ? 503 : 400, "AUTOMATION_EVENT_REJECTED", `Event was rejected (${result.reason ?? "unknown"}).`);
        return;
      }
      response.status(202).json({ eventId: event.eventId, ...result });
    });
  }

  router.post(`${base}/validate`, async (request, response) => {
    const resolution = await resolveRequestPrincipal(request, resolver);
    if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
    if (!await policy.authorize(
      resolution.principal,
      "automation.validate",
      { type: "workspace", id: resolution.scope.workspaceId }
    )) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    const body = validationBodySchema.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const path = issue && "keys" in issue && issue.keys[0]
        ? `/${issue.keys[0]}`
        : issue?.path.reduce<string>((value, item) => `${value}/${String(item)}`, "") ?? "";
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Request body is invalid.", path);
      return;
    }
    const boundsIssue = checkAutomationJsonBounds(body.data.draft);
    if (boundsIssue) {
      const path = boundsIssue.path ? `/draft${boundsIssue.path}` : "/draft";
      errorResponse(response, 400, boundsIssue.code, boundsIssue.message, path);
      return;
    }
    const result = validateRuleDraft(body.data.draft);
    response.status(200).json({ valid: result.valid, errors: result.errors });
  });

  router.post(base, async (request, response) => {
    const resolution = await resolveRequestPrincipal(request, resolver);
    if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
    const authorized = await policy.authorize(
      resolution.principal,
      "automation.create",
      { type: "workspace", id: resolution.scope.workspaceId }
    );
    if (!authorized) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const path = issue && "keys" in issue && issue.keys[0]
        ? `/${issue.keys[0]}`
        : issue?.path.reduce<string>((value, item) => `${value}/${String(item)}`, "") ?? "";
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Request body is invalid.", path);
      return;
    }
    const boundsIssue = checkAutomationJsonBounds(body.data.draft);
    if (boundsIssue) {
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Draft exceeds the supported JSON bounds.", "/draft");
      return;
    }
    const idempotencyKey = request.get("idempotency-key");
    if (!idempotencyKey || idempotencyKey.length > 200) {
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "A valid Idempotency-Key is required.", "/headers/Idempotency-Key");
      return;
    }
    const result = await service.createDraft(resolution.scope, resolution.principal, {
      name: body.data.name,
      draft: body.data.draft,
      idempotencyKey
    });
    if (result.kind === "idempotency-conflict") {
      errorResponse(response, 409, "AUTOMATION_IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different request.");
      return;
    }
    const automation = result.automation;
    response.status(result.kind === "created" ? 201 : 200).json({
      automation: {
        automationId: automation.automationId,
        name: automation.name,
        status: automation.status,
        revision: automation.rev,
        currentVersion: automation.currentVersion,
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
        draft: automation.draft
      }
    });
  });

  router.get(base, async (request, response) => {
    const resolution = await resolveRequestPrincipal(request, resolver);
    if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
    if (!await policy.authorize(
      resolution.principal,
      "automation.read",
      { type: "workspace", id: resolution.scope.workspaceId }
    )) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    const limit = z.coerce.number().int().min(1).max(100).safeParse(request.query.limit ?? 20);
    const cursor = decodeCursor(typeof request.query.cursor === "string" ? request.query.cursor : undefined);
    if (!limit.success || !cursor.success) {
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Pagination parameters are invalid.", "/query");
      return;
    }
    const page = await service.list(resolution.scope, { after: cursor.value, limit: limit.data });
    response.status(200).json({
      automations: page.items.map((item) => ({
        automationId: item.automationId,
        name: item.name,
        status: item.status,
        revision: item.rev,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
      nextCursor: page.next ? encodeCursor(page.next) : null
    });
  });

  router.get(`${base}/:automationId`, async (request, response) => {
    const resolution = await resolveRequestPrincipal(request, resolver);
    if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
    const automationId = request.params.automationId;
    if (typeof automationId !== "string" || automationId.length === 0) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    const automation = await service.findById(resolution.scope, automationId);
    if (!automation || !await policy.authorize(
      resolution.principal,
      "automation.read",
      { type: "automation", id: automationId }
    )) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    response.status(200).json({
      automation: {
        automationId: automation.automationId,
        name: automation.name,
        status: automation.status,
        revision: automation.rev,
        currentVersion: automation.currentVersion,
        createdAt: automation.createdAt,
        updatedAt: automation.updatedAt,
        draft: automation.draft
      }
    });
  });

  if (publisher !== undefined) {
    router.post(`${base}/:automationId/publish`, async (request, response) => {
      const resolution = await resolveRequestPrincipal(request, resolver);
      if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
      const automationId = request.params.automationId;
      if (!automationId || !await policy.authorize(
        resolution.principal,
        "automation.publish",
        { type: "automation", id: automationId }
      )) {
        errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
        return;
      }
      const expectedRevision = parseIfMatch(request.get("if-match"));
      const publishKey = request.get("idempotency-key");
      if (expectedRevision === undefined || !publishKey || publishKey.length > 200) {
        errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "A current revision and Idempotency-Key are required.");
        return;
      }
      const result = await publisher({ scope: resolution.scope, automationId, expectedRevision, publishKey });
      if (!result.ok) {
        const status = result.kind === "not-found" ? 404 : result.kind === "conflict" ? 409 : 400;
        errorResponse(response, status, result.code, result.kind === "invalid" ? "Draft could not be published; check rule validation." : "Automation could not be published.");
        return;
      }
      response.status(result.idempotent ? 200 : 201).json({
        automation: { automationId, version: result.version.version, revision: result.revision, status: "draft" },
        published: true
      });
    });
  }

  router.post(`${base}/:automationId/dry-run`, async (request, response) => {
    const resolution = await resolveRequestPrincipal(request, resolver);
    if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
    const automationId = request.params.automationId;
    if (typeof automationId !== "string" || automationId.length === 0) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    const automation = await service.findById(resolution.scope, automationId);
    if (!automation || !await policy.authorize(
      resolution.principal,
      "automation.dry_run",
      { type: "automation", id: automationId }
    )) {
      errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
      return;
    }
    const body = dryRunBodySchema.safeParse(request.body);
    if (!body.success) {
      const issue = body.error.issues[0];
      const path = issue && "keys" in issue && issue.keys[0]
        ? `/${issue.keys[0]}`
        : issue?.path.reduce<string>((value, item) => `${value}/${String(item)}`, "") ?? "";
      errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Request body is invalid.", path);
      return;
    }
    const boundsIssue = checkAutomationJsonBounds(body.data.sample);
    if (boundsIssue) {
      const path = boundsIssue.path ? `/sample${boundsIssue.path}` : "/sample";
      errorResponse(response, 400, boundsIssue.code, boundsIssue.message, path);
      return;
    }
    response.status(200).json(buildDryRunPreview(automation, body.data.sample));
  });

  if (lifecycle !== undefined) {
    for (const action of lifecycleActions) {
      router.post(`${base}/:automationId/${action}`, async (request, response) => {
        const resolution = await resolveRequestPrincipal(request, resolver);
        if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
        const automationId = request.params.automationId;
        if (typeof automationId !== "string" || automationId.length === 0) {
          errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
          return;
        }
        const expectedRevision = parseIfMatch(request.get("if-match"));
        if (expectedRevision === undefined) {
          errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "A valid If-Match revision is required.", "/headers/If-Match");
          return;
        }
        const result = await lifecycle.transition(resolution.scope, resolution.principal, {
          automationId,
          action,
          expectedRevision
        });
        switch (result.kind) {
          case "transitioned": {
            const automation = result.automation;
            response.set("ETag", `"${String(automation.rev)}"`);
            response.status(200).json({
              automation: {
                automationId: automation.automationId,
                name: automation.name,
                status: automation.status,
                revision: automation.rev,
                createdAt: automation.createdAt,
                updatedAt: automation.updatedAt,
                draft: automation.draft
              }
            });
            return;
          }
          case "not-found":
            errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
            return;
          case "conflict":
            errorResponse(response, 409, "AUTOMATION_REVISION_CONFLICT", "Automation was modified; reload and retry with the current revision.");
            return;
          case "invalid-transition":
            errorResponse(response, 409, "AUTOMATION_INVALID_TRANSITION", "Lifecycle transition is not allowed from the current status.");
            return;
          case "not-published":
            errorResponse(response, 409, "AUTOMATION_NOT_PUBLISHED", "Automation has no published version.");
            return;
          case "invalid-request":
            errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", result.message);
            return;
        }
      });
    }
  }

  if (runHistory !== undefined) {
    router.get(`${base}/:automationId/runs`, async (request, response) => {
      const resolution = await resolveRequestPrincipal(request, resolver);
      if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
      const automationId = request.params.automationId;
      if (typeof automationId !== "string" || automationId.length === 0) {
        errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
        return;
      }
      const limit = z.coerce.number().int().min(1).max(100).safeParse(request.query.limit ?? 20);
      const cursor = decodeRunCursor(typeof request.query.cursor === "string" ? request.query.cursor : undefined);
      if (!limit.success || !cursor.success) {
        errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Pagination parameters are invalid.", "/query");
        return;
      }
      const result = await runHistory.listForAutomation(
        resolution.scope,
        resolution.principal,
        automationId,
        { after: cursor.value, limit: limit.data }
      );
      if (result.kind === "not-found") {
        errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation was not found.");
        return;
      }
      response.status(200).json({
        runs: result.items,
        nextCursor: result.next ? encodeRunCursor(result.next) : null
      });
    });

    router.get("/api/v1/workspaces/:workspaceId/automation-runs/:runId", async (request, response) => {
      const resolution = await resolveRequestPrincipal(request, resolver);
      if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
      const runId = request.params.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation run was not found.");
        return;
      }
      const result = await runHistory.get(resolution.scope, resolution.principal, runId);
      if (result.kind === "not-found") {
        errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation run was not found.");
        return;
      }
      response.status(200).json({ run: result.item });
    });
  }

    if (recovery !== undefined) {
    const runBase = "/api/v1/workspaces/:workspaceId/automation-runs/:runId";
    for (const operation of ["retry", "replay"] as const) {
      router.post(`${runBase}/${operation}`, async (request, response) => {
        const resolution = await resolveRequestPrincipal(request, resolver);
        if (denyUnauthenticatedOrMissing(response, resolution) || resolution.kind !== "resolved") return;
        const runId = request.params.runId;
        if (typeof runId !== "string" || runId.length === 0) {
          errorResponse(response, 404, "AUTOMATION_NOT_FOUND", "Automation run was not found.");
          return;
        }
        const body = recoveryBodySchema.safeParse(request.body);
        if (!body.success) {
          const issue = body.error.issues[0];
          const path = issue && "keys" in issue && issue.keys[0]
            ? `/${issue.keys[0]}`
            : issue?.path.reduce<string>((value, item) => `${value}/${String(item)}`, "") ?? "";
          errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "Request body is invalid.", path);
          return;
        }
        const idempotencyKey = request.get("idempotency-key");
        if (!idempotencyKey || idempotencyKey.length > 200) {
          errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "A valid Idempotency-Key is required.", "/headers/Idempotency-Key");
          return;
        }
        const common = {
          runId,
          reason: body.data.reason,
          idempotencyKey,
          ...(body.data.confirmedActionIndexes === undefined
            ? {}
            : { confirmedActionIndexes: body.data.confirmedActionIndexes })
        };
        let result: RecoveryOutcome;
        if (operation === "retry") {
          const expectedRevision = parseIfMatch(request.get("if-match"));
          if (expectedRevision === undefined) {
            errorResponse(response, 400, "AUTOMATION_INVALID_REQUEST", "A valid If-Match revision is required.", "/headers/If-Match");
            return;
          }
          result = await recovery.retry(resolution.scope, resolution.principal, { ...common, expectedRevision });
        } else {
          result = await recovery.replay(resolution.scope, resolution.principal, common);
        }
        sendRecoveryOutcome(response, result);
      });
    }
  }

  return router;
};
