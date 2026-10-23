import type { ReactElement } from "react";
import { Card, CardContent, CardHeader, CardTitle, Input, Label } from "@workspace/ui";
import { Zap } from "lucide-react";
import { SUPPORTED_TRIGGERS } from "./schema";
import type { TriggerConfigState } from "./types";

type TriggerEditorProps = Readonly<{
  trigger: TriggerConfigState;
  errors: Record<string, string>;
  onChange: (updated: TriggerConfigState) => void;
}>;

export const TriggerEditor = ({
  trigger,
  errors,
  onChange
}: TriggerEditorProps): ReactElement => {
  const currentTrigger = SUPPORTED_TRIGGERS[trigger.type as keyof typeof SUPPORTED_TRIGGERS];
  const toStatusError = errors["trigger.toStatus"];
  const triggerError = errors["trigger"];

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Zap aria-hidden="true" className="size-4 text-amber-500" />
          <CardTitle className="text-base font-medium">Trigger</CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {triggerError && (
          <p className="text-xs font-medium text-destructive" role="alert">
            {triggerError}
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor="trigger-type-select">Event Trigger</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            id="trigger-type-select"
            onChange={(event) => {
              const newType = event.target.value;
              const def = SUPPORTED_TRIGGERS[newType as keyof typeof SUPPORTED_TRIGGERS];
              onChange({
                type: newType,
                toStatus: def?.defaultConfig.toStatus ?? "completed",
                allowAutomationOrigin: def?.defaultConfig.allowAutomationOrigin ?? false
              });
            }}
            value={trigger.type}
          >
            {Object.values(SUPPORTED_TRIGGERS).map((item) => (
              <option key={item.type} value={item.type}>
                {item.label} ({item.type})
              </option>
            ))}
          </select>
        </div>

        {currentTrigger && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="trigger-to-status">Target Status (toStatus)</Label>
              <Input
                aria-describedby={toStatusError ? "trigger-to-status-error" : undefined}
                aria-invalid={Boolean(toStatusError)}
                id="trigger-to-status"
                name="toStatus"
                onChange={(event) =>
                  onChange({
                    ...trigger,
                    toStatus: event.target.value
                  })
                }
                placeholder="e.g. completed"
                value={trigger.toStatus}
              />
              {toStatusError && (
                <p
                  className="text-xs font-medium text-destructive"
                  id="trigger-to-status-error"
                  role="alert"
                >
                  {toStatusError}
                </p>
              )}
            </div>

            <div className="flex items-center space-x-2 pt-6">
              <input
                checked={trigger.allowAutomationOrigin}
                className="size-4 rounded border-input text-primary focus:ring-ring"
                id="trigger-allow-automation-origin"
                name="allowAutomationOrigin"
                onChange={(event) =>
                  onChange({
                    ...trigger,
                    allowAutomationOrigin: event.target.checked
                  })
                }
                type="checkbox"
              />
              <Label className="cursor-pointer text-sm" htmlFor="trigger-allow-automation-origin">
                Allow Automation Origin (allow loops/re-triggers)
              </Label>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

