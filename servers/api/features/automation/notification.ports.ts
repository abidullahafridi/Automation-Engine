// Ports for the notification.send action (AE-T-031.2).
// Dependency-free: no Mongo, no HTTP, no clock. Real adapters belong to the platform
// directory and notification services and are not part of this task.

export type MemberStatus = "active" | "disabled" | "deleted";

export type WorkspaceMember = Readonly<{
  userId: string;
  status: MemberStatus;
}>;

/**
 * Resolves the project lead for the task behind a run.
 * MUST be scoped by workspaceId: a run or project from another workspace returns null
 * (indistinguishable from "no lead") so existence never leaks.
 */
export interface RecipientDirectoryPort {
  findProjectLeadForRun(workspaceId: string, runId: string): Promise<WorkspaceMember | null>;
}

export type TemplateVariables = Readonly<Record<string, string | number | boolean>>;

/** Adapter point: later reads the run's event snapshot. Must be workspace-scoped. */
export interface TemplateVariablesPort {
  forRun(workspaceId: string, runId: string): Promise<TemplateVariables>;
}

export type NotificationSendRequest = Readonly<{
  workspaceId: string;
  recipientUserId: string;
  templateKey: string;
  title: string;
  body: string;
  /** Deterministic key from the executor; the notification service must dedupe on it. */
  idempotencyKey: string;
}>;

export type NotificationSendResult = Readonly<{
  notificationId: string;
  /** true when the key was already used and no new notification was created. */
  deduplicated: boolean;
}>;

export interface NotificationPort {
  send(
    request: NotificationSendRequest,
    options: Readonly<{ signal: AbortSignal }>
  ): Promise<NotificationSendResult>;
}

export type ProviderErrorKind = "transient" | "permanent";

export class NotificationProviderError extends Error {
  readonly kind: ProviderErrorKind;

  constructor(kind: ProviderErrorKind, message: string) {
    super(message);
    this.name = "NotificationProviderError";
    this.kind = kind;
  }
}