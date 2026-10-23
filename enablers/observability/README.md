# Operational Observability

This enabler owns deployment and operations concerns for metrics, traces, log shipping,
dashboards, alerts, and runtime telemetry infrastructure when those capabilities are
required. No provider-specific operational configuration is justified yet.

Reusable application and HTTP logging implementation belongs to `packages/logging`.
Workspace runtimes consume that package and do not duplicate logging under local
`observability/` directories.
