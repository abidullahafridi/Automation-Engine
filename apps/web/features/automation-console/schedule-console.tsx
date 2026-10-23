"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Alert, AlertDescription, AlertTitle, Button, Card, CardContent, Input, Label, PageHeader, PageShell } from "@workspace/ui";
import { CalendarClock, RefreshCw } from "lucide-react";
import { WorkspaceConnectionFields } from "./connection-fields";

const TOKEN_KEY = "automation_console_bearer_token";
const WORKSPACE_KEY = "automation_console_workspace_id";
type Definition = Readonly<{ kind: "daily"; time: string }> | Readonly<{ kind: "interval"; everyMs: number; anchorAt: string }>;
type Schedule = Readonly<{
  automationId: string;
  timezone: string;
  definition: Definition;
  enabled: boolean;
  nextOccurrenceAt: string;
  rev: number;
}>;
type Occurrence = Readonly<{ occurrenceId: string; scheduledFor: string; createdAt: string; skipReason?: string }>;

const responseMessage = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = body.error;
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return `Request failed (${response.status}).`;
};

const ScheduleConsole = ({ apiBaseUrl, automationId }: Readonly<{ apiBaseUrl: string; automationId: string }>): ReactElement => {
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [occurrences, setOccurrences] = useState<readonly Occurrence[]>([]);
  const [timezone, setTimezone] = useState("UTC");
  const [kind, setKind] = useState<"daily" | "interval">("daily");
  const [time, setTime] = useState("09:00");
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = `${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automations/${encodeURIComponent(automationId)}/schedule`;

  const load = useCallback(async (): Promise<void> => {
    if (!token || !workspaceId.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch(root, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      if (response.status === 404) { setSchedule(null); setOccurrences([]); return; }
      if (!response.ok) throw new Error(`Schedule request failed (${response.status}); check authorization and API availability.`);
      const body = await response.json() as { schedule: Schedule; occurrences: readonly Occurrence[] };
      setSchedule(body.schedule); setOccurrences(body.occurrences);
      setTimezone(body.schedule.timezone);
      setKind(body.schedule.definition.kind);
      if (body.schedule.definition.kind === "daily") setTime(body.schedule.definition.time);
      else setEveryMinutes(String(Math.round(body.schedule.definition.everyMs / 60_000)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load the schedule."); }
    finally { setBusy(false); }
  }, [root, token, workspaceId]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const stored = window.sessionStorage.getItem(TOKEN_KEY);
      if (stored) setToken(stored);
      setWorkspaceId(window.sessionStorage.getItem(WORKSPACE_KEY) ?? "");
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);
  useEffect(() => { const handle = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(handle); }, [load]);

  const definition = (): Definition => kind === "daily"
    ? { kind, time }
    : { kind, everyMs: Number(everyMinutes) * 60_000, anchorAt: new Date().toISOString() };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); if (!token || !workspaceId.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const body = { timezone, definition: definition() };
      const validate = await fetch(`${root}/validate`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!validate.ok) throw new Error(`Validation request failed (${validate.status}); check authorization and API availability.`);
      const validation = await validate.json() as { valid: boolean; issues: readonly { message: string }[] };
      if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join(" "));
      const response = await fetch(root, {
        method: schedule ? "PUT" : "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(schedule ? { "If-Match": String(schedule.rev) } : {}) },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Schedule save failed (${response.status}); reload if another operator changed it.`);
      setNotice(schedule ? "Schedule updated." : "Schedule created disabled. Enable it when ready.");
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the schedule."); }
    finally { setBusy(false); }
  };

  const setEnabled = async (): Promise<void> => {
    if (!schedule || !token || !workspaceId.trim()) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const operation = schedule.enabled ? "disable" : "enable";
      const response = await fetch(`${root}/${operation}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "If-Match": String(schedule.rev) } });
      if (!response.ok) throw new Error(`Schedule ${operation} failed (${response.status}): ${await responseMessage(response)}`);
      setNotice(`Schedule ${operation}d.`); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change schedule state."); }
    finally { setBusy(false); }
  };

  return <PageShell>
    <PageHeader description="Configure a timezone-aware schedule and inspect durable occurrence status." eyebrow="Automation schedule" icon={<CalendarClock aria-hidden="true" className="size-5 text-primary" />} title="Schedule" />
    <div className="space-y-5">
      <WorkspaceConnectionFields
        token={token}
        onTokenChange={(value) => { setToken(value); if (value) window.sessionStorage.setItem(TOKEN_KEY, value); else window.sessionStorage.removeItem(TOKEN_KEY); }}
        workspaceId={workspaceId}
        onWorkspaceChange={(value) => { const normalized = value.trim(); setWorkspaceId(normalized); window.sessionStorage.setItem(WORKSPACE_KEY, normalized); }}
      />
      {error && <Alert variant="destructive"><AlertTitle>Schedule operation failed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert><AlertTitle>Updated</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
      {token && workspaceId.trim() && <Card><CardContent className="py-5"><form className="space-y-4" onSubmit={(event) => void submit(event)}>
        <p className="text-sm text-muted-foreground">A schedule can run only after its automation is published and enabled. Saving a schedule leaves it disabled until you enable it here.</p>
        <div><Label htmlFor="schedule-timezone">IANA time zone</Label><Input className="mt-2" id="schedule-timezone" onChange={(event) => setTimezone(event.currentTarget.value)} placeholder="America/New_York" required value={timezone} /></div>
        <div><Label htmlFor="schedule-kind">Frequency</Label><select className="mt-2 h-10 w-full rounded-md border border-input bg-background px-3 text-sm" id="schedule-kind" onChange={(event) => setKind(event.currentTarget.value as "daily" | "interval")} value={kind}><option value="daily">Daily</option><option value="interval">Every interval</option></select></div>
        {kind === "daily" ? <div><Label htmlFor="schedule-time">Local time (24-hour)</Label><Input className="mt-2" id="schedule-time" onChange={(event) => setTime(event.currentTarget.value)} required type="time" value={time} /></div> : <div><Label htmlFor="schedule-interval">Interval in minutes (minimum 1)</Label><Input className="mt-2" id="schedule-interval" min="1" onChange={(event) => setEveryMinutes(event.currentTarget.value)} required type="number" value={everyMinutes} /></div>}
        <div className="flex flex-wrap gap-2"><Button disabled={busy} type="submit">{schedule ? "Validate and save" : "Validate and create"}</Button>{schedule && <Button disabled={busy} onClick={() => void setEnabled()} type="button" variant="outline">{schedule.enabled ? "Disable schedule" : "Enable schedule"}</Button>}<Button disabled={busy} onClick={() => void load()} type="button" variant="outline"><RefreshCw aria-hidden="true" /> Refresh status</Button></div>
      </form></CardContent></Card>}
      {schedule && <Card><CardContent className="py-5"><h2 className="font-semibold">Execution status</h2><p className="mt-2 text-sm">{schedule.enabled ? "Enabled" : "Disabled"} · next occurrence {new Date(schedule.nextOccurrenceAt).toLocaleString()} ({schedule.timezone}) · revision {schedule.rev}</p><div className="mt-4 space-y-2">{occurrences.length === 0 ? <p className="text-sm text-muted-foreground">No occurrences recorded yet. Check again after the next scheduled time.</p> : occurrences.slice(-20).reverse().map((item) => <div className="flex flex-wrap justify-between gap-2 border-t border-border py-2 text-sm" key={item.occurrenceId}><span>{new Date(item.scheduledFor).toLocaleString()}</span><span className="text-muted-foreground">{item.skipReason ?? "Occurrence recorded"}</span></div>)}</div></CardContent></Card>}
    </div>
  </PageShell>;
};

export default ScheduleConsole;
