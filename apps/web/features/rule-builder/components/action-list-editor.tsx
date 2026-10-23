import type { ReactElement } from "react";
import { Badge, Button } from "@workspace/ui";
import { Plus, Zap } from "lucide-react";
import { ActionCardEditor } from "./action-card-editor";
import { LIMITS } from "./schema";
import type { ActionConfigState } from "./types";

type ActionListEditorProps = Readonly<{
  actions: readonly ActionConfigState[];
  errors: Record<string, string>;
  onChange: (updated: readonly ActionConfigState[]) => void;
}>;

export const ActionListEditor = ({
  actions,
  errors,
  onChange
}: ActionListEditorProps): ReactElement => {
  const isLimitReached = actions.length >= LIMITS.MAX_ACTIONS_PER_RULE;
  const actionsError = errors["actions"];

  const handleAddAction = (): void => {
    if (isLimitReached) return;
    const newAction: ActionConfigState = {
      id: `action-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: "notification.send",
      recipientType: "project_lead",
      template: "task_completed",
      onStale: "skip"
    };
    onChange([...actions, newAction]);
  };

  const handleActionChange = (index: number, updated: ActionConfigState): void => {
    const next = [...actions];
    next[index] = updated;
    onChange(next);
  };

  const handleMoveUp = (index: number): void => {
    if (index === 0) return;
    const next = [...actions];
    const temp = next[index - 1];
    const current = next[index];
    if (temp && current) {
      next[index - 1] = current;
      next[index] = temp;
      onChange(next);
    }
  };

  const handleMoveDown = (index: number): void => {
    if (index >= actions.length - 1) return;
    const next = [...actions];
    const current = next[index];
    const temp = next[index + 1];
    if (temp && current) {
      next[index] = temp;
      next[index + 1] = current;
      onChange(next);
    }
  };

  const handleRemove = (index: number): void => {
    onChange(actions.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap aria-hidden="true" className="size-4 text-primary" />
          <h3 className="text-base font-medium text-foreground">Actions</h3>
          <Badge className="font-mono text-xs" variant="secondary">
            {actions.length}/{LIMITS.MAX_ACTIONS_PER_RULE}
          </Badge>
          {isLimitReached && (
            <Badge className="text-xs" variant="destructive">
              Action Limit Reached
            </Badge>
          )}
        </div>

        <Button
          aria-label="Add Action"
          disabled={isLimitReached}
          onClick={handleAddAction}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus aria-hidden="true" className="mr-1 size-3.5" />
          Add Action
        </Button>
      </div>

      {actionsError && (
        <p className="text-xs font-medium text-destructive" role="alert">
          {actionsError}
        </p>
      )}

      {isLimitReached && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
          Maximum of {LIMITS.MAX_ACTIONS_PER_RULE} actions allowed per automation rule. You cannot add more actions.
        </div>
      )}

      {actions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          No actions configured yet. An automation requires at least one action.
        </div>
      ) : (
        <div className="space-y-3">
          {actions.map((action, index) => (
            <ActionCardEditor
              action={action}
              errors={errors}
              index={index}
              key={action.id}
              onChange={(updated) => handleActionChange(index, updated)}
              onMoveDown={() => handleMoveDown(index)}
              onMoveUp={() => handleMoveUp(index)}
              onRemove={() => handleRemove(index)}
              totalCount={actions.length}
            />
          ))}
        </div>
      )}
    </div>
  );
};

