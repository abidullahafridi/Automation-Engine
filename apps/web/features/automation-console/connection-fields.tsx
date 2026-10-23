import type { ReactElement } from "react";
import { KeyRound } from "lucide-react";
import { Card, CardContent, Input, Label } from "@workspace/ui";

export type WorkspaceConnectionFieldsProps = Readonly<{
  workspaceId: string;
  token: string;
  onWorkspaceChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  description?: string;
}>;

export const WorkspaceConnectionFields = ({
  workspaceId,
  token,
  onWorkspaceChange,
  onTokenChange,
  description = "The API verifies workspace membership and permissions. The token stays in this browser tab."
}: WorkspaceConnectionFieldsProps): ReactElement => (
  <Card>
    <CardContent className="grid gap-4 py-4 sm:grid-cols-2">
      <div className="min-w-0">
        <Label htmlFor="workspace-connection-id">Workspace ID</Label>
        <Input autoComplete="off" className="mt-2" id="workspace-connection-id" onChange={(event) => onWorkspaceChange(event.currentTarget.value)} placeholder="Workspace you belong to" value={workspaceId} />
        <p className="mt-1 text-xs text-muted-foreground">Membership is verified by the API.</p>
      </div>
      <div className="min-w-0">
        <Label className="flex items-center gap-1.5" htmlFor="workspace-connection-token"><KeyRound aria-hidden="true" className="size-3.5 text-muted-foreground" />Platform access token</Label>
        <Input autoComplete="off" className="mt-2" id="workspace-connection-token" onChange={(event) => onTokenChange(event.currentTarget.value)} placeholder="Paste a bearer token" type="password" value={token} />
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
    </CardContent>
  </Card>
);
