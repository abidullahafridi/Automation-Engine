import { z } from "zod";
import { isIsoInstant } from "./condition.validation.js";

export const taskStatusChangedEventV1Schema = z.object({
  eventId: z.string().min(1),
  eventType: z.literal("task.status_changed"),
  schemaVersion: z.literal(1),
  occurredAt: z.string().refine(isIsoInstant, "Expected an ISO-8601 instant."),
  workspaceId: z.string().min(1),
  aggregateVersion: z.number().int().nonnegative().optional(),
  correlationId: z.string().min(1).optional(),
  causationId: z.string().min(1).optional(),
  traceparent: z.string().regex(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/).optional(),
  actor: z.object({
    type: z.enum(["user", "system", "automation"]),
    id: z.string().min(1)
  }).strict(),
  origin: z.object({
    automationId: z.string().min(1),
    runId: z.string().min(1),
    hop: z.number().int().nonnegative()
  }).strict().optional(),
  aggregate: z.object({
    type: z.literal("task"),
    id: z.string().min(1)
  }).strict(),
  payload: z.object({
    task: z.object({
      status: z.string().min(1),
      previousStatus: z.string().min(1),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      isArchived: z.boolean()
    }).strict()
  }).strict()
}).strict().superRefine((event, context) => {
  if (event.origin !== undefined && event.actor.type !== "automation") {
    context.addIssue({
      code: "custom",
      path: ["origin"],
      message: "Origin metadata is only valid for automation actors."
    });
  }
});

export type TaskStatusChangedEventV1 = z.infer<typeof taskStatusChangedEventV1Schema>;

export const validateTaskStatusChangedEvent = (input: unknown) =>
  taskStatusChangedEventV1Schema.safeParse(input);

export const isDomainEventSchemaBackwardCompatible = (
  candidateSchema: z.ZodType,
  historicalEvents: readonly unknown[]
): boolean => historicalEvents.every((event) => candidateSchema.safeParse(event).success);
