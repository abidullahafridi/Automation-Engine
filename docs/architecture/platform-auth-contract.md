# Platform Authentication & Authorization Contract (AE-T-010.2b Interface Specification)

**Status:** Gated specification for release gate `AE-T-010.2b` (Epic AE-E07).
**Platform Auth Code Location:** `NONE` (confirmed absent in repository, per audit V14, U1, U2).
**Owner:** Abid Ullah | **Date:** 2026-10-15

---

## 1. Context & Purpose

The SQUiD repository currently contains **no** platform authentication, user session, workspace membership, or policy engine code (M03.3 milestone is unbuilt). The automation engine management API requires caller requests to resolve to a verified `Principal` and a trusted `WorkspaceScope`, with permission evaluation enforced via `PolicyPort`.

In the absence of a platform authentication system, the automation engine enforces:
1. **Scope Split:**
   - **AE-T-010.2a (Done):** Contract, ports (`PrincipalResolver`, `PolicyPort`), a deny-everything default adapter (returning HTTP 503 `AUTOMATION_SERVICE_UNAVAILABLE`), adapter-agnostic test suites, and strict OpenAPI 3.1 documentation. The automation API feature flag remains default **OFF**.
   - **AE-T-010.2b (AE-E07 Release Gate):** Integration of the real platform adapter. Done only when the conformance suite and tenant matrix pass against the actual platform auth service.
2. **Fail-Closed Default:**
   When `automationApiEnabled: true` is configured in production without an explicitly injected platform adapter, the server binds `createDenyAllPrincipalResolver()` and `createDenyAllPolicyPort()`, rejecting all external requests with HTTP 503 without revealing resource existence or leaking internal details.

---

## 2. Inbound Request Boundary (`PrincipalResolver`)

Every management endpoint receives an HTTP request with:
- URL parameter: `:workspaceId`
- Header: `Authorization: Bearer <token>` (optional or mandatory depending on route)

### TypeScript Port Interface

```typescript
export type Principal = Readonly<{
  type: "user" | "automation" | "system";
  id: string;
  creatorId?: string;
}>;

const workspaceScopeBrand: unique symbol = Symbol("workspace-scope");

export type WorkspaceScope = Readonly<{
  workspaceId: string;
  [workspaceScopeBrand]: true;
}>;

export type PrincipalResolutionInput = Readonly<{
  credential: string | undefined;
  requestedWorkspaceId: string;
}>;

export type PrincipalResolution =
  | Readonly<{ kind: "unauthenticated" }>
  | Readonly<{ kind: "not-found" }>
  | Readonly<{ kind: "service-unavailable"; message: string }>
  | Readonly<{ kind: "resolved"; principal: Principal; scope: WorkspaceScope }>;

export type PrincipalResolver = Readonly<{
  resolve: (input: PrincipalResolutionInput) => Promise<PrincipalResolution>;
  ownsScope: (scope: unknown) => scope is WorkspaceScope;
}>;
```

### Resolution Rules

1. **Unauthenticated (`kind: "unauthenticated"`):**
   - Condition: Missing header, empty token, or token rejected by identity provider.
   - HTTP Outcome: `401 Unauthorized` with code `AUTOMATION_UNAUTHENTICATED`.
2. **Non-Member / Unknown Workspace (`kind: "not-found"`):**
   - Condition: Token identifies a valid user, but the user is NOT an active member of `requestedWorkspaceId` (or the workspace does not exist).
   - HTTP Outcome: `404 Not Found` with code `AUTOMATION_NOT_FOUND` (non-enumerating; never discloses workspace existence).
3. **Platform Unavailable (`kind: "service-unavailable"`):**
   - Condition: Platform auth adapter is missing/unconfigured or auth provider is unreachable.
   - HTTP Outcome: `503 Service Unavailable` with code `AUTOMATION_SERVICE_UNAVAILABLE`.
4. **Resolved (`kind: "resolved"`):**
   - Condition: Valid token and confirmed workspace membership.
   - Output: Immutable `Principal` and a branded `WorkspaceScope` minted exclusively by `ownsScope`.

---

## 3. Authorization Boundary (`PolicyPort`)

Once a principal is resolved and scoped to a workspace, all operations consult `PolicyPort`:

```typescript
export type PermissionResource = Readonly<{
  type: "workspace" | "automation" | "task" | "user";
  id: string;
}>;

export type PolicyPort = Readonly<{
  authorize: (
    principal: Principal,
    permission: string,
    resource: PermissionResource
  ) => Promise<boolean>;
}>;
```

### Required Permissions for Automation Features

| Route / Action | Permission Key | Resource Evaluated |
|---|---|---|
| `POST .../automations` | `automation.create` | `{ type: "workspace", id: workspaceId }` |
| `GET .../automations` | `automation.read` | `{ type: "workspace", id: workspaceId }` |
| `GET .../automations/:id` | `automation.read` | `{ type: "automation", id: automationId }` |
| `POST .../automations/validate` | `automation.validate` | `{ type: "workspace", id: workspaceId }` |
| Execution delegation | Action-specific | Evaluates both delegated automation AND creator |

If `authorize(...)` returns `false`, the HTTP boundary returns `404 Not Found` (`AUTOMATION_NOT_FOUND`) to prevent enumeration of automation IDs across unauthorized callers.

---

## 4. Release Gate Acceptance Criteria (`AE-T-010.2b`)

To close AE-T-010.2b in AE-E07, the platform team must provide an implementation satisfying:
1. Valid credentials mint a verified `Principal`.
2. Non-existent or cross-workspace tokens strictly return `not-found` without timing attacks.
3. Branded `WorkspaceScope` cannot be forged by external callers or bypass the resolver.
4. Tenant matrix test suite passes with zero skipped tests against the live platform auth provider.
5. Production enablement stays gated until Abid Ullah signs off on platform verification.

