import type { ReactElement } from "react";
import { Activity, CalendarClock, Workflow, type LucideIcon } from "lucide-react";

type WorkspaceRuntime = Readonly<{
  label: string;
  detail: string;
  icon: LucideIcon;
}>;

const runtimes: readonly WorkspaceRuntime[] = [
  { label: "Build", detail: "Combine supported triggers, conditions, and ordered actions.", icon: Workflow },
  { label: "Schedule", detail: "Set a local time and timezone for an automation.", icon: CalendarClock },
  { label: "Monitor", detail: "Review run outcomes and available operational signals.", icon: Activity }
];

export const RuntimeFoundation = (): ReactElement => (
    <section aria-labelledby="foundation-heading" className="py-2">
    <h2 id="foundation-heading" className="text-sm font-semibold text-foreground">One workflow from authoring to operations</h2>
    <div className="mt-4 grid gap-3 sm:grid-cols-3">
      {runtimes.map(({ label, detail, icon: Icon }) => (
        <div className="flex min-h-32 items-start gap-3 rounded-lg border border-border bg-card p-4" key={label}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground"><Icon aria-hidden="true" className="size-4" /></span>
          <div className="pt-0.5">
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">{detail}</p>
          </div>
        </div>
      ))}
    </div>
  </section>
);
