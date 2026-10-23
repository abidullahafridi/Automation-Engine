import type { ReactElement } from "react";
import { Button, Input } from "@workspace/ui";
import { Trash2 } from "lucide-react";
import {
  SUPPORTED_OPERATORS,
  SUPPORTED_TRIGGERS,
  type TriggerFieldDefinition
} from "./schema";
import type { ConditionLeafState, ConditionOperator } from "./types";

type ConditionLeafEditorProps = Readonly<{
  leaf: ConditionLeafState;
  triggerType: string;
  error?: string | undefined;
  onChange: (updated: ConditionLeafState) => void;
  onRemove: () => void;
}>;

export const ConditionLeafEditor = ({
  leaf,
  triggerType,
  error,
  onChange,
  onRemove
}: ConditionLeafEditorProps): ReactElement => {
  const triggerDef = SUPPORTED_TRIGGERS[triggerType as keyof typeof SUPPORTED_TRIGGERS];
  const fields: Readonly<Record<string, TriggerFieldDefinition>> = triggerDef ? triggerDef.fields : {};
  const currentFieldDef = fields[leaf.field];

  const requiresValue = leaf.op !== "exists" && leaf.op !== "not_exists";

  return (
    <div className="flex flex-col gap-1 rounded-md border border-muted bg-muted/30 p-2 sm:flex-row sm:items-center sm:gap-2">
      <div className="grid flex-1 grid-cols-1 gap-2 sm:grid-cols-3">
        <select
          aria-label="Condition Field"
          className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) =>
            onChange({
              ...leaf,
              field: event.target.value
            })
          }
          value={leaf.field}
        >
          {Object.entries(fields).map(([fieldName, fieldMeta]) => (
            <option key={fieldName} value={fieldName}>
              {fieldMeta.label} ({fieldName})
            </option>
          ))}
        </select>

        <select
          aria-label="Condition Operator"
          className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onChange={(event) =>
            onChange({
              ...leaf,
              op: event.target.value as ConditionOperator
            })
          }
          value={leaf.op}
        >
          {SUPPORTED_OPERATORS.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>

        {requiresValue ? (
          currentFieldDef?.type === "enum" && currentFieldDef.options ? (
            <select
              aria-label="Condition Value"
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(event) =>
                onChange({
                  ...leaf,
                  value: event.target.value
                })
              }
              value={leaf.value}
            >
              <option value="">Select value...</option>
              {currentFieldDef.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : currentFieldDef?.type === "boolean" ? (
            <select
              aria-label="Condition Value"
              className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onChange={(event) =>
                onChange({
                  ...leaf,
                  value: event.target.value
                })
              }
              value={leaf.value}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <Input
              aria-label="Condition Value"
              className="h-8 text-xs"
              onChange={(event) =>
                onChange({
                  ...leaf,
                  value: event.target.value
                })
              }
              placeholder="Value"
              value={leaf.value}
            />
          )
        ) : (
          <div className="flex h-8 items-center px-2 text-xs italic text-muted-foreground">
            No value needed
          </div>
        )}
      </div>

      <Button
        aria-label="Remove condition"
        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </Button>

      {error && (
        <span className="text-xs font-medium text-destructive" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
