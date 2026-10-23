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

export type PrincipalResolverDependencies = Readonly<{
  authenticate: (credential: string) => Promise<Principal | undefined>;
  hasWorkspaceMembership: (principal: Principal, workspaceId: string) => Promise<boolean>;
}>;

const unavailable: PrincipalResolution = Object.freeze({
  kind: "service-unavailable",
  message: "Platform authentication adapter is unavailable."
});

const isPrincipal = (value: unknown): value is Principal => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate["type"] === "user" || candidate["type"] === "automation" || candidate["type"] === "system") &&
    typeof candidate["id"] === "string" &&
    candidate["id"].length > 0 &&
    (candidate["creatorId"] === undefined || typeof candidate["creatorId"] === "string")
  );
};

export const createPrincipalResolver = ({
  authenticate,
  hasWorkspaceMembership
}: PrincipalResolverDependencies): PrincipalResolver => {
  const mintedScopes = new WeakSet();

  const ownsScope = (scope: unknown): scope is WorkspaceScope =>
    typeof scope === "object" &&
    scope !== null &&
    mintedScopes.has(scope);

  return Object.freeze({
    resolve: async (input: PrincipalResolutionInput): Promise<PrincipalResolution> => {
      if (input.credential === undefined || input.credential.length === 0) {
        return Object.freeze({ kind: "unauthenticated" });
      }
      let principal: Principal | undefined;
      try {
        principal = await authenticate(input.credential);
      } catch {
        return unavailable;
      }
      if (principal === undefined) return Object.freeze({ kind: "unauthenticated" });
      if (!isPrincipal(principal)) return unavailable;
      let isMember: boolean;
      try {
        isMember = await hasWorkspaceMembership(principal, input.requestedWorkspaceId);
      } catch {
        return unavailable;
      }
      if (!isMember) {
        return Object.freeze({ kind: "not-found" });
      }
      const scope = Object.freeze({
        workspaceId: input.requestedWorkspaceId,
        [workspaceScopeBrand]: true as const
      });
      mintedScopes.add(scope);
      return Object.freeze({ kind: "resolved", principal, scope });
    },
    ownsScope
  });
};

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

export const automationExecutionPrincipal = (automationId: string, creatorId: string): Principal =>
  Object.freeze({ type: "automation", id: `automation:${automationId}`, creatorId });

export const authorizeAutomationExecution = async (
  policy: PolicyPort,
  automationId: string,
  creatorId: string,
  permission: string,
  resource: PermissionResource
): Promise<boolean> => {
  const delegated = automationExecutionPrincipal(automationId, creatorId);
  const [automationAllowed, creatorAllowed] = await Promise.all([
    policy.authorize(delegated, permission, resource),
    policy.authorize(Object.freeze({ type: "user", id: creatorId }), permission, resource)
  ]);
  return automationAllowed && creatorAllowed;
};

export const createDenyAllPrincipalResolver = (): PrincipalResolver =>
  Object.freeze({
    resolve: () => Promise.resolve(Object.freeze({
      kind: "service-unavailable",
      message: "Platform authentication adapter is not configured."
    })),
    ownsScope: (_scope: unknown): _scope is WorkspaceScope => false
  });

export const createDenyAllPolicyPort = (): PolicyPort =>
  Object.freeze({
    authorize: () => Promise.resolve(false)
  });
