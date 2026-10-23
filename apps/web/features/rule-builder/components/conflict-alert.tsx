import type { ReactElement } from "react";
import { Alert, AlertDescription, AlertTitle, Button } from "@workspace/ui";
import { AlertTriangle } from "lucide-react";
import type { ConflictInfo } from "./types";

type ConflictAlertProps = Readonly<{
  conflict: ConflictInfo;
  onDismiss: () => void;
  onReload?: () => void;
}>;

export const ConflictAlert = ({
  conflict,
  onDismiss,
  onReload
}: ConflictAlertProps): ReactElement | null => {
  if (!conflict.occurred) return null;

  return (
    <div className="my-4" data-testid="conflict-alert" role="alert">
      <Alert variant="destructive">
        <AlertTriangle aria-hidden="true" className="size-4" />
        <AlertTitle className="font-semibold">Concurrent Edit Conflict Detected</AlertTitle>
        <AlertDescription className="mt-2 text-sm">
          <p>
            {conflict.message ||
              "This automation was modified by another user or session. Your in-progress changes are preserved in the form below without silent data loss."}
          </p>
          {conflict.expectedRevision !== undefined && conflict.actualRevision !== undefined && (
            <p className="mt-1 font-mono text-xs">
              Expected revision: {conflict.expectedRevision} / Current revision: {conflict.actualRevision}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="outline"
            >
              Keep Editing My Changes
            </Button>
            {onReload && (
              <Button
                onClick={onReload}
                size="sm"
                type="button"
                variant="destructive"
              >
                Reload Server Version
              </Button>
            )}
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
};

