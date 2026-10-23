import { hashRuleDocument } from "./version.lifecycle.service.js";
import { validateRuleDraft } from "./rule.validation.js";
import type {
  AutomationRepository,
  PublishedAutomationVersion
} from "./automation.repository.js";
import type { WorkspaceScope } from "./automation.ports.js";

export type PublishVersionResult =
  | Readonly<{ ok: true; version: PublishedAutomationVersion; revision: number; idempotent: boolean }>
  | Readonly<{ ok: false; kind: "not-found" | "conflict" | "invalid"; code: string }>;

export const publishAutomationVersion = async (
  repository: AutomationRepository,
  scope: WorkspaceScope,
  automationId: string,
  expectedRevision: number,
  publishKey: string,
  now: string
): Promise<PublishVersionResult> => {
  if (publishKey.length === 0) {
    return Object.freeze({ ok: false, kind: "invalid", code: "AUTOMATION_INVALID_PUBLISH_KEY" });
  }
  const header = await repository.findById(scope, automationId);
  if (!header) return Object.freeze({ ok: false, kind: "not-found", code: "AUTOMATION_NOT_FOUND" });

  const existing = await repository.findVersionByPublishKey(scope, automationId, publishKey);
  if (
    existing &&
    header.currentVersion === existing.version &&
    header.rev === expectedRevision + 1
  ) {
    return Object.freeze({ ok: true, version: existing, revision: header.rev, idempotent: true });
  }
  if (header.rev !== expectedRevision) {
    return Object.freeze({ ok: false, kind: "conflict", code: "AUTOMATION_REVISION_CONFLICT" });
  }
  if (!header.hasDraft) {
    return Object.freeze({ ok: false, kind: "invalid", code: "AUTOMATION_DRAFT_NOT_FOUND" });
  }

  const validation = validateRuleDraft(header.draft);
  if (!validation.valid) {
    return Object.freeze({ ok: false, kind: "invalid", code: "AUTOMATION_INVALID_RULE" });
  }
  const hash = hashRuleDocument(validation.rule);
  if (!hash.success) {
    return Object.freeze({ ok: false, kind: "invalid", code: "AUTOMATION_INVALID_RULE" });
  }
  if (existing && existing.contentHash !== hash.contentHash) {
    return Object.freeze({ ok: false, kind: "conflict", code: "AUTOMATION_PUBLISH_KEY_CONFLICT" });
  }

  const versions = await repository.listVersions(scope, automationId);
  const nextVersion = existing?.version ?? ((versions[versions.length - 1]?.version ?? 0) + 1);
  const version: PublishedAutomationVersion = existing ?? Object.freeze({
    automationId,
    workspaceId: scope.workspaceId,
    version: nextVersion,
    schemaVersion: validation.rule.schemaVersion,
    contentHash: hash.contentHash,
    publishKey,
    rule: validation.rule,
    createdAt: now
  });
  const inserted = await repository.insertVersion(scope, version);
  if (inserted.kind === "conflict") {
    return Object.freeze({ ok: false, kind: "conflict", code: "AUTOMATION_VERSION_CONFLICT" });
  }
  const update = await repository.compareAndSetCurrentVersion(
    scope,
    automationId,
    expectedRevision,
    inserted.version.version
  );
  if (update === "not-found") {
    return Object.freeze({ ok: false, kind: "not-found", code: "AUTOMATION_NOT_FOUND" });
  }
  if (update === "conflict") {
    const recheckedHeader = await repository.findById(scope, automationId);
    if (
      recheckedHeader &&
      recheckedHeader.currentVersion === inserted.version.version &&
      recheckedHeader.rev === expectedRevision + 1
    ) {
      return Object.freeze({
        ok: true,
        version: inserted.version,
        revision: recheckedHeader.rev,
        idempotent: true
      });
    }
    return Object.freeze({ ok: false, kind: "conflict", code: "AUTOMATION_REVISION_CONFLICT" });
  }
  const updatedHeader = await repository.findById(scope, automationId);
  if (!updatedHeader) throw new Error("Version publish updated a missing automation header.");
  return Object.freeze({
    ok: true,
    version: inserted.version,
    revision: updatedHeader.rev,
    idempotent: inserted.kind === "idempotent" || update === "idempotent"
  });
};
