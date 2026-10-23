import assert from "node:assert/strict";
import test from "node:test";
import { createInMemoryAuditStore } from "../audit.port.js";
import { transitionAutomationLifecycleWithAudit } from "../audit.lifecycle.service.js";
import { createPrincipalResolver } from "../automation.ports.js";
import type { AutomationLifecycleState } from "../version.lifecycle.service.js";

const resolver = createPrincipalResolver({
  authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
  hasWorkspaceMembership: () => Promise.resolve(true)
});

const resolvedScope = async () => {
  const result = await resolver.resolve({
    credential: "user-1",
    requestedWorkspaceId: "workspace-1"
  });
  if (result.kind !== "resolved") throw new Error("Expected the test resolver to resolve.");
  return result.scope;
};

const lifecycleState: AutomationLifecycleState = Object.freeze({
  automationId: "automation-1",
  revision: 0,
  draft: null,
  hasDraft: false,
  versions: Object.freeze([]),
  activeVersion: 1,
  status: "draft",
  auditEvents: Object.freeze([])
});

void test("lifecycle transition appends a safe event through append-only AuditPort", async () => {
  const scope = await resolvedScope();
  const store = createInMemoryAuditStore(resolver.ownsScope);
  let time = 0;
  let random = 0;
  const result = await transitionAutomationLifecycleWithAudit(lifecycleState, {
    scope,
    principal: { type: "user", id: "user-1" },
    action: "enable",
    expectedRevision: 0
  }, {
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => Promise.resolve(true) },
    auditPort: store.auditPort,
    clock: { now: () => `2026-10-14T12:00:0${String(time++)}Z` },
    rng: { nextId: () => `correlation-${String(++random)}` }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(store.auditPort), ["append"]);
  const events = await store.read(scope, "automation-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, "succeeded");
});

void test("denied lifecycle authorization is appended as denied without changing status", async () => {
  const scope = await resolvedScope();
  const store = createInMemoryAuditStore(resolver.ownsScope);
  const result = await transitionAutomationLifecycleWithAudit(lifecycleState, {
    scope,
    principal: { type: "user", id: "user-1" },
    action: "enable",
    expectedRevision: 0
  }, {
    ownsScope: resolver.ownsScope,
    policy: { authorize: () => Promise.resolve(false) },
    auditPort: store.auditPort,
    clock: { now: () => "2026-10-14T12:00:00Z" },
    rng: { nextId: () => "correlation-denied" }
  });
  assert.equal(result.ok, false);
  assert.ok("auditEvent" in result);
  assert.equal(result.state.status, "draft");
  const events = await store.read(scope, "automation-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.outcome, "denied");
});

void test("audit append reconstructs allowlisted fields and excludes secret extras", async () => {
  const scope = await resolvedScope();
  const store = createInMemoryAuditStore(resolver.ownsScope);
  const actor = { type: "user" as const, id: "user-1", token: "sensitive-actor-extra" };
  const event = {
    workspaceId: "workspace-1",
    actor,
    action: "enable",
    target: { type: "automation", id: "automation-1" },
    occurredAt: "2026-10-14T12:00:00Z",
    outcome: "succeeded",
    correlationId: "correlation-1",
    change: { status: { from: "draft", to: "enabled" }, version: 1 },
    apiKey: "sensitive-top-level-extra"
  } as const;
  await store.auditPort.append(scope, event);
  const output = JSON.stringify(await store.read(scope, "automation-1"));
  assert.equal(output.includes("sensitive-actor-extra"), false);
  assert.equal(output.includes("sensitive-top-level-extra"), false);
});
