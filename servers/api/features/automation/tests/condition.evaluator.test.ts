import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createConditionEvaluator } from "../condition.evaluator.js";
import { createTriggerRegistry, triggerRegistry } from "../automation.registry.js";
import {
  automationLimits,
  type ConditionFieldDefinitions,
  validateCondition
} from "../condition.validation.js";

const testFieldDefinitions = Object.freeze({
  "task.status": Object.freeze({ type: "string" as const }),
  "task.priority": Object.freeze({ type: "enum" as const, values: Object.freeze(["low", "medium", "high", "urgent"]) }),
  "task.archived": Object.freeze({ type: "boolean" as const }),
  "task.updatedAt": Object.freeze({ type: "instant" as const }),
  "task.rank": Object.freeze({ type: "number" as const }),
  "task.deadline": Object.freeze({ type: "instant" as const })
}) satisfies ConditionFieldDefinitions;
const testTriggerRegistry = createTriggerRegistry([{
  type: "test.trigger",
  configSchema: z.unknown(),
  fields: testFieldDefinitions
}]);
const evaluate = createConditionEvaluator(testTriggerRegistry, "test.trigger");
const evaluateRegisteredTrigger = createConditionEvaluator(triggerRegistry);

void test("evaluates supported scalar, membership, numeric, date, existence, and group operators", () => {
  const event = {
    task: {
      status: "done",
      priority: "urgent",
      archived: false,
      updatedAt: "2026-10-14T10:00:00Z",
      rank: 3,
      deadline: "2026-10-14T09:00:00Z"
    }
  };

  const result = evaluate({
    all: [
      { field: "task.status", op: "eq", value: "done" },
      { field: "task.priority", op: "in", value: ["high", "urgent"] },
      { field: "task.archived", op: "ne", value: true },
      { field: "task.priority", op: "not_in", value: ["low"] },
      { field: "task.updatedAt", op: "before", value: "2026-10-15T00:00:00+00:00" },
      { field: "task.updatedAt", op: "after", value: "2026-10-14T09:00:00Z" },
      { field: "task.rank", op: "gt", value: 2 },
      { field: "task.rank", op: "gte", value: 3 },
      { field: "task.rank", op: "lt", value: 4 },
      { field: "task.rank", op: "lte", value: 3 },
      { field: "task.archived", op: "exists" },
      { not: { field: "task.status", op: "eq", value: "open" } },
      { any: [
        { field: "task.priority", op: "eq", value: "low" },
        { field: "task.priority", op: "eq", value: "urgent" }
      ] }
    ]
  }, event);

  assert.deepEqual(result, { status: "matched" });
});

void test("covers matching and non-matching boundaries for every supported operator", () => {
  const present = { task: { status: "done", rank: 3, updatedAt: "2026-10-14T10:00:00Z" } };
  const absent = { task: {} };
  const cases = [
    [{ field: "task.status", op: "eq", value: "done" }, present, "matched"],
    [{ field: "task.status", op: "eq", value: "open" }, present, "not_matched"],
    [{ field: "task.status", op: "ne", value: "open" }, present, "matched"],
    [{ field: "task.status", op: "ne", value: "done" }, present, "not_matched"],
    [{ field: "task.status", op: "in", value: ["done"] }, present, "matched"],
    [{ field: "task.status", op: "in", value: ["open"] }, present, "not_matched"],
    [{ field: "task.status", op: "not_in", value: ["open"] }, present, "matched"],
    [{ field: "task.status", op: "not_in", value: ["done"] }, present, "not_matched"],
    [{ field: "task.status", op: "exists" }, present, "matched"],
    [{ field: "task.status", op: "exists" }, absent, "not_matched"],
    [{ field: "task.status", op: "not_exists" }, absent, "matched"],
    [{ field: "task.status", op: "not_exists" }, present, "not_matched"],
    [{ field: "task.rank", op: "gt", value: 2 }, present, "matched"],
    [{ field: "task.rank", op: "gt", value: 3 }, present, "not_matched"],
    [{ field: "task.rank", op: "gte", value: 3 }, present, "matched"],
    [{ field: "task.rank", op: "gte", value: 4 }, present, "not_matched"],
    [{ field: "task.rank", op: "lt", value: 4 }, present, "matched"],
    [{ field: "task.rank", op: "lt", value: 3 }, present, "not_matched"],
    [{ field: "task.rank", op: "lte", value: 3 }, present, "matched"],
    [{ field: "task.rank", op: "lte", value: 2 }, present, "not_matched"],
    [{ field: "task.updatedAt", op: "before", value: "2026-10-14T11:00:00Z" }, present, "matched"],
    [{ field: "task.updatedAt", op: "before", value: "2026-10-14T09:00:00Z" }, present, "not_matched"],
    [{ field: "task.updatedAt", op: "after", value: "2026-10-14T09:00:00Z" }, present, "matched"],
    [{ field: "task.updatedAt", op: "after", value: "2026-10-14T11:00:00Z" }, present, "not_matched"]
  ] as const;

  for (const [condition, event, expected] of cases) {
    assert.equal(evaluate(condition, event).status, expected);
  }
});

void test("numeric comparison operators satisfy a deterministic bounded property sweep", () => {
  for (let actual = -10; actual <= 10; actual += 1) {
    for (let expected = -10; expected <= 10; expected += 1) {
      const event = { task: { rank: actual } };
      assert.equal(evaluate({ field: "task.rank", op: "gt", value: expected }, event).status === "matched", actual > expected);
      assert.equal(evaluate({ field: "task.rank", op: "gte", value: expected }, event).status === "matched", actual >= expected);
      assert.equal(evaluate({ field: "task.rank", op: "lt", value: expected }, event).status === "matched", actual < expected);
      assert.equal(evaluate({ field: "task.rank", op: "lte", value: expected }, event).status === "matched", actual <= expected);
    }
  }
});

void test("uses deterministic boolean boundaries and rejects coercion", () => {
  assert.deepEqual(evaluate({ field: "task.rank", op: "gt", value: 2 }, { task: { rank: "3" } }), {
    status: "evaluation_error",
    code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
    path: "",
    message: "Condition field has an unsupported value type."
  });
  assert.deepEqual(evaluate({ field: "task.priority", op: "gte", value: 2 }, { task: { priority: 2 } }), {
    status: "evaluation_error",
    code: "AUTOMATION_INVALID_CONDITION",
    path: "/op",
    message: "Operator is incompatible with the trigger field type."
  });
  assert.deepEqual(evaluate({ field: "task.rank", op: "gte", value: 2 }, { task: { rank: 2 } }), {
    status: "matched"
  });
});

void test("distinguishes missing fields from explicit null values", () => {
  assert.deepEqual(evaluate({ field: "task.status", op: "exists" }, { task: { status: null } }), {
    status: "matched"
  });
  assert.deepEqual(evaluate({ field: "task.status", op: "not_exists" }, { task: {} }), {
    status: "matched"
  });
  assert.equal(evaluate({ field: "task.status", op: "eq", value: null }, { task: { status: null } }).status, "matched");
  assert.equal(evaluate({ field: "task.status", op: "eq", value: "done" }, { task: {} }).status, "evaluation_error");
  assert.equal(evaluate({ field: "task.status", op: "ne", value: "done" }, { task: {} }).status, "not_matched");
  assert.equal(evaluate({ field: "task.status", op: "not_in", value: ["done"] }, { task: {} }).status, "not_matched");
});

void test("does not traverse inherited properties or unsafe property names", () => {
  const inherited = Object.create({ status: "done" }) as { status: string };
  assert.equal(evaluate({ field: "task.status", op: "eq", value: "done" }, { task: inherited }).status, "evaluation_error");
  assert.equal(validateCondition(
    { field: "task.constructor.prototype", op: "exists" },
    testFieldDefinitions
  ).success, false);
  for (const unsafeSegment of ["__proto__", "prototype", "constructor"]) {
    const condition = { field: `task.${unsafeSegment}`, op: "exists" };
    assert.equal(validateCondition(condition, testFieldDefinitions).success, false);
    assert.equal(evaluate(condition, { task: {} }).status, "evaluation_error");
  }
});

void test("rejects unknown fields, operators, extra keys, and incompatible operands", () => {
  assert.equal(evaluate({ field: "task.secret", op: "exists" }, {}).status, "evaluation_error");
  assert.equal(evaluate({ field: "task.status", op: "matches", value: ".*" }, {}).status, "evaluation_error");
  assert.equal(evaluate({ field: "task.status", op: "eq", value: "done", extra: true }, {}).status, "evaluation_error");
  assert.equal(evaluate({ field: "task.updatedAt", op: "after", value: "tomorrow" }, {}).status, "evaluation_error");
  assert.equal(
    evaluate({ field: "task.updatedAt", op: "after", value: "2026-02-31T00:00:00Z" }, {}).status,
    "evaluation_error"
  );
  assert.equal(
    validateCondition({ field: "task..status", op: "exists" }, testFieldDefinitions).success,
    false
  );
});

void test("uses only the trigger registry-owned field allowlist", () => {
  assert.deepEqual(
    evaluateRegisteredTrigger({ field: "task.isArchived", op: "eq", value: false }, { task: { isArchived: false } }),
    { status: "matched" }
  );
  assert.equal(
    evaluateRegisteredTrigger({ field: "task.rank", op: "exists" }, { task: { rank: 1 } }).status,
    "evaluation_error"
  );
});

void test("rejects empty groups and malformed operators before evaluation", () => {
  assert.equal(validateCondition({ all: [] }, testFieldDefinitions).success, false);
  assert.equal(validateCondition({ field: "task.status", op: "exists", value: null }, testFieldDefinitions).success, false);
  assert.equal(validateCondition({ field: "task.status", op: "in", value: [] }, testFieldDefinitions).success, false);
});

void test("does not hide an evaluation error behind a matching or non-matching group child", () => {
  const invalidFieldCondition = { field: "task.archived", op: "eq", value: true };
  assert.deepEqual(evaluate({
    all: [
      { field: "task.status", op: "eq", value: "done" },
      invalidFieldCondition
    ]
  }, { task: { status: "open" } }), {
    status: "evaluation_error",
    code: "AUTOMATION_CONDITION_EVALUATION_ERROR",
    path: "/all/1",
    message: "Condition field is missing or has an unsupported value type."
  });
  assert.equal(evaluate({
    any: [
      { field: "task.status", op: "eq", value: "done" },
      invalidFieldCondition
    ]
  }, { task: { status: "done" } }).status, "evaluation_error");
});

void test("rejects excessive depth, node count, array length, string size, and encoded payload size", () => {
  let nested: unknown = { field: "task.status", op: "eq", value: "done" };
  for (let depth = 1; depth < automationLimits.conditionDepth; depth += 1) {
    nested = { not: nested };
  }
  assert.equal(validateCondition({ not: nested }, testFieldDefinitions).success, false);

  const tooManyNodes = {
    all: Array.from({ length: automationLimits.nodes }, () => ({
      field: "task.status",
      op: "eq",
      value: "done"
    }))
  };
  assert.equal(validateCondition(tooManyNodes, testFieldDefinitions).success, false);

  assert.equal(validateCondition({
    field: "task.status",
    op: "in",
    value: Array.from({ length: automationLimits.arrayValues + 1 }, (_, index) => String(index))
  }, testFieldDefinitions).success, false);

  assert.equal(validateCondition({
    field: "task.status",
    op: "eq",
    value: "x".repeat(automationLimits.stringBytes + 1)
  }, testFieldDefinitions).success, false);

  assert.equal(validateCondition({
    all: Array.from({ length: 20 }, () => ({
      field: "task.status",
      op: "eq",
      value: "x".repeat(3_500)
    }))
  }, testFieldDefinitions).success, false);

  assert.equal(validateCondition({
    field: "task.status",
    op: "in",
    value: Array.from({ length: automationLimits.arrayValues }, () => "x".repeat(600))
  }, testFieldDefinitions).success, true);
});

void test("rejects invalid JSON values and cyclic input", () => {
  assert.equal(validateCondition({ field: "task.status", op: "eq", value: Number.NaN }, testFieldDefinitions).success, false);
  const cyclic: { not?: unknown } = {};
  cyclic.not = cyclic;
  assert.equal(validateCondition(cyclic, testFieldDefinitions).success, false);
});

void test("returns stable results for repeated evaluation of the same input", () => {
  const condition = {
    all: [
      { field: "task.status", op: "eq", value: "done" },
      { field: "task.archived", op: "eq", value: false }
    ]
  };
  const event = { task: { status: "done", archived: false } };

  assert.deepEqual(evaluate(condition, event), evaluate(condition, event));
});
