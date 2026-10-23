export { createConditionEvaluator } from "./condition.evaluator.js";
export type { ConditionEvaluation } from "./condition.evaluator.js";
export {
  actionRegistry,
  createActionRegistry,
  createRegistry,
  createTriggerRegistry,
  notificationSendAction,
  taskStatusChangedFields,
  taskStatusChangedTrigger,
  triggerRegistry
} from "./automation.registry.js";
export type {
  ActionRegistration,
  ActionRegistry,
  Registry,
  TriggerRegistration,
  TriggerRegistry
} from "./automation.registry.js";
export {
  automationLimits,
  conditionOperators,
  isIsoInstant,
  validateCondition
} from "./condition.validation.js";
export type {
  ConditionExpression,
  ConditionFieldDefinition,
  ConditionFieldDefinitions,
  ConditionOperator,
  ConditionScalar,
  ConditionValidationIssue,
  ConditionValidationResult,
  ConditionValue
} from "./condition.validation.js";
export { validateRuleDraft } from "./rule.validation.js";
export {
  createPrincipalResolver,
  createDenyAllPrincipalResolver,
  createDenyAllPolicyPort,
  automationExecutionPrincipal,
  authorizeAutomationExecution
} from "./automation.ports.js";
export type {
  PolicyPort,
  Principal,
  PrincipalResolution,
  PrincipalResolutionInput,
  PrincipalResolver,
  WorkspaceScope
} from "./automation.ports.js";
export {
  automationRepositoryMethodNames,
  createInMemoryAutomationRepository
} from "./automation.repository.js";
export {
  automationCollectionNames,
  createMongoAutomationRepository,
  ensureAutomationRepositoryIndexes
} from "./automation.mongo-repository.js";
export type { AutomationCollectionNames } from "./automation.mongo-repository.js";
export type {
  AutomationCursor,
  AutomationHeader,
  AutomationPage,
  AutomationRepository,
  PublishedAutomationVersion
} from "./automation.repository.js";
export { createAutomationApplicationService } from "./automation.service.js";
export type { AutomationApplicationService, Clock, Rng } from "./automation.service.js";
export { createAutomationRoutes } from "./automation.routes.js";
export type { AutomationApiDependencies } from "./automation.routes.js";
export { publishAutomationVersion } from "./version.repository.service.js";
export type { PublishVersionResult } from "./version.repository.service.js";
export { createInMemoryAuditStore } from "./audit.port.js";
export type { AuditPort, InMemoryAuditStore } from "./audit.port.js";
export { transitionAutomationLifecycleWithAudit } from "./audit.lifecycle.service.js";
export {
  isDomainEventSchemaBackwardCompatible,
  taskStatusChangedEventV1Schema,
  validateTaskStatusChangedEvent
} from "./domain-event.js";
export type { TaskStatusChangedEventV1 } from "./domain-event.js";
export type {
  RuleDocument,
  RuleValidationCode,
  RuleValidationIssue,
  RuleValidationResult
} from "./rule.validation.js";
export {
  createAutomationLifecycle,
  hashRuleDocument,
  pinActiveVersion,
  publishAutomationDraft,
  resolvePinnedVersion,
  saveAutomationDraft,
  transitionAutomationLifecycle,
  verifyPublishedVersionHash
} from "./version.lifecycle.service.js";
export type {
  AutomationLifecycleState,
  AutomationLifecycleStatus,
  AutomationRunVersionPin,
  LifecycleAuditAction,
  LifecycleAuditEvent,
  LifecycleAuditOutcome,
  LifecycleIssue,
  LifecycleMutationResult,
  LifecycleTransitionInput,
  PublishedRuleVersion,
  PublishedVersionResult
} from "./version.lifecycle.service.js";

export type {
  ActionStatus,
  DeadLetterDetail,
  DeadLetterInfo,
  RunStatus,
  StoredRun
} from "./run.repository.js";

// Schedule features (AE-T-060.1 / AE-T-060.2)
export {
  computeNextOccurrence,
  isValidTimeZone,
  minScheduleIntervalMs,
  occurrenceKey,
  resolveLocalTime,
  validateSchedule
} from "./schedule.occurrence.js";
export type {
  LocalTimeKind,
  LocalTimeResolution,
  OccurrenceSkipReason,
  ScheduleDefinition,
  ScheduleIssue,
  ScheduleIssueCode,
  ScheduleOccurrence
} from "./schedule.occurrence.js";
export {
  createInMemoryScheduleRepository,
  createMongoScheduleRepository,
  ensureScheduleRepositoryIndexes,
  maxDuePage,
  scheduleCollectionNames,
  scheduleRepositoryMethodNames
} from "./schedule.repository.js";
export type {
  AdvanceCursorInput,
  RegisterScheduleInput,
  ScheduleCollectionNames,
  ScheduleCursor,
  ScheduleRepository
} from "./schedule.repository.js";
export {
  createScheduleService,
  defaultCatchUpWindowMs,
  defaultMaxOccurrencesPerTick,
  defaultTickLimit,
  planCatchUp
} from "./schedule.scheduler.js";
export type {
  CatchUpPlan,
  RegisterScheduleRequest,
  RegisterScheduleResult,
  ScheduleService,
  ScheduleTelemetry,
  TickSummary
} from "./schedule.scheduler.js";


export {
  createDefaultReleaseSnapshot,
  decideExecution,
  decideIntake,
  findExpiredFlagDefinitions,
  flagDefinitions,
  inFlightPolicy,
  normalizeFlagState,
  releaseFlagNames
} from "./release.flags.js";
export type {
  FlagDefinition,
  FlagState,
  KillSwitchMode,
  KillSwitchState,
  ReleaseFlagName,
  ReleaseSnapshot,
  RolloutDecision,
  RolloutMode
} from "./release.flags.js";
export { createInMemoryReleaseControlStore } from "./release.store.js";
export type { ReleaseControlStore } from "./release.store.js";
export { createReleaseGate } from "./release.gate.js";
export type { ReleaseGate } from "./release.gate.js";
export { createInMemoryReleaseAuditStore, createRecorderReleaseAuditPort } from "./release.audit.js";
export type { ReleaseAuditEvent, ReleaseAuditPort } from "./release.audit.js";
export { createReleaseControlService, releasePermissions } from "./release.control.service.js";
export type { ReleaseControlResult, ReleaseControlService } from "./release.control.service.js";

export { alertRules, alertRuleIds, createAlertThresholds, evaluateAlerts, operatingOwner } from "./ops.alerts.js";
export type { Alert, AlertEvaluation, AlertLevel, AlertRule, AlertRuleId, AlertThresholds } from "./ops.alerts.js";
export {
  criticalMetricNames,
  dashboardPanels,
  findAlertRulesWithoutPanel,
  findInvalidPanels,
  findUncoveredMetrics
} from "./ops.dashboard.js";
export type { DashboardPanel, PanelKind } from "./ops.dashboard.js";
export { createOpsMonitor } from "./ops.monitor.js";
export type { AlertSink, AlertTransition, MonitorTick, OpsMonitor } from "./ops.monitor.js";
export { createDlqRunbook } from "./ops.runbook.js";
export type { DlqDiagnoseResult, DlqDiagnosis, DlqNextStep, DlqRunbook } from "./ops.runbook.js";
export { collectOpsSignals, createOutboxHealthSource, opsSignalNames } from "./ops.signals.js";
export type {
  OpsSignalName,
  OpsSignalSources,
  OpsSignals,
  OutboxHealth,
  RunQueueHealth,
  RunQueueHealthPort,
  SignalSource
} from "./ops.signals.js";
export { createMongoRunQueueHealth } from "./run.history.repository.js";

export { evaluateSecurityGate, findingSources, findingStatuses, knownFindings, severityLevels } from "./security.findings.js";
export type {
  FindingSource,
  FindingStatus,
  GateBlockCode,
  GateIssue,
  RiskException,
  SecurityFinding,
  SecurityGateResult,
  Severity
} from "./security.findings.js";
export { buildSecurityReport, renderSecurityReportMarkdown, requiredEvidenceIds } from "./security.report.js";
export type { ReportStatus, ReviewerApproval, SecurityReport, TestEvidence } from "./security.report.js";
