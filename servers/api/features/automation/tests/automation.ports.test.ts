import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeAutomationExecution,
  createPrincipalResolver
} from "../automation.ports.js";
import type { Principal } from "../automation.ports.js";

void test("only a resolver-minted workspace scope is recognized as trusted", async () => {
  const resolver = createPrincipalResolver({
    authenticate: (credential) => Promise.resolve({ type: "user", id: credential }),
    hasWorkspaceMembership: (_principal, workspaceId) => Promise.resolve(workspaceId === "workspace-a")
  });
  assert.equal((await resolver.resolve({
    credential: undefined,
    requestedWorkspaceId: "workspace-a"
  })).kind, "unauthenticated");
  assert.equal((await resolver.resolve({
    credential: "user-a",
    requestedWorkspaceId: "workspace-b"
  })).kind, "not-found");
  const resolved = await resolver.resolve({
    credential: "user-a",
    requestedWorkspaceId: "workspace-a"
  });
  assert.equal(resolved.kind, "resolved");
  assert.ok("scope" in resolved);
  assert.equal(resolver.ownsScope(resolved.scope), true);
  assert.equal(resolver.ownsScope({ workspaceId: "workspace-a" }), false);
});

void test("identity and membership provider failures fail closed without exposing provider errors", async () => {
  const identityFailure = createPrincipalResolver({
    authenticate: () => Promise.reject(new Error("provider secret detail")),
    hasWorkspaceMembership: () => Promise.resolve(true)
  });
  const identityResult = await identityFailure.resolve({
    credential: "opaque-token",
    requestedWorkspaceId: "workspace-a"
  });
  assert.deepEqual(identityResult, {
    kind: "service-unavailable",
    message: "Platform authentication adapter is unavailable."
  });

  const membershipFailure = createPrincipalResolver({
    authenticate: () => Promise.resolve({ type: "user", id: "verified-user" }),
    hasWorkspaceMembership: () => Promise.reject(new Error("membership store unavailable"))
  });
  assert.deepEqual(await membershipFailure.resolve({
    credential: "opaque-token",
    requestedWorkspaceId: "workspace-a"
  }), identityResult);

  const malformedIdentity = createPrincipalResolver({
    authenticate: () => Promise.resolve({ type: "client", id: "untrusted" } as unknown as Principal),
    hasWorkspaceMembership: () => Promise.resolve(true)
  });
  assert.deepEqual(await malformedIdentity.resolve({
    credential: "opaque-token",
    requestedWorkspaceId: "workspace-a"
  }), identityResult);
});

void test("execution permission requires both delegated principal and current creator permission", async () => {
  const calls: string[] = [];
  const resource = { type: "task" as const, id: "task-1" };
  const allowed = await authorizeAutomationExecution({
    authorize: (principal, permission, requestedResource) => {
      calls.push(`${principal.id}:${permission}:${requestedResource.id}`);
      return Promise.resolve(true);
    }
  }, "automation-1", "creator-1", "task.update", resource);
  assert.equal(allowed, true);
  assert.deepEqual(calls, [
    "automation:automation-1:task.update:task-1",
    "creator-1:task.update:task-1"
  ]);

  const deniedCreator = await authorizeAutomationExecution({
    authorize: (principal) => Promise.resolve(principal.type === "automation")
  }, "automation-1", "creator-1", "task.update", resource);
  assert.equal(deniedCreator, false);
});
