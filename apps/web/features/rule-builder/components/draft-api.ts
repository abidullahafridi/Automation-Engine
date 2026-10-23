import { formStateToRulePayload } from "./schema";
import type { RuleDraftFormState, SaveDraftResult } from "./types";

export type DraftSaveRequest = Readonly<{
  apiBaseUrl: string;
  workspaceId: string;
  automationId?: string;
  bearerToken: string;
  draft: RuleDraftFormState;
  revision?: number;
}>;

const readErrorMessage = async (response: Response): Promise<string | undefined> => {
  const value: unknown = await response.json().catch(() => undefined);
  if (typeof value !== "object" || value === null || !("error" in value)) return undefined;
  const error = value.error;
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined;
  return typeof error.message === "string" ? error.message : undefined;
};

export const saveAutomationDraft = async (
  input: DraftSaveRequest,
  request: typeof fetch = fetch
): Promise<SaveDraftResult> => {
  const token = input.bearerToken.trim();
  const workspaceId = input.workspaceId.trim();
  if (!token) return { kind: "error", message: "Enter a platform access token before saving to the automation API." };
  if (!workspaceId) return { kind: "error", message: "Enter a workspace ID before saving to the automation API." };

  const automationPath = input.automationId
    ? `/automations/${encodeURIComponent(input.automationId)}`
    : "/automations";
  const url = `${input.apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}${automationPath}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "Idempotency-Key": `save-${globalThis.crypto.randomUUID()}`
  };
  if (input.revision !== undefined) headers["If-Match"] = `"${input.revision}"`;

  let response: Response;
  try {
    response = await request(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: input.draft.name, draft: formStateToRulePayload(input.draft) })
    });
  } catch {
    return { kind: "error", message: "Automation API could not be reached; the draft was not saved." };
  }

  if (response.status === 409) {
    return {
      kind: "conflict",
      message: await readErrorMessage(response) ?? "Automation was modified by another session; reload and retry with the current revision.",
      ...(input.revision === undefined ? {} : { expectedRevision: input.revision })
    };
  }
  if (response.status === 400) {
    const value: unknown = await response.json().catch(() => undefined);
    if (typeof value === "object" && value !== null && "errors" in value && Array.isArray(value.errors)) {
      return { kind: "validation-error", errors: value.errors };
    }
  }
  if (!response.ok) {
    return {
      kind: "error",
      message: await readErrorMessage(response) ?? `Request failed with status ${response.status}; the draft was not saved.`
    };
  }

  const value: unknown = await response.json().catch(() => undefined);
  if (typeof value !== "object" || value === null || !("automation" in value)) {
    return { kind: "error", message: "Automation API returned an invalid response; the draft was not saved." };
  }
  const automation = value.automation;
  if (typeof automation !== "object" || automation === null) {
    return { kind: "error", message: "Automation API returned an invalid response; the draft was not saved." };
  }
  const automationId = "automationId" in automation && typeof automation.automationId === "string"
    ? automation.automationId
    : undefined;
  const revision = "revision" in automation && typeof automation.revision === "number"
    ? automation.revision
    : undefined;
  if (!automationId || revision === undefined) {
    return { kind: "error", message: "Automation API returned an incomplete response; the draft was not saved." };
  }
  return { kind: "success", automationId, revision };
};
