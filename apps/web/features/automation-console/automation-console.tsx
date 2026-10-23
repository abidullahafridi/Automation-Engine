"use client";

import Link from "next/link";
import type { Route } from "next";
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  PageHeader,
  PageShell,
  Textarea
} from "@workspace/ui";
import { Activity, ArrowLeft, ArrowRight, Clock3, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { WorkspaceConnectionFields } from "./connection-fields";

const TOKEN_KEY = "automation_console_bearer_token";
const WORKSPACE_KEY = "automation_console_workspace_id";
const AUTOMATION_PAGE_SIZE_OPTIONS = [5, 10, 20] as const;
const DEFAULT_AUTOMATION_PAGE_SIZE = 5;
const RUN_PAGE_SIZE = 20;

type AutomationStatus = "draft" | "enabled" | "paused" | "disabled" | "archived";
type Automation = Readonly<{
  automationId: string;
  name: string;
  status: AutomationStatus;
  revision: number;
  currentVersion?: number | null;
  createdAt: string;
  updatedAt: string;
  draft?: unknown;
}>;
type Run = Readonly<{
  runId: string;
  revision: number;
  eventId: string;
  automationId: string;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  failure?: Readonly<{ reason: string; attempts: number; failureCode?: string }>;
}>;
type RunDetail = Run & Readonly<{
  runAfter: string;
  attemptCount: number;
  actions: readonly Readonly<{
    actionIndex: number;
    attempt: number;
    status: string;
    createdAt: string;
    updatedAt: string;
    actionType?: string;
  }>[];
}>;
type ConsoleProps = Readonly<{ apiBaseUrl: string; automationId?: string }>;

const lifecycleAction = (status: AutomationStatus, published: boolean): "enable" | "pause" | "resume" | "disable" | undefined => {
  if ((status === "draft" && published) || status === "disabled") return "enable";
  if (status === "enabled") return "pause";
  if (status === "paused") return "resume";
  return undefined;
};

const humanize = (value: string): string => value.replaceAll("_", " ").replaceAll("-", " ");
const formatDate = (value: string): string => new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short"
}).format(new Date(value));

const StatusBadge = ({ status }: Readonly<{ status: string }>): ReactElement => {
  const variant = status === "enabled" || status === "completed"
    ? "default"
    : status === "failed" || status === "dead_letter"
      ? "destructive"
      : "secondary";
  return <Badge aria-label={`Status: ${humanize(status)}`} variant={variant}>{humanize(status)}</Badge>;
};

const messageFrom = async (response: Response): Promise<string> => {
  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = body.error;
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
      return error.message;
    }
  }
  return `Request failed (${response.status}).`;
};

const AutomationList = ({ apiBaseUrl, token, workspaceId }: Readonly<{ apiBaseUrl: string; token: string; workspaceId: string }>): ReactElement => {
  const [items, setItems] = useState<readonly Automation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_AUTOMATION_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [nameQuery, setNameQuery] = useState("");

  const load = useCallback(async (
    after: string | null = null,
    requestedPageSize = pageSize,
    requestedPage = 1
  ): Promise<void> => {
    if (!token || !workspaceId.trim()) {
      setItems([]);
      setNextCursor(null);
      setCursor(null);
      setPage(1);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    const query = new URLSearchParams({ limit: String(requestedPageSize) });
    if (after) query.set("cursor", after);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automations?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const body = await response.json() as { automations: readonly Automation[]; nextCursor: string | null };
      setItems(body.automations);
      setCursor(after ?? null);
      setNextCursor(body.nextCursor);
      setPage(requestedPage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load automations.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, pageSize, token, workspaceId]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load(null); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  const visibleItems = items.filter((item) =>
    (statusFilter === "all" || item.status === statusFilter) && item.name.toLocaleLowerCase().includes(nameQuery.trim().toLocaleLowerCase())
  );
  return (
    <>
      <div className="mb-5 space-y-3">
        <p className="text-sm text-muted-foreground">Search and filter the currently loaded page. Newest automations appear first.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="automation-name-search">Search current automations page</label>
          <Input className="h-9 w-full sm:w-56" id="automation-name-search" onChange={(event) => setNameQuery(event.currentTarget.value)} placeholder="Search this page…" value={nameQuery} />
          <label className="sr-only" htmlFor="automation-status-filter">Filter by status</label>
          <select className="h-9 rounded-md border border-input bg-background px-3 text-sm" id="automation-status-filter" onChange={(event) => setStatusFilter(event.currentTarget.value)} value={statusFilter}>
            <option value="all">All statuses</option>
            <option value="draft">Draft</option><option value="enabled">Enabled</option><option value="paused">Paused</option><option value="disabled">Disabled</option><option value="archived">Archived</option>
          </select>
          <label className="sr-only" htmlFor="automation-page-size">Automations per page</label>
          <select aria-label="Automations per page" className="h-9 rounded-md border border-input bg-background px-3 text-sm" id="automation-page-size" onChange={(event) => {
            const value = Number(event.currentTarget.value);
            if (AUTOMATION_PAGE_SIZE_OPTIONS.includes(value as typeof AUTOMATION_PAGE_SIZE_OPTIONS[number])) {
              setPageSize(value);
              void load(null, value, 1);
            }
          }} value={pageSize}>
            {AUTOMATION_PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size} per page</option>)}
          </select>
          <Button onClick={() => void load(cursor, pageSize, page)} disabled={loading || !token} variant="outline"><RefreshCw aria-hidden="true" /> Refresh</Button>
          <Button asChild variant="outline"><Link href={"/schedules" as Route}>Schedules</Link></Button>
          <Button asChild variant="outline"><Link href={"/automation-ops" as Route}>Operations</Link></Button>
          <Button asChild><Link href="/automations/builder"><Plus aria-hidden="true" /> Create automation</Link></Button>
        </div>
      </div>
      {error && <Alert className="mb-5" variant="destructive"><ShieldAlert aria-hidden="true" /><AlertTitle>Could not load automations</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {(!token || !workspaceId.trim()) && <Card><CardContent className="py-10 text-center"><p className="font-medium">Connect to your automation workspace</p><p className="mt-2 text-sm text-muted-foreground">Enter a workspace ID and platform access token above to load workspace automations.</p></CardContent></Card>}
      {token && workspaceId.trim() && !error && !loading && visibleItems.length === 0 && <Card><CardContent className="py-10 text-center"><Activity aria-hidden="true" className="mx-auto size-8 text-muted-foreground" /><p className="mt-3 font-medium">{items.length ? "No automations match this page filter" : "No automations yet"}</p><p className="mt-2 text-sm text-muted-foreground">{items.length ? "Clear the search or choose another status to see this page’s automations." : "Create a draft, preview its conditions, then publish and enable it."}</p>{(nameQuery || statusFilter !== "all") && <Button className="mt-4" onClick={() => { setNameQuery(""); setStatusFilter("all"); }} type="button" variant="outline">Clear filters</Button>}</CardContent></Card>}
      {loading && <p aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">Loading automations…</p>}
      {visibleItems.length > 0 && <div className="space-y-3">{visibleItems.map((item) => (
        <Card key={item.automationId}><CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><h2 className="truncate font-semibold">{item.name}</h2><StatusBadge status={item.status} /></div><p className="mt-2 text-xs text-muted-foreground">Updated {formatDate(item.updatedAt)} · Revision {item.revision}</p></div>
          <Button asChild variant="outline"><Link href={`/automations/${encodeURIComponent(item.automationId)}` as Route}>View automation <ArrowRight aria-hidden="true" /></Link></Button>
        </CardContent></Card>
      ))}</div>}
      {token && workspaceId.trim() && (cursor || nextCursor) && <nav aria-label="Automation pages" className="mt-5 flex items-center justify-end gap-3">
        <span aria-live="polite" className="text-sm text-muted-foreground">Page {page}</span>
        <Button disabled={page === 1 || loading} onClick={() => void load(null, pageSize, 1)} variant="outline">First page</Button>
        <Button disabled={!nextCursor || loading} onClick={() => void load(nextCursor, pageSize, page + 1)} variant="outline">Next page <ArrowRight aria-hidden="true" /></Button>
      </nav>}
    </>
  );
};

const AutomationDetail = ({ apiBaseUrl, automationId, token, workspaceId }: Readonly<{ apiBaseUrl: string; automationId: string; token: string; workspaceId: string }>): ReactElement => {
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [runs, setRuns] = useState<readonly Run[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sampleJson, setSampleJson] = useState('{\n  "task": {\n    "status": "completed",\n    "previousStatus": "in_progress",\n    "priority": "medium",\n    "isArchived": false\n  }\n}');
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string | null): Promise<void> => {
    if (!token || !workspaceId.trim()) { setAutomation(null); setRuns([]); return; }
    setLoading(true);
    setError(null);
    const headers = { Authorization: `Bearer ${token}` };
    const root = `${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}`;
    try {
      const [automationResponse, runsResponse] = await Promise.all([
        fetch(`${root}/automations/${encodeURIComponent(automationId)}`, { headers, cache: "no-store" }),
        fetch(`${root}/automations/${encodeURIComponent(automationId)}/runs?limit=${RUN_PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { headers, cache: "no-store" })
      ]);
      if (!automationResponse.ok) throw new Error(await messageFrom(automationResponse));
      if (!runsResponse.ok) throw new Error(await messageFrom(runsResponse));
      const automationBody = await automationResponse.json() as { automation: Automation };
      const runBody = await runsResponse.json() as { runs: readonly Run[]; nextCursor: string | null };
      setAutomation(automationBody.automation);
      setRuns(runBody.runs);
      setNextCursor(runBody.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load automation details.");
    } finally { setLoading(false); }
  }, [apiBaseUrl, automationId, token, workspaceId]);

  useEffect(() => {
    const handle = window.setTimeout(() => { void load(null); }, 0);
    return () => window.clearTimeout(handle);
  }, [load]);

  const transition = async (action: "enable" | "pause" | "resume" | "disable"): Promise<void> => {
    if (!automation || !token) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automations/${encodeURIComponent(automationId)}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "If-Match": `"${automation.revision}"` }
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const body = await response.json() as { automation: Automation };
      setAutomation(body.automation);
      setNotice(`Automation ${action} request completed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Lifecycle update failed."); }
    finally { setBusy(false); }
  };

  const loadMoreRuns = async (): Promise<void> => {
    if (!nextCursor || !token) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automations/${encodeURIComponent(automationId)}/runs?limit=${RUN_PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: "no-store"
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const body = await response.json() as { runs: readonly Run[]; nextCursor: string | null };
      setRuns((current) => [...current, ...body.runs]); setNextCursor(body.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load more runs."); }
    finally { setBusy(false); }
  };

  const runPreview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!token) return;
    setBusy(true); setError(null); setPreview(null);
    let sample: unknown;
    try { sample = JSON.parse(sampleJson); }
    catch { setError("Sample must be valid JSON."); setBusy(false); return; }
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automations/${encodeURIComponent(automationId)}/dry-run`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sample })
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const result: unknown = await response.json();
      setPreview(JSON.stringify(result, null, 2));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Preview could not be generated."); }
    finally { setBusy(false); }
  };

  const publishDraft = async (): Promise<void> => {
    if (!automation || !token) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automations/${encodeURIComponent(automationId)}/publish`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "If-Match": `"${automation.revision}"`,
          "Idempotency-Key": crypto.randomUUID()
        }
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const body = await response.json() as { automation: { revision: number; version: number } };
      setAutomation((current) => current ? { ...current, revision: body.automation.revision, currentVersion: body.automation.version } : current);
      setNotice(`Version ${body.automation.version} published. You can now enable the automation.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Draft could not be published."); }
    finally { setBusy(false); }
  };

  const submitSampleEvent = async (): Promise<void> => {
    if (!automation || !token) return;
    setBusy(true); setError(null); setNotice(null);
    let sample: unknown;
    try { sample = JSON.parse(sampleJson); }
    catch { setError("Sample must be valid JSON."); setBusy(false); return; }
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automation-events/task-status-changed`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sample })
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      const result = await response.json() as { createdRuns: number; candidateCount: number };
      setNotice(result.createdRuns > 0
        ? `Sample event matched ${result.createdRuns} automation(s); refreshing run history.`
        : `Event accepted. ${result.candidateCount} automation(s) were checked; no rule matched.`);
      window.setTimeout(() => { void load(null); }, 500);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sample event could not be submitted."); }
    finally { setBusy(false); }
  };

  const action = automation ? lifecycleAction(automation.status, automation.currentVersion !== null && automation.currentVersion !== undefined) : undefined;
  return (
    <>
      <Button asChild className="mb-5" variant="ghost"><Link href={"/automations" as Route}><ArrowLeft aria-hidden="true" /> All automations</Link></Button>
      {error && <Alert className="mb-5" variant="destructive"><ShieldAlert aria-hidden="true" /><AlertTitle>Request could not be completed</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {notice && <Alert className="mb-5"><AlertTitle>Updated</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
      {!token && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Enter a platform access token above to view this automation and its run history.</CardContent></Card>}
      {loading && <p aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">Loading automation…</p>}
      {automation && <>
        <Card><CardContent className="flex flex-col gap-5 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div><div className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold">{automation.name}</h2><StatusBadge status={automation.status} /></div><p className="mt-2 text-sm text-muted-foreground">Revision {automation.revision} · Last updated {formatDate(automation.updatedAt)}</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">ID: {automation.automationId}</p></div>
          <div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link href={`/automations/${encodeURIComponent(automationId)}/schedule` as Route}>Schedule</Link></Button>{automation.status === "draft" && automation.currentVersion == null ? <Button disabled={busy} onClick={() => void publishDraft()}>Publish draft</Button> : null}{action && <Button disabled={busy} onClick={() => void transition(action)}>{humanize(action)}</Button>}{automation.status === "enabled" || automation.status === "paused" ? <Button disabled={busy} onClick={() => void transition("disable")} variant="outline">Disable</Button> : null}</div>
        </CardContent></Card>
        <section aria-labelledby="dry-run-heading" className="mt-8">
          <Card><CardContent className="py-6">
            <h2 className="text-lg font-semibold" id="dry-run-heading">Preview with sample event</h2>
            <p className="mt-1 text-sm text-muted-foreground">Evaluate the saved draft without creating a run or invoking actions.</p>
            <form className="mt-4 space-y-3" onSubmit={(event) => void runPreview(event)}>
              <Label htmlFor="dry-run-sample">Sample event JSON</Label>
              <Textarea className="min-h-36 font-mono text-xs" id="dry-run-sample" onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setSampleJson(event.currentTarget.value)} value={sampleJson} />
              <Button disabled={!token || busy} type="submit">Preview conditions</Button>
              {automation.status === "enabled" && <Button disabled={!token || busy} onClick={() => void submitSampleEvent()} type="button" variant="outline">Send live sample event</Button>}
            </form>
            {preview && <pre aria-live="polite" className="mt-4 max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-4 text-xs">{preview}</pre>}
          </CardContent></Card>
        </section>
        <section aria-labelledby="run-history-heading" className="mt-9">
          <div className="mb-4 flex items-end justify-between gap-4"><div><h2 className="text-lg font-semibold" id="run-history-heading">Run history</h2><p className="mt-1 text-sm text-muted-foreground">Recent executions and safe failure summaries.</p></div><Button disabled={busy} onClick={() => void load(null)} variant="outline"><RefreshCw aria-hidden="true" /> Refresh</Button></div>
          {runs.length === 0 && !loading ? <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No runs are available for this automation.</CardContent></Card> : <div className="space-y-3">{runs.map((run) => <Card key={run.runId}><CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-3"><StatusBadge status={run.status} /><span className="text-xs text-muted-foreground">Version {run.version}</span><span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock3 aria-hidden="true" className="size-3" />{formatDate(run.createdAt)}</span></div>{run.failure && <p className="mt-2 text-sm text-destructive">{humanize(run.failure.reason)} · {run.failure.attempts} attempt(s){run.failure.failureCode ? ` · ${run.failure.failureCode}` : ""}</p>}<p className="mt-2 truncate font-mono text-xs text-muted-foreground">Run {run.runId}</p></div><Button asChild variant="outline"><Link href={`/automation-runs/${encodeURIComponent(run.runId)}` as Route}>Run details <ArrowRight aria-hidden="true" /></Link></Button></CardContent></Card>)}</div>}
          {nextCursor && <div className="mt-4 flex justify-center"><Button disabled={busy} onClick={() => void loadMoreRuns()} variant="outline">Load more runs <ArrowRight aria-hidden="true" /></Button></div>}
        </section>
      </>}
    </>
  );
};

const RunDetail = ({ apiBaseUrl, runId, token, workspaceId }: Readonly<{ apiBaseUrl: string; runId: string; token: string; workspaceId: string }>): ReactElement => {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmedIndexes, setConfirmedIndexes] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [recoveryRequest, setRecoveryRequest] = useState<Readonly<{ fingerprint: string; key: string }> | null>(null);
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadRun = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automation-runs/${encodeURIComponent(runId)}`, {
          headers: { Authorization: `Bearer ${token}` }, cache: "no-store"
        });
        if (!response.ok) throw new Error(await messageFrom(response));
        const body = await response.json() as { run: RunDetail };
        if (!cancelled) setRun(body.run);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load run details.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const handle = window.setTimeout(() => { void loadRun(); }, 0);
    return () => { cancelled = true; window.clearTimeout(handle); };
  }, [apiBaseUrl, runId, token, workspaceId, refresh]);

  const recover = async (operation: "retry" | "replay"): Promise<void> => {
    if (!run || !token || reason.trim().length === 0) return;
    const indexes = confirmedIndexes.trim() === "" ? [] : confirmedIndexes.split(",").map((value) => Number(value.trim()));
    if (indexes.some((value) => !Number.isSafeInteger(value) || value < 0)) {
      setError("Confirmed action indexes must be non-negative whole numbers, separated by commas.");
      return;
    }
    const fingerprint = JSON.stringify([operation, runId, reason.trim(), indexes, run.revision]);
    const idempotencyKey = recoveryRequest?.fingerprint === fingerprint
      ? recoveryRequest.key
      : window.crypto.randomUUID();
    setRecoveryRequest({ fingerprint, key: idempotencyKey });
    setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId.trim())}/automation-runs/${encodeURIComponent(runId)}/${operation}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
          ...(operation === "retry" ? { "If-Match": String(run.revision) } : {})
        },
        body: JSON.stringify({ reason: reason.trim(), ...(indexes.length > 0 ? { confirmedActionIndexes: indexes } : {}) })
      });
      if (!response.ok) throw new Error(await messageFrom(response));
      setNotice(`${operation === "retry" ? "Retry" : "Replay"} request accepted. Refreshing run status.`);
      setRefresh((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Recovery request failed."); }
    finally { setBusy(false); }
  };

  return <>
    {run && <Button asChild className="mb-5" variant="ghost"><Link href={`/automations/${encodeURIComponent(run.automationId)}` as Route}><ArrowLeft aria-hidden="true" /> Back to automation</Link></Button>}
    {error && <Alert className="mb-5" variant="destructive"><div className="flex flex-wrap items-start justify-between gap-3"><div><AlertTitle>Could not load run details</AlertTitle><AlertDescription>{error}</AlertDescription></div><Button disabled={loading} onClick={() => setRefresh((value) => value + 1)} type="button" variant="outline">{loading ? "Loading…" : "Try again"}</Button></div></Alert>}
    {notice && <Alert className="mb-5"><AlertTitle>Recovery request sent</AlertTitle><AlertDescription>{notice}</AlertDescription></Alert>}
    {!token && <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Enter a platform access token above to inspect this run.</CardContent></Card>}
    {!run && loading && <Card><CardContent aria-live="polite" className="py-8 text-center text-sm text-muted-foreground">Loading run details…</CardContent></Card>}
    {run && <>
      <div className="flex justify-end"><Button disabled={loading} onClick={() => setRefresh((value) => value + 1)} type="button" variant="outline"><RefreshCw aria-hidden="true" /> Refresh run</Button></div>
      <Card><CardContent className="py-6"><div className="flex flex-wrap items-center gap-3"><h2 className="text-xl font-semibold">Automation run</h2><StatusBadge status={run.status} /></div><dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">Run ID</dt><dd className="mt-1 break-all font-mono text-xs">{run.runId}</dd></div><div><dt className="text-muted-foreground">Automation</dt><dd className="mt-1"><Link className="underline underline-offset-4" href={`/automations/${encodeURIComponent(run.automationId)}` as Route}>{run.automationId}</Link></dd></div><div><dt className="text-muted-foreground">Created</dt><dd className="mt-1">{formatDate(run.createdAt)}</dd></div><div><dt className="text-muted-foreground">Pinned version</dt><dd className="mt-1">{run.version}</dd></div><div><dt className="text-muted-foreground">Attempts</dt><dd className="mt-1">{run.attemptCount}</dd></div><div><dt className="text-muted-foreground">Scheduled after</dt><dd className="mt-1">{formatDate(run.runAfter)}</dd></div></dl>{run.failure && <Alert className="mt-5" variant="destructive"><AlertTitle>Failure summary</AlertTitle><AlertDescription>{humanize(run.failure.reason)} · {run.failure.attempts} attempt(s){run.failure.failureCode ? ` · ${run.failure.failureCode}` : ""}</AlertDescription></Alert>}</CardContent></Card>
      {(run.status === "dead_letter" || run.status === "failed") && <Card><CardContent className="space-y-3 py-5"><h2 className="font-semibold">Safe recovery</h2><p className="text-sm text-muted-foreground">Recovery is permission-checked and idempotent. Ambiguous actions may remain blocked for reconciliation.</p><div><Label htmlFor="recovery-reason">Reason for recovery</Label><Input className="mt-2" id="recovery-reason" maxLength={500} onChange={(event) => setReason(event.currentTarget.value)} value={reason} /></div>{run.actions.some((action) => action.status === "unknown_outcome") && <div><Label htmlFor="recovery-confirmed-indexes">Action indexes explicitly reviewed (comma-separated)</Label><Input className="mt-2" id="recovery-confirmed-indexes" onChange={(event) => setConfirmedIndexes(event.currentTarget.value)} placeholder="0, 2" value={confirmedIndexes} /><p className="mt-1 text-xs text-muted-foreground">Confirmation never overrides a required external reconciliation.</p></div>}<div className="flex gap-2"><Button disabled={busy || !reason.trim() || run.status !== "dead_letter"} onClick={() => void recover("retry")} type="button">Retry dead letter</Button><Button disabled={busy || !reason.trim()} onClick={() => void recover("replay")} type="button" variant="outline">Replay run</Button></div></CardContent></Card>}
      <section aria-labelledby="action-attempts-heading" className="mt-9"><h2 className="mb-4 text-lg font-semibold" id="action-attempts-heading">Action attempts</h2>{run.actions.length === 0 ? <p className="text-sm text-muted-foreground">No action attempts recorded.</p> : <div className="space-y-3">{run.actions.map((attempt) => <Card key={`${attempt.actionIndex}-${attempt.attempt}`}><CardContent className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="font-medium">{attempt.actionType ?? `Action ${attempt.actionIndex + 1}`}</p><p className="mt-1 text-xs text-muted-foreground">Attempt {attempt.attempt} · Updated {formatDate(attempt.updatedAt)}</p></div><StatusBadge status={attempt.status} /></CardContent></Card>)}</div>}</section>
    </>}
  </>;
};

export const AutomationConsole = ({ apiBaseUrl, automationId }: ConsoleProps): ReactElement => {
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const detailView = automationId !== undefined;
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const stored = window.sessionStorage.getItem(TOKEN_KEY);
      if (stored) setToken(stored);
      setWorkspaceId(window.sessionStorage.getItem(WORKSPACE_KEY) ?? "");
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);
  const updateToken = (value: string): void => {
    setToken(value);
    if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  };
  const updateWorkspaceId = (value: string): void => {
    const normalized = value.trim();
    setWorkspaceId(normalized);
    if (normalized) window.sessionStorage.setItem(WORKSPACE_KEY, normalized);
    else window.sessionStorage.removeItem(WORKSPACE_KEY);
  };
  return <PageShell>
    <PageHeader
      description={detailView ? "Manage lifecycle state and inspect execution outcomes for this automation." : "Review workspace automation status, open a rule, and inspect execution history."}
      eyebrow="Automation operations"
      icon={<Activity aria-hidden="true" className="size-5 text-primary" />}
      title={detailView ? "Automation details" : "Automations"}
    />
    <div className="space-y-6">
      <WorkspaceConnectionFields token={token} onTokenChange={updateToken} workspaceId={workspaceId} onWorkspaceChange={updateWorkspaceId} />
      {detailView
        ? token && workspaceId
          ? <AutomationDetail apiBaseUrl={apiBaseUrl} automationId={automationId} token={token} workspaceId={workspaceId} />
          : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Enter a workspace ID and platform access token above to view this automation and its run history.</CardContent></Card>
        : <AutomationList apiBaseUrl={apiBaseUrl} token={token} workspaceId={workspaceId} />}
    </div>
  </PageShell>;
};

export const AutomationRunConsole = ({ apiBaseUrl, runId }: Readonly<{ apiBaseUrl: string; runId: string }>): ReactElement => {
  const [token, setToken] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  useEffect(() => {
    const handle = window.setTimeout(() => {
      const stored = window.sessionStorage.getItem(TOKEN_KEY);
      if (stored) setToken(stored);
      setWorkspaceId(window.sessionStorage.getItem(WORKSPACE_KEY) ?? "");
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);
  const updateToken = (value: string): void => {
    setToken(value);
    if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
    else window.sessionStorage.removeItem(TOKEN_KEY);
  };
  const updateWorkspaceId = (value: string): void => {
    const normalized = value.trim();
    setWorkspaceId(normalized);
    if (normalized) window.sessionStorage.setItem(WORKSPACE_KEY, normalized);
    else window.sessionStorage.removeItem(WORKSPACE_KEY);
  };
  return <PageShell>
    <PageHeader description="Review a run's safe status and action attempt history." eyebrow="Run history" icon={<Clock3 aria-hidden="true" className="size-5 text-primary" />} title="Run details" />
    <div className="space-y-6"><WorkspaceConnectionFields token={token} onTokenChange={updateToken} workspaceId={workspaceId} onWorkspaceChange={updateWorkspaceId} />{token && workspaceId ? <RunDetail apiBaseUrl={apiBaseUrl} runId={runId} token={token} workspaceId={workspaceId} /> : <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Enter a workspace ID and platform access token above to inspect this run.</CardContent></Card>}</div>
  </PageShell>;
};
