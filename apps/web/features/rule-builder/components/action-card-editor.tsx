import type { ReactElement } from "react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Label } from "@workspace/ui";
import { ArrowDown, ArrowUp, Send, Trash2 } from "lucide-react";
import { SUPPORTED_ACTIONS } from "./schema";
import type { ActionConfigState } from "./types";

type ActionCardEditorProps = Readonly<{
  action: ActionConfigState;
  index: number;
  totalCount: number;
  errors: Record<string, string>;
  onChange: (updated: ActionConfigState) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}>;

export const ActionCardEditor = ({
  action,
  index,
  totalCount,
  errors,
  onChange,
  onMoveUp,
  onMoveDown,
  onRemove
}: ActionCardEditorProps): ReactElement => {
  const actionDef = SUPPORTED_ACTIONS[action.type as keyof typeof SUPPORTED_ACTIONS];
  const templateError = errors[`actions.${index}.template`];
  const recipientError = errors[`actions.${index}.recipientType`];
  const actionError = errors[`actions.${index}`];

  return (
    <Card className="border-border bg-card/60" data-testid={`action-card-${index}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 font-mono text-xs font-bold text-primary">
              {index + 1}
            </span>
            <Send aria-hidden="true" className="size-4 text-primary" />
            <CardTitle className="text-sm font-medium">
              {actionDef?.label ?? action.type}
            </CardTitle>
            <Badge className="text-[10px]" variant="outline">
              v{actionDef?.schemaVersion ?? 1}
            </Badge>
          </div>

          <div className="flex items-center gap-1">
            <Button
              aria-label={`Move action ${index + 1} up`}
              className="size-7"
              disabled={index === 0}
              onClick={onMoveUp}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowUp aria-hidden="true" className="size-3.5" />
            </Button>
            <Button
              aria-label={`Move action ${index + 1} down`}
              className="size-7"
              disabled={index === totalCount - 1}
              onClick={onMoveDown}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ArrowDown aria-hidden="true" className="size-3.5" />
            </Button>
            <Button
              aria-label={`Remove action ${index + 1}`}
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Trash2 aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {actionError && (
          <p className="text-xs font-medium text-destructive" role="alert">
            {actionError}
          </p>
        )}

        <div className="space-y-2">
          <Label htmlFor={`action-${index}-type-select`}>Action Type</Label>
          <select
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            id={`action-${index}-type-select`}
            onChange={(event) => {
              const newType = event.target.value;
              const def = SUPPORTED_ACTIONS[newType as keyof typeof SUPPORTED_ACTIONS];
              onChange({
                ...action,
                type: newType,
                recipientType: def?.defaultConfig.recipientType ?? "project_lead",
                template: def?.defaultConfig.template ?? "task_completed"
              });
            }}
            value={action.type}
          >
            {Object.values(SUPPORTED_ACTIONS).map((item) => (
              <option key={item.type} value={item.type}>
                {item.label} ({item.type})
              </option>
            ))}
          </select>
        </div>

        {/* Schema-driven action config fields */}
        {action.type === "notification.send" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`action-${index}-recipient-type`}>Recipient Type</Label>
              <select
                aria-describedby={recipientError ? `action-${index}-recipient-error` : undefined}
                aria-invalid={Boolean(recipientError)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                id={`action-${index}-recipient-type`}
                name={`actions.${index}.recipientType`}
                onChange={(event) =>
                  onChange({
                    ...action,
                    recipientType: event.target.value
                  })
                }
                value={action.recipientType}
              >
                <option value="project_lead">Project Lead (project_lead)</option>
              </select>
              {recipientError && (
                <p
                  className="text-xs font-medium text-destructive"
                  id={`action-${index}-recipient-error`}
                  role="alert"
                >
                  {recipientError}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor={`action-${index}-template`}>Notification Template</Label>
              <select
                aria-describedby={templateError ? `action-${index}-template-error` : undefined}
                aria-invalid={Boolean(templateError)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                id={`action-${index}-template`}
                name={`actions.${index}.template`}
                onChange={(event) =>
                  onChange({
                    ...action,
                    template: event.target.value
                  })
                }
                value={action.template}
              >
                <option value="task_completed">Task Completed (task_completed)</option>
                <option value="invalid_template">Invalid Template (test error)</option>
              </select>
              {templateError && (
                <p
                  className="text-xs font-medium text-destructive"
                  id={`action-${index}-template-error`}
                  role="alert"
                >
                  {templateError}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          On Stale Policy: <code className="rounded bg-muted px-1 py-0.5 font-mono">{action.onStale}</code>
        </div>
      </CardContent>
    </Card>
  );
};

