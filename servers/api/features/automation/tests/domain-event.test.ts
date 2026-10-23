import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  isDomainEventSchemaBackwardCompatible,
  taskStatusChangedEventV1Schema,
  validateTaskStatusChangedEvent
} from "../domain-event.js";

const historicalTaskStatusChangedEvent = Object.freeze({
  eventId: "event-001",
  eventType: "task.status_changed",
  schemaVersion: 1,
  occurredAt: "2026-10-14T12:00:00Z",
  workspaceId: "workspace-001",
  actor: { type: "user", id: "user-001" },
  aggregate: { type: "task", id: "task-001" },
  payload: {
    task: {
      status: "done",
      previousStatus: "in_progress",
      priority: "high",
      isArchived: false
    }
  }
});

const currentTaskStatusChangedEvent = Object.freeze({
  ...historicalTaskStatusChangedEvent,
  aggregateVersion: 4,
  correlationId: "correlation-001",
  causationId: "command-001"
});

void test("TC-0201 valid versioned task domain event passes validation", () => {
  assert.equal(validateTaskStatusChangedEvent(currentTaskStatusChangedEvent).success, true);
  assert.equal(validateTaskStatusChangedEvent(historicalTaskStatusChangedEvent).success, true);
});

void test("TC-0202 missing event ID, workspace, or schema version is rejected", () => {
  const without = (field: string) => Object.fromEntries(
    Object.entries(historicalTaskStatusChangedEvent).filter(([key]) => key !== field)
  );

  assert.equal(validateTaskStatusChangedEvent(without("eventId")).success, false);
  assert.equal(validateTaskStatusChangedEvent(without("workspaceId")).success, false);
  assert.equal(validateTaskStatusChangedEvent(without("schemaVersion")).success, false);
  assert.equal(validateTaskStatusChangedEvent(without("actor")).success, false);
  assert.equal(validateTaskStatusChangedEvent(without("aggregate")).success, false);
  assert.equal(validateTaskStatusChangedEvent(without("payload")).success, false);
});

void test("TC-0203 historical events reject a breaking required-field change", () => {
  const candidateBreakingSchema = taskStatusChangedEventV1Schema.extend({
    producerVersion: z.string().min(1)
  }).strict();

  assert.equal(
    isDomainEventSchemaBackwardCompatible(
      taskStatusChangedEventV1Schema,
      [historicalTaskStatusChangedEvent]
    ),
    true
  );
  assert.equal(
    isDomainEventSchemaBackwardCompatible(
      candidateBreakingSchema,
      [historicalTaskStatusChangedEvent]
    ),
    false
  );
});

void test("event envelope and payload reject unregistered fields", () => {
  assert.equal(validateTaskStatusChangedEvent({
    ...historicalTaskStatusChangedEvent,
    workspaceSecret: "must-not-be-in-the-event"
  }).success, false);
  assert.equal(validateTaskStatusChangedEvent({
    ...historicalTaskStatusChangedEvent,
    payload: {
      ...historicalTaskStatusChangedEvent.payload,
      task: {
        ...historicalTaskStatusChangedEvent.payload.task,
        description: "unnecessary raw task content"
      }
    }
  }).success, false);
  assert.equal(validateTaskStatusChangedEvent({
    ...historicalTaskStatusChangedEvent,
    actor: { ...historicalTaskStatusChangedEvent.actor, workspaceId: "forged" }
  }).success, false);
  assert.equal(validateTaskStatusChangedEvent({
    ...historicalTaskStatusChangedEvent,
    aggregate: { ...historicalTaskStatusChangedEvent.aggregate, type: "project" }
  }).success, false);
});

void test("automation-origin metadata is accepted only for automation actors", () => {
  const automationEvent = {
    ...currentTaskStatusChangedEvent,
    actor: { type: "automation" as const, id: "automation-001" },
    origin: { automationId: "automation-001", runId: "run-001", hop: 1 }
  };
  assert.equal(validateTaskStatusChangedEvent(automationEvent).success, true);
  assert.equal(validateTaskStatusChangedEvent({
    ...currentTaskStatusChangedEvent,
    aggregateVersion: -1
  }).success, false);
  assert.equal(validateTaskStatusChangedEvent({
    ...currentTaskStatusChangedEvent,
    actor: { type: "automation", id: "automation-001" }
  }).success, true);
  assert.equal(validateTaskStatusChangedEvent({
    ...currentTaskStatusChangedEvent,
    origin: { automationId: "automation-001", runId: "run-001", hop: 1 }
  }).success, false);
});

void test("historical v1 events remain readable without additive provenance fields", () => {
  assert.equal(validateTaskStatusChangedEvent(historicalTaskStatusChangedEvent).success, true);
});
