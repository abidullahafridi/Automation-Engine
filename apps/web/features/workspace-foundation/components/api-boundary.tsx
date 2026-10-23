import type { ReactElement } from "react";
import { Button } from "@workspace/ui";

type ApiBoundaryProps = Readonly<{
  baseUrl: string;
}>;

export const ApiBoundary = ({ baseUrl }: ApiBoundaryProps): ReactElement => (
  <footer className="mt-auto flex flex-col gap-2 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
    <span>API boundary</span>
    <div className="flex flex-wrap items-center gap-3">
      <code className="w-fit rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">{baseUrl}</code>
      <Button asChild size="sm" variant="outline">
        <a href={`${baseUrl}/health`}>API health</a>
      </Button>
    </div>
  </footer>
);
