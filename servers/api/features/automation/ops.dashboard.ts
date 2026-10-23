import { alertRules, type AlertRuleId } from "./ops.alerts.js";
import { metricCatalog } from "./telemetry.metrics.js";

export type PanelKind = "counter-rate" | "histogram" | "gauge";

type PanelLink = Readonly<{ alertRuleId: AlertRuleId }> | Readonly<{ rationale: string }>;

/** Every panel has an in-app alert rule OR an explicit rationale (Done-when of AE-T-071.2). */
export type DashboardPanel = Readonly<{
  id: string;
  title: string;
  metric: string;
  kind: PanelKind;
}> & PanelLink;

const panel = (
  id: string,
  title: string,
  metric: string,
  kind: PanelKind,
  link: PanelLink
): DashboardPanel => Object.freeze({ id, title, metric, kind, ...link });

const backendRate =
  "Rate-based alerting belongs to the metrics backend (enablers/observability). " +
  "It is not evaluated in-app and is not implemented yet; the panel is the evidence for review.";

export const dashboardPanels: readonly DashboardPanel[] = Object.freeze([
  panel("queue-age", "Oldest eligible run age", "automation_oldest_eligible_run_age_seconds", "gauge", { alertRuleId: "QUEUE_AGE" }),
  panel("lease-stalled", "Runs with expired lease", "automation_expired_running_runs", "gauge", { alertRuleId: "LEASE_STALLED" }),
  panel("outbox-age", "Oldest pending outbox event", "automation_outbox_oldest_pending_age_seconds", "gauge", { alertRuleId: "OUTBOX_STALLED" }),
  panel("outbox-pending", "Pending outbox events", "automation_outbox_pending", "gauge", {
    rationale: "Context for the outbox age panel. Age is the stall signal; a count alone is not actionable."
  }),
  panel("dlq-backlog", "Dead-letter backlog", "automation_dead_letter_backlog", "gauge", { alertRuleId: "DEAD_LETTER_BACKLOG" }),
  panel("tenant-scope", "Tenant-scope violations", "automation_tenant_scope_violation_total", "counter-rate", { alertRuleId: "TENANT_SCOPE_VIOLATION" }),
  panel("monitoring-health", "Monitoring signal failures", "automation_ops_signal_failures", "gauge", { alertRuleId: "SIGNAL_UNAVAILABLE" }),
  panel("events", "Events by result", "automation_events_total", "counter-rate", { rationale: backendRate }),
  panel("runs", "Runs by status", "automation_runs_total", "counter-rate", { rationale: backendRate }),
  panel("run-duration", "Run duration", "automation_run_duration_seconds", "histogram", {
    rationale: "Latency target is not approved yet (SLOs are provisional), so there is no threshold to alert on."
  }),
  panel("action-attempts", "Action attempts by outcome", "automation_action_attempts_total", "counter-rate", {
    rationale: `Provider outage signal. ${backendRate}`
  }),
  panel("action-duration", "Action duration", "automation_action_duration_seconds", "histogram", {
    rationale: "Latency target is not approved yet (SLOs are provisional), so there is no threshold to alert on."
  }),
  panel("retries", "Retries", "automation_retries_total", "counter-rate", { rationale: backendRate }),
  panel("loop-guard", "Loop guard trips", "automation_loop_guard_trips_total", "counter-rate", {
    rationale: `Loop spike signal. ${backendRate}`
  }),
  panel("quota-rejections", "Quota rejections", "automation_quota_rejections_total", "counter-rate", {
    rationale: `Throttling signal. ${backendRate}`
  })
]);

/** Catalogue metrics plus the gauges produced by the ops signal collector. */
export const criticalMetricNames: readonly string[] = Object.freeze([
  ...Object.keys(metricCatalog),
  "automation_oldest_eligible_run_age_seconds",
  "automation_expired_running_runs",
  "automation_outbox_oldest_pending_age_seconds",
  "automation_outbox_pending",
  "automation_dead_letter_backlog",
  "automation_tenant_scope_violation_total",
  "automation_ops_signal_failures"
]);

export const findUncoveredMetrics = (
  metricNames: readonly string[] = criticalMetricNames,
  panels: readonly DashboardPanel[] = dashboardPanels
): readonly string[] =>
  Object.freeze(metricNames.filter((name) => !panels.some((item) => item.metric === name)));

/** Empty means every panel is valid: unique id, a known alert rule or a non-empty rationale. */
export const findInvalidPanels = (
  panels: readonly DashboardPanel[] = dashboardPanels
): readonly string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of panels) {
    if (seen.has(item.id)) problems.push(`${item.id}: duplicate panel id`);
    seen.add(item.id);
    if ("alertRuleId" in item) {
      if (!Object.hasOwn(alertRules, item.alertRuleId)) problems.push(`${item.id}: unknown alert rule`);
    } else if (item.rationale.trim().length === 0) {
      problems.push(`${item.id}: missing rationale`);
    }
  }
  return Object.freeze(problems);
};

/** Alert rules whose panel does not exist. Empty means every alert links to a dashboard panel. */
export const findAlertRulesWithoutPanel = (
  panels: readonly DashboardPanel[] = dashboardPanels
): readonly string[] =>
  Object.freeze(Object.values(alertRules)
    .filter((definition) => !panels.some((item) => item.id === definition.panelId))
    .map((definition) => definition.id));