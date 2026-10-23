export type MetricLabels = Readonly<Record<string, string>>;

export type LabelSpec =
  | Readonly<{ kind: "enum"; values: readonly string[] }>
  | Readonly<{ kind: "open"; pattern: RegExp; maxDistinct: number }>;

export type MetricDefinition = Readonly<{
  type: "counter" | "histogram";
  labels: Readonly<Record<string, LabelSpec>>;
}>;

export type MetricName =
  | "automation_events_total"
  | "automation_runs_total"
  | "automation_run_duration_seconds"
  | "automation_action_attempts_total"
  | "automation_action_duration_seconds"
  | "automation_retries_total"
  | "automation_loop_guard_trips_total"
  | "automation_quota_rejections_total";

export type MetricCatalog = Readonly<Record<MetricName, MetricDefinition>>;

const enumLabel = (values: readonly string[]): LabelSpec =>
  Object.freeze({ kind: "enum", values: Object.freeze([...values]) });

/** Bounded free-form label: lowercase dotted/underscored identifier, capped distinct values. */
const openLabel = (): LabelSpec =>
  Object.freeze({ kind: "open", pattern: /^[a-z][a-z0-9_.]{0,63}$/, maxDistinct: 50 });

const runStatuses = enumLabel([
  "queued", "running", "completed", "failed", "cancelled",
  "skipped", "retry_wait", "dead_letter", "unknown_outcome"
]);

/** Spec 14.2. Never add runId, automationId, workspaceId, userId or eventId as labels. */
export const metricCatalog: MetricCatalog = Object.freeze({
  automation_events_total: Object.freeze({
    type: "counter",
    labels: Object.freeze({
      event_type: openLabel(),
      result: enumLabel(["accepted", "duplicate", "rejected", "quarantined"])
    })
  }),
  automation_runs_total: Object.freeze({
    type: "counter",
    labels: Object.freeze({ status: runStatuses, trigger_type: openLabel() })
  }),
  automation_run_duration_seconds: Object.freeze({
    type: "histogram",
    labels: Object.freeze({ status: runStatuses })
  }),
  automation_action_attempts_total: Object.freeze({
    type: "counter",
    labels: Object.freeze({
      action_type: openLabel(),
      outcome: enumLabel(["succeeded", "failed", "timed_out"])
    })
  }),
  automation_action_duration_seconds: Object.freeze({
    type: "histogram",
    labels: Object.freeze({ action_type: openLabel() })
  }),
  automation_retries_total: Object.freeze({
    type: "counter",
    labels: Object.freeze({
      action_type: openLabel(),
      reason: enumLabel(["transient", "ambiguous", "permanent", "exhausted", "age_exceeded"])
    })
  }),
  automation_loop_guard_trips_total: Object.freeze({
    type: "counter",
    labels: Object.freeze({
      reason: enumLabel([
        "SCOPE_MISSING", "LINEAGE_INVALID", "SELF_TRIGGER",
        "HOP_LIMIT_EXCEEDED", "CHAIN_BUDGET_EXCEEDED", "BUDGET_UNAVAILABLE"
      ])
    })
  }),
  automation_quota_rejections_total: Object.freeze({
    type: "counter",
    labels: Object.freeze({ quota: enumLabel(["workspace", "global", "unavailable", "scope"]) })
  })
});

/** Implementations must never throw: telemetry cannot change business behavior. */
export type MetricsPort = Readonly<{
  increment: (name: MetricName, labels: MetricLabels, amount?: number) => void;
  observe: (name: MetricName, labels: MetricLabels, value: number) => void;
}>;

export type MetricRejectionReason =
  | "UNKNOWN_METRIC"
  | "WRONG_TYPE"
  | "LABEL_KEYS"
  | "LABEL_VALUE"
  | "INVALID_AMOUNT";

export type MetricRejection = Readonly<{
  name: string;
  reason: MetricRejectionReason;
}>;

export type InMemoryMetrics = Readonly<{
  metrics: MetricsPort;
  counter: (name: MetricName, labels?: MetricLabels) => number;
  histogram: (name: MetricName, labels?: MetricLabels) => Readonly<{ count: number; sum: number }>;
  rejections: () => readonly MetricRejection[];
  seriesCount: () => number;
}>;

const seriesKey = (name: string, labels: MetricLabels): string =>
  `${name}|${Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",")}`;

export const createInMemoryMetrics = (catalog: MetricCatalog = metricCatalog): InMemoryMetrics => {
  const definitions = new Map<string, MetricDefinition>(Object.entries(catalog));
  const counters = new Map<string, number>();
  const histograms = new Map<string, { count: number; sum: number }>();
  const distinct = new Map<string, Set<string>>();
  const rejected: MetricRejection[] = [];

  const reject = (name: string, reason: MetricRejectionReason): void => {
    rejected.push(Object.freeze({ name, reason }));
  };

  /** Returns true when the series is valid. Distinct-value sets are only extended on success. */
  const admit = (name: string, type: MetricDefinition["type"], labels: MetricLabels): boolean => {
    const definition = definitions.get(name);
    if (definition === undefined) { reject(name, "UNKNOWN_METRIC"); return false; }
    if (definition.type !== type) { reject(name, "WRONG_TYPE"); return false; }

    const expected = Object.keys(definition.labels).sort();
    const actual = Object.keys(labels).sort();
    if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
      reject(name, "LABEL_KEYS");
      return false;
    }

    const pending: { key: string; value: string }[] = [];
    for (const [label, spec] of Object.entries(definition.labels)) {
      const value = labels[label];
      if (value === undefined) { reject(name, "LABEL_KEYS"); return false; }
      if (spec.kind === "enum") {
        if (!spec.values.includes(value)) { reject(name, "LABEL_VALUE"); return false; }
      } else {
        const key = `${name}\u0000${label}`;
        const seen = distinct.get(key);
        if (!spec.pattern.test(value) || (seen !== undefined && !seen.has(value) && seen.size >= spec.maxDistinct)) {
          reject(name, "LABEL_VALUE");
          return false;
        }
        pending.push({ key, value });
      }
    }
    for (const item of pending) {
      const seen = distinct.get(item.key) ?? new Set<string>();
      seen.add(item.value);
      distinct.set(item.key, seen);
    }
    return true;
  };

  const metrics: MetricsPort = Object.freeze({
    increment: (name: MetricName, labels: MetricLabels, amount = 1): void => {
      if (!Number.isSafeInteger(amount) || amount < 1) { reject(name, "INVALID_AMOUNT"); return; }
      if (!admit(name, "counter", labels)) return;
      const key = seriesKey(name, labels);
      counters.set(key, (counters.get(key) ?? 0) + amount);
    },
    observe: (name: MetricName, labels: MetricLabels, value: number): void => {
      if (!Number.isFinite(value) || value < 0) { reject(name, "INVALID_AMOUNT"); return; }
      if (!admit(name, "histogram", labels)) return;
      const key = seriesKey(name, labels);
      const current = histograms.get(key) ?? { count: 0, sum: 0 };
      histograms.set(key, { count: current.count + 1, sum: current.sum + value });
    }
  });

  return Object.freeze({
    metrics,
    counter: (name: MetricName, labels: MetricLabels = {}): number =>
      counters.get(seriesKey(name, labels)) ?? 0,
    histogram: (name: MetricName, labels: MetricLabels = {}): Readonly<{ count: number; sum: number }> =>
      Object.freeze({ ...(histograms.get(seriesKey(name, labels)) ?? { count: 0, sum: 0 }) }),
    rejections: (): readonly MetricRejection[] => Object.freeze([...rejected]),
    seriesCount: (): number => counters.size + histograms.size
  });
};