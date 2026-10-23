"use client";

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Card, CardContent, PageHeader, PageShell } from "@workspace/ui";
import { Activity, RefreshCw } from "lucide-react";
import { WorkspaceConnectionFields } from "./connection-fields";

const TOKEN_KEY = "automation_console_bearer_token";
const WORKSPACE_KEY = "automation_console_workspace_id";
type OpsData = Readonly<{
  signals: Readonly<{
    collectedAt: string;
    queue?: Readonly<{ queuedCount: number; oldestEligibleAgeMs?: number; expiredRunningCount: number }>;
    outbox?: Readonly<{ pendingCount: number; oldestPendingAgeMs?: number }>;
    deadLetter?: Readonly<{ count: number; oldestAgeMs?: number }>;
    failed: readonly string[];
  }>;
  alerts: Readonly<{ alerts: readonly Readonly<{ ruleId: string; level: string; summary: string; value: number; runbook: string }>[]; unmonitored: readonly string[] }>;
}>;

const OperationsConsole = ({ apiBaseUrl }: Readonly<{ apiBaseUrl: string }>): ReactElement => {
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [data, setData] = useState<OpsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (credential: string): Promise<void> => {
    if (!credential || !workspaceId.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automation-ops`, {
        headers: { Authorization: `Bearer ${credential}` }, cache: "no-store"
      });
      if (!response.ok) throw new Error(`Operations data unavailable (${response.status}); authorization or signal adapters may be missing.`);
      setData(await response.json() as OpsData);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load operations data."); setData(null); }
    finally { setBusy(false); }
  }, [apiBaseUrl, workspaceId]);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const stored = window.sessionStorage.getItem(TOKEN_KEY);
      if (stored) setToken(stored);
      setWorkspaceId(window.sessionStorage.getItem(WORKSPACE_KEY) ?? "");
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);
  useEffect(() => {
    if (!token || !workspaceId.trim()) return;
    const handle = window.setTimeout(() => { void load(token); }, 0);
    return () => window.clearTimeout(handle);
  }, [load, token, workspaceId]);
  const metrics = data?.signals;
  return <PageShell>
    <PageHeader description="Live, workspace-scoped queue, outbox and dead-letter signals with evaluated alerts." eyebrow="Automation operations" icon={<Activity aria-hidden="true" className="size-5 text-primary" />} title="Operations dashboard" />
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><WorkspaceConnectionFields token={token} onTokenChange={(value) => { setToken(value); if (value) window.sessionStorage.setItem(TOKEN_KEY, value); else window.sessionStorage.removeItem(TOKEN_KEY); }} workspaceId={workspaceId} onWorkspaceChange={(value) => { const normalized = value.trim(); setWorkspaceId(normalized); window.sessionStorage.setItem(WORKSPACE_KEY, normalized); }} description="Use the same token for this browser tab; API access is checked for every request." /></div><Button className="mb-1" disabled={!token || !workspaceId.trim() || busy} onClick={() => void load(token)} variant="outline"><RefreshCw aria-hidden="true" /> Refresh</Button></div>
      {error && <Alert variant="destructive"><AlertTitle>Live operations data unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {data && <>
        <p className="text-xs text-muted-foreground">Snapshot at {new Date(data.signals.collectedAt).toLocaleString()}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Card><CardContent className="py-5"><h2 className="font-semibold">Run queue</h2><p className="mt-2 text-2xl">{metrics?.queue?.queuedCount ?? "—"}</p><p className="text-sm text-muted-foreground">Oldest eligible age: {metrics?.queue?.oldestEligibleAgeMs ?? "unavailable"} ms</p><p className="text-sm text-muted-foreground">Expired leases: {metrics?.queue?.expiredRunningCount ?? "—"}</p></CardContent></Card>
          <Card><CardContent className="py-5"><h2 className="font-semibold">Outbox</h2><p className="mt-2 text-2xl">{metrics?.outbox?.pendingCount ?? "—"}</p><p className="text-sm text-muted-foreground">Oldest pending age: {metrics?.outbox?.oldestPendingAgeMs ?? "unavailable"} ms</p></CardContent></Card>
          <Card><CardContent className="py-5"><h2 className="font-semibold">Dead letters</h2><p className="mt-2 text-2xl">{metrics?.deadLetter?.count ?? "—"}</p><p className="text-sm text-muted-foreground">Oldest age: {metrics?.deadLetter?.oldestAgeMs ?? "unavailable"} ms</p></CardContent></Card>
        </div>
        <section aria-labelledby="ops-alerts-heading"><h2 className="mb-3 text-lg font-semibold" id="ops-alerts-heading">Current alerts</h2>{data.alerts.alerts.length === 0 ? <Card><CardContent className="py-5 text-sm">No configured threshold alerts are firing.</CardContent></Card> : <div className="space-y-3">{data.alerts.alerts.map((item) => <Alert key={item.ruleId} variant={item.level === "critical" ? "destructive" : "default"}><div className="flex items-start justify-between gap-2"><div><AlertTitle>{item.ruleId}: {item.summary}</AlertTitle><AlertDescription>Observed value: {item.value} · Runbook: {item.runbook}</AlertDescription></div><Badge>{item.level}</Badge></div></Alert>)}</div>}{(data.alerts.unmonitored.length > 0 || metrics?.failed.length) ? <Alert className="mt-3" variant="destructive"><AlertTitle>Monitoring gaps</AlertTitle><AlertDescription>Unmonitored: {data.alerts.unmonitored.join(", ") || "none"}. Failed sources: {metrics?.failed.join(", ") || "none"}.</AlertDescription></Alert> : null}</section>
        <p className="text-sm text-muted-foreground">This page evaluates live signals; paging/ticket routing is not configured by this dashboard.</p>
      </>}
      {!token && <p className="text-sm text-muted-foreground">Connect with the real platform identity token to request authorized workspace operations data.</p>}
    </div>
  </PageShell>;
};

export default OperationsConsole;
