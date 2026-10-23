import type { ReactElement } from "react";
import Link from "next/link";
import { Activity } from "lucide-react";
import { Button, PageHeader, PageShell } from "@workspace/ui";
import { ApiBoundary } from "./api-boundary";
import { RuntimeFoundation } from "./runtime-foundation";

type WorkspaceFoundationProps = Readonly<{
  apiBaseUrl: string;
}>;

export const WorkspaceFoundation = ({ apiBaseUrl }: WorkspaceFoundationProps): ReactElement => (
  <PageShell>
    <PageHeader
      description="Create event-driven rules, preview conditions before publishing, and follow each execution through run history."
      eyebrow="Automation Engine"
      icon={<Activity aria-hidden="true" className="size-5" />}
      title="Turn repeatable work into reliable automations."
    />
    <RuntimeFoundation />
    <div className="flex flex-wrap gap-3">
      <Button asChild><Link href="/automations">Open automations</Link></Button>
      <Button asChild variant="outline"><Link href="/schedules">View schedules</Link></Button>
    </div>
    <ApiBoundary baseUrl={apiBaseUrl} />
  </PageShell>
);
