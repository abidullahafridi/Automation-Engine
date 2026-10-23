import type { ReactElement } from "react";
import { PageShell } from "@workspace/ui";

const Loading = (): ReactElement => (
  <PageShell>
    <div aria-label="Loading application" className="h-2 w-32 animate-pulse rounded bg-muted" role="status" />
  </PageShell>
);

export default Loading;
