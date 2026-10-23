import type { ReactElement } from "react";
import { Badge, Button } from "@workspace/ui";
import { Filter, Plus, Trash2 } from "lucide-react";
import { ConditionLeafEditor } from "./condition-leaf-editor";
import { LIMITS } from "./schema";
import type { ConditionGroupState, ConditionLeafState } from "./types";

type ConditionGroupEditorProps = Readonly<{
  group: ConditionGroupState;
  depth: number;
  totalGroupCount: number;
  totalNodeCount: number;
  triggerType: string;
  errors: Record<string, string>;
  isRoot?: boolean;
  onChange: (updated: ConditionGroupState) => void;
  onRemove?: () => void;
}>;

export const ConditionGroupEditor = ({
  group,
  depth,
  totalGroupCount,
  totalNodeCount,
  triggerType,
  errors,
  isRoot = false,
  onChange,
  onRemove
}: ConditionGroupEditorProps): ReactElement => {
  const isDepthLimitReached = depth >= LIMITS.MAX_CONDITION_DEPTH;
  const isGroupLimitReached = totalGroupCount >= LIMITS.MAX_CONDITION_GROUPS;
  const isNodeLimitReached = totalNodeCount >= LIMITS.MAX_CONDITION_NODES;
  const canAddSubGroup = !isDepthLimitReached && !isGroupLimitReached && !isNodeLimitReached;
  const canAddCondition = !isNodeLimitReached;

  const handleAddCondition = (): void => {
    if (!canAddCondition) return;
    const newLeaf: ConditionLeafState = {
      id: `leaf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "leaf",
      field: "task.status",
      op: "eq",
      value: "completed"
    };
    onChange({
      ...group,
      children: [...group.children, newLeaf]
    });
  };

  const handleAddSubGroup = (): void => {
    if (!canAddSubGroup) return;
    const newSubGroup: ConditionGroupState = {
      id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind: "group",
      conjunction: "all",
      children: [
        {
          id: `leaf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "leaf",
          field: "task.status",
          op: "eq",
          value: "completed"
        }
      ]
    };
    onChange({
      ...group,
      children: [...group.children, newSubGroup]
    });
  };

  const handleChildChange = (
    index: number,
    updated: ConditionLeafState | ConditionGroupState
  ): void => {
    const nextChildren = [...group.children];
    nextChildren[index] = updated;
    onChange({
      ...group,
      children: nextChildren
    });
  };

  const handleRemoveChild = (index: number): void => {
    const nextChildren = group.children.filter((_, i) => i !== index);
    onChange({
      ...group,
      children: nextChildren
    });
  };

  return (
    <div
      className={`rounded-lg border p-3 ${
        isRoot ? "border-border bg-card" : "border-muted-foreground/30 bg-background/50"
      }`}
      data-depth={depth}
      data-testid="condition-group"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border/50 pb-2">
        <div className="flex items-center gap-2">
          <Filter aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {isRoot ? "Root Conditions" : `Sub-Group (Depth ${depth}/${LIMITS.MAX_CONDITION_DEPTH})`}
          </span>

          <div className="flex items-center rounded-md border border-input bg-muted/40 p-0.5">
            <button
              aria-label="Match all conditions (AND)"
              aria-pressed={group.conjunction === "all"}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                group.conjunction === "all"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onChange({ ...group, conjunction: "all" })}
              type="button"
            >
              AND (All)
            </button>
            <button
              aria-label="Match any condition (OR)"
              aria-pressed={group.conjunction === "any"}
              className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                group.conjunction === "any"
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => onChange({ ...group, conjunction: "any" })}
              type="button"
            >
              OR (Any)
            </button>
          </div>

          {isDepthLimitReached && (
            <Badge className="text-[10px]" variant="destructive">
              Max Depth Reached ({LIMITS.MAX_CONDITION_DEPTH})
            </Badge>
          )}

          {isGroupLimitReached && (
            <Badge className="text-[10px]" variant="destructive">
              Max Groups Reached ({LIMITS.MAX_CONDITION_GROUPS})
            </Badge>
          )}
        </div>

        {!isRoot && onRemove && (
          <Button
            aria-label="Remove condition group"
            className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            size="sm"
            type="button"
            variant="ghost"
          >
            <Trash2 aria-hidden="true" className="mr-1 size-3.5" />
            Remove Group
          </Button>
        )}
      </div>

      <div className="space-y-2">
        {group.children.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No conditions configured in this group. Add a condition or sub-group below.
          </p>
        ) : (
          group.children.map((child, index) =>
            child.kind === "leaf" ? (
              <ConditionLeafEditor
                error={errors[`conditions.${index}`]}
                key={child.id}
                leaf={child}
                onChange={(updated) => handleChildChange(index, updated)}
                onRemove={() => handleRemoveChild(index)}
                triggerType={triggerType}
              />
            ) : (
              <ConditionGroupEditor
                depth={depth + 1}
                errors={errors}
                group={child}
                key={child.id}
                onChange={(updated) => handleChildChange(index, updated)}
                onRemove={() => handleRemoveChild(index)}
                totalGroupCount={totalGroupCount}
                totalNodeCount={totalNodeCount}
                triggerType={triggerType}
              />
            )
          )
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 pt-2">
        <Button
          aria-label="Add Condition"
          className="h-7 text-xs"
          disabled={!canAddCondition}
          onClick={handleAddCondition}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus aria-hidden="true" className="mr-1 size-3.5" />
          Add Condition
        </Button>

        <Button
          aria-label="Add Sub-Group"
          className="h-7 text-xs"
          disabled={!canAddSubGroup}
          onClick={handleAddSubGroup}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus aria-hidden="true" className="mr-1 size-3.5" />
          Add Sub-Group
        </Button>

        {isDepthLimitReached && (
          <span className="text-[11px] text-destructive" role="alert">
            Cannot add sub-group: maximum nesting depth of {LIMITS.MAX_CONDITION_DEPTH} reached.
          </span>
        )}

        {isGroupLimitReached && !isDepthLimitReached && (
          <span className="text-[11px] text-destructive" role="alert">
            Cannot add sub-group: maximum limit of {LIMITS.MAX_CONDITION_GROUPS} groups reached.
          </span>
        )}
      </div>
    </div>
  );
};

