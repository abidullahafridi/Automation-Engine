# ADR-0008: Tenant isolation and execution identity

- **Status:** Accepted for port contract only
- **Date:** 2026-10-14
- **Decision owner:** abidullah
- **Deferral owner:** `@adeelchainz` (repository owner / CODEOWNER)
- **Owner approval:** Accepted by: abidullah  Date: 14/10/2026.
- **Independent security review:** Pending before production enablement.
- **Next review:** Before integrating a real platform auth/scoped-gateway adapter.

## Context

The repository audit found no workspace-scoped data gateway, principal/policy engine, or
automation authorization implementation. The existing API does not establish those
contracts. The specification proposes required workspace scope on every operation,
execution-time authorization, and a delegated `automation:{automationId}` principal whose
effective authority is bounded by the creator's current permissions.

## Drivers

- Cross-workspace access must fail closed at every boundary.
- Scope must be explicit, trusted, and required by data-access contracts.
- Authorization must be rechecked immediately before effects.
- Automation must not inherit stale or broader human credentials.

## Options

1. **Proposed: wait for the platform auth/scoped-gateway milestone, then adapt its contracts.**
   Avoids inventing a competing policy system but depends on that milestone's ownership and
   delivery.
2. **Build minimum explicit workspace/principal/policy ports in automation.** Could unblock
   implementation but risks duplicating the platform's future auth boundary.
3. **Use ambient user/session identity or unscoped repositories.** Rejected; violates
   tenant isolation and execution-time authorization requirements.

## Decision

**Accepted by: abidullah  Date: 14/10/2026.** This decision accepts only the automation
port contract, not a platform auth implementation or production tenant isolation:

- `PrincipalResolver` resolves an authenticated principal and trusted workspace membership
  into a branded `WorkspaceScope`; only the resolver implementation can mint valid scopes.
- Every automation repository operation requires that scope. Runtime scope validation must
  fail before invoking any storage/driver operation.
- A resource outside the resolved workspace is reported as not found; never disclose its
  existence with a forbidden response.
- Execution uses delegated principal `automation:{automationId}`. Each run re-checks the
  intersection of the action's required permission and the creator's current permission.
  Neither the human session nor token is used as the execution identity.
- `PolicyPort` is the explicit authorization boundary. Tests may use fakes; the real platform
  auth/scoped-gateway adapter remains a later task.
- Automation endpoints remain behind a feature flag that defaults OFF until the real adapter
  is integrated and cross-tenant tests pass against it.

## Consequences

- The port contract is accepted; no real authentication, membership, policy, or gateway
  adapter is present by this decision.
- Port-based/in-memory prototypes must require resolver-minted scope, fail closed, and must
  not be represented as production tenant isolation.
- Automation API flag defaults OFF. Enabling it in production is prohibited until the
  platform adapter and adversarial cross-tenant integration tests pass.
- Durable audit additionally requires an append-only storage role and owner-approved
  retention. A ~400-day period is a proposal only; retention remains pending owner approval.

## Security and operations

Define trusted scope provenance, resource-level permission checks, owner removal/transfer
behavior, audit events, and non-enumerating response semantics. Secrets and human session
tokens must not be passed to handlers or logs.

## Follow-ups and blocked work

- Platform owner: identify and deliver the real auth/scoped-gateway adapter contract.
- Engineering: implement and test ports with in-memory adapters; preserve the default-off API
  flag until platform integration is complete.
- Product/security: review owner-loss/transfer and event-origin behavior before those features
  are implemented.
- **Unblocked at the port/in-memory contract level:** scoped repository, guarded API
  composition, and version/audit services. This does not satisfy production gates.
- **Still blocked for production:** endpoint flag enablement, real scope/policy enforcement,
  cross-tenant integration tests against the platform adapter, and durable audit role/retention.

## Deferral record

Accepted by decision owner abidullah on 14/10/2026 for the port contract only. The repository
still verifies no platform auth/scoped-gateway adapter exists (audit U1/U2). No independent
security review or production adapter evidence is claimed.

## Production-enablement gate

Keep the automation API feature flag OFF until the actual platform adapter is integrated,
principal and workspace scope are derived from trusted authentication/membership, permission
intersection is re-evaluated on each run, and cross-tenant adversarial tests pass against that
adapter. Production audit also requires an append-only role and owner-approved retention.

## Review record

- Port-contract decision owner approval: Accepted by: abidullah  Date: 14/10/2026.
- Independent security reviewer: Pending; no independent review is claimed.
- Platform adapter review and cross-tenant integration evidence: Pending.

## Evidence

- [Automation Engine specification, D-11–D-15 and §11.9](../../automation-engine-spec-v2.md)
- [Backlog, AE-US-040 and AE-US-083](../../automation-engine-backlog.md)
- [Repository audit, U1/U2 and spec conflicts](../architecture/repository-audit.md)
- [Architecture policy](../../architecture.yaml)
- Owner decision record: Accepted by: abidullah  Date: 14/10/2026. Port contract only.
