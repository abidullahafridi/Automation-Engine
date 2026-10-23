"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, PageHeader, PageShell } from "@workspace/ui";
import { CalendarClock, RefreshCw } from "lucide-react";
import { WorkspaceConnectionFields } from "./connection-fields";

const TOKEN_KEY = "automation_console_bearer_token";
const WORKSPACE_KEY = "automation_console_workspace_id";
type AutomationRow = Readonly<{ automationId: string; name: string }>;
type ScheduleRow = Readonly<{ automationId: string; timezone: string; enabled: boolean; nextOccurrenceAt: string; definition: { kind: string } }>;

const SchedulesOverview = ({ apiBaseUrl }: Readonly<{ apiBaseUrl: string }>): ReactElement => {
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [items, setItems] = useState<readonly Readonly<{ automation: AutomationRow; schedule: ScheduleRow }>[] >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (credential: string, after?: string | null): Promise<void> => {
    if (!credential || !workspaceId.trim()) return;
    setBusy(true); setError(null);
    try {
      const root = `${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}`;
      const query = new URLSearchParams({ limit: "100" });
      if (after) query.set("cursor", after);
      const response = await fetch(`${root}/automations?${query}`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load workspace automations (${response.status}).`);
      const body = await response.json() as { automations: readonly AutomationRow[]; nextCursor: string | null };
      const results = await Promise.all(body.automations.map(async (automation) => {
        const scheduleResponse = await fetch(`${root}/automations/${encodeURIComponent(automation.automationId)}/schedule`, { headers: { Authorization: `Bearer ${credential}` }, cache: "no-store" });
        if (scheduleResponse.status === 404) return undefined;
        if (!scheduleResponse.ok) throw new Error(`Could not load schedule for ${automation.automationId} (${scheduleResponse.status}).`);
        const scheduleBody = await scheduleResponse.json() as { schedule: ScheduleRow };
        return { automation, schedule: scheduleBody.schedule };
      }));
      const schedules = results.filter((item): item is NonNullable<typeof item> => item !== undefined);
      setItems((current) => after ? [...current, ...schedules] : schedules);
      setNextCursor(body.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load schedules."); setItems([]); }
    finally { setBusy(false); }
  }, [apiBaseUrl, workspaceId]);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const stored = window.sessionStorage.getItem(TOKEN_KEY);
      if (stored) setToken(stored);
      setWorkspaceId(window.sessionStorage.getItem(WORKSPACE_KEY) ?? "");
    }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);
  useEffect(() => {
    if (!token || !workspaceId.trim()) return;
    const handle = window.setTimeout(() => { void load(token); }, 0);
    return () => window.clearTimeout(handle);
  }, [load, token, workspaceId]);
  return <PageShell>
    <PageHeader description="Schedules are loaded from the authenticated workspace automation and schedule APIs." eyebrow="Automation schedules" icon={<CalendarClock aria-hidden="true" className="size-5 text-primary" />} title="Schedules" />
    <div className="space-y-4"><div className="flex flex-wrap items-end gap-3"><div className="min-w-0 flex-1"><WorkspaceConnectionFields token={token} onTokenChange={(value) => { setToken(value); if (value) window.sessionStorage.setItem(TOKEN_KEY, value); else window.sessionStorage.removeItem(TOKEN_KEY); }} workspaceId={workspaceId} onWorkspaceChange={(value) => { const normalized = value.trim(); setWorkspaceId(normalized); window.sessionStorage.setItem(WORKSPACE_KEY, normalized); }} description="Use the same token for this browser tab; API access is checked for every request." /></div><Button className="mb-1" disabled={!token || !workspaceId.trim() || busy} onClick={() => void load(token)} variant="outline"><RefreshCw aria-hidden="true" /> Refresh</Button></div>
      {error && <Alert variant="destructive"><AlertTitle>Schedule list unavailable</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {items.length === 0 && !error && token && !busy && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No schedules found in this workspace.</CardContent></Card>}
      <div className="space-y-3">{items.map(({ automation, schedule }) => <Card key={automation.automationId}><CardContent className="flex flex-wrap items-center justify-between gap-3 py-4"><div><h2 className="font-semibold">{automation.name}</h2><p className="mt-1 text-sm text-muted-foreground">{schedule.enabled ? "Enabled" : "Disabled"} · {schedule.definition.kind} · {schedule.timezone} · next {new Date(schedule.nextOccurrenceAt).toLocaleString()}</p></div><Button asChild variant="outline"><Link href={`/automations/${encodeURIComponent(automation.automationId)}/schedule` as Route}>Manage schedule</Link></Button></CardContent></Card>)}</div>
      {nextCursor && <div className="flex justify-center"><Button disabled={busy} onClick={() => void load(token, nextCursor)} variant="outline">Load more schedules</Button></div>}
      {(!token || !workspaceId.trim()) && <p className="text-sm text-muted-foreground">Enter a workspace ID and platform token; workspace membership is verified by the API.</p>}
    </div>
  </PageShell>;
};

export default SchedulesOverview;
