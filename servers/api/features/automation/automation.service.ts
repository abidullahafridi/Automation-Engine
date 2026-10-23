import { hashRuleDocument } from "./version.lifecycle.service.js";
import type {
  AutomationCursor,
  AutomationPage,
  AutomationRepository,
  AutomationHeader,
  CreateAutomationResult
} from "./automation.repository.js";
import type { Principal, WorkspaceScope } from "./automation.ports.js";

export type Clock = Readonly<{ now: () => string }>;
export type Rng = Readonly<{ nextId: () => string }>;

export type AutomationApplicationService = Readonly<{
  createDraft: (
    scope: WorkspaceScope,
    principal: Principal,
    input: Readonly<{ name: string; draft: unknown; idempotencyKey: string }>
  ) => Promise<CreateAutomationResult>;
  findById: (scope: WorkspaceScope, automationId: string) => Promise<AutomationHeader | undefined>;
  list: (
    scope: WorkspaceScope,
    page: Readonly<{ after: AutomationCursor | undefined; limit: number }>
  ) => Promise<AutomationPage>;
}>;

export const createAutomationApplicationService = ({
  repository,
  clock,
  rng
}: Readonly<{
  repository: AutomationRepository;
  clock: Clock;
  rng: Rng;
}>): AutomationApplicationService => Object.freeze({
  createDraft: async (scope, principal, input): Promise<CreateAutomationResult> => {
    const requestHash = hashRuleDocument({ name: input.name, draft: input.draft });
    if (!requestHash.success) return Object.freeze({ kind: "idempotency-conflict" });
    return repository.createDraft(scope, {
      automationId: rng.nextId(),
      name: input.name,
      createdBy: principal.id,
      draft: input.draft,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash.contentHash,
      now: clock.now()
    });
  },
  findById: (scope, automationId) => repository.findById(scope, automationId),
  list: (scope, page) => repository.list(scope, page)
});
