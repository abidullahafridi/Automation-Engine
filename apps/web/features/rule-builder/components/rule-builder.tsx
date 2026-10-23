"use client";

import { useEffect, useState, type ReactElement } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PageHeader,
  PageShell
} from "@workspace/ui";
import { CheckCircle2, Sliders, Wrench } from "lucide-react";
import { ActionListEditor } from "./action-list-editor";
import { ConditionGroupEditor } from "./condition-group-editor";
import { ConflictAlert } from "./conflict-alert";
import {
  calculateConditionStats,
  LIMITS,
  mapServerErrorsToFields
} from "./schema";
import { TriggerEditor } from "./trigger-editor";
import { saveAutomationDraft } from "./draft-api";
import type {
  ConflictInfo,
  RuleBuilderProps,
  RuleDraftFormState,
  SaveDraftResult
} from "./types";

const createDefaultDraftState = (): RuleDraftFormState => ({
  name: "My Automation Rule",
  trigger: {
    type: "task.status_changed",
    toStatus: "completed",
    allowAutomationOrigin: false
  },
  conditions: {
    id: "root-group",
    kind: "group",
    conjunction: "all",
    children: [
      {
        id: "default-leaf",
        kind: "leaf",
        field: "task.status",
        op: "eq",
        value: "completed"
      }
    ]
  },
  actions: [
    {
      id: "default-action",
      type: "notification.send",
      recipientType: "project_lead",
      template: "task_completed",
      onStale: "skip"
    }
  ],
  executionPolicy: {
    onActionFailure: "stop",
    maxAttempts: 1
  }
});

export const RuleBuilder = ({
  initialDraft,
  initialRevision = 1,
  workspaceId = "",
  automationId,
  apiBaseUrl = "",
  bearerToken,
  onSaveDraft
}: RuleBuilderProps): ReactElement => {
  const [draft, setDraft] = useState<RuleDraftFormState>(() => ({
    ...createDefaultDraftState(),
    ...initialDraft
  }));
  const [savedFingerprint, setSavedFingerprint] = useState(() => JSON.stringify({ ...createDefaultDraftState(), ...initialDraft }));

  const [revision, setRevision] = useState<number>(initialRevision);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictInfo>({
    occurred: false,
    message: ""
  });

  const conditionStats = calculateConditionStats(draft.conditions);
  const hasUnsavedChanges = JSON.stringify(draft) !== savedFingerprint;

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (typeof window === "undefined" || initialDraft) return;
    // Restore the locally saved draft AFTER the first committed paint:
    // - the initial render must match the server output (localStorage is unavailable during SSR), and
    // - setState must not run synchronously inside the effect body (react-hooks/set-state-in-effect);
    //   the restore therefore runs in a scheduled callback, cancelled on unmount or key change.
    const handle = window.setTimeout(() => {
      try {
        const draftKey = `automation_draft_${workspaceId}_${automationId || "default"}`;
        const stored = window.localStorage.getItem(draftKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && typeof parsed.name === "string" && parsed.formState) {
            setDraft(parsed.formState);
            if (typeof parsed.revision === "number") {
              setRevision(parsed.revision);
            }
          }
        }
      } catch {
        // Ignore localStorage parse error
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [workspaceId, automationId, initialDraft]);

  const defaultSaveHandler = async (
    draftToSave: RuleDraftFormState,
    currentRev?: number
  ): Promise<SaveDraftResult> => saveAutomationDraft({
    apiBaseUrl,
    workspaceId,
    ...(automationId === undefined ? {} : { automationId }),
    bearerToken: bearerToken ?? "",
    draft: draftToSave,
    ...(currentRev === undefined ? {} : { revision: currentRev })
  });

  const handleSave = async (): Promise<void> => {
    setIsSaving(true);
    setFieldErrors({});
    setGeneralError(null);
    setSaveSuccess(null);

    // Client-side validation checks
    const errors: Record<string, string> = {};
    if (!draft.name.trim()) {
      errors["name"] = "Automation name is required.";
    }
    if (draft.actions.length === 0) {
      errors["actions"] = "At least one action is required.";
    }
    if (draft.actions.length > LIMITS.MAX_ACTIONS_PER_RULE) {
      errors["actions"] = `Maximum of ${LIMITS.MAX_ACTIONS_PER_RULE} actions allowed.`;
    }
    if (conditionStats.maxDepth > LIMITS.MAX_CONDITION_DEPTH) {
      errors["conditions"] = `Condition nesting depth exceeds maximum of ${LIMITS.MAX_CONDITION_DEPTH}.`;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setIsSaving(false);
      return;
    }

    const saveFn = onSaveDraft ?? defaultSaveHandler;
    let result: SaveDraftResult;
    try {
      result = await saveFn(draft, revision);
    } catch (cause) {
      setGeneralError(cause instanceof Error ? cause.message : "The draft could not be saved. Check the connection and try again.");
      setIsSaving(false);
      return;
    }

    setIsSaving(false);

    if (result.kind === "success") {
      setRevision(result.revision);
      setSavedFingerprint(JSON.stringify(draft));
      setSaveSuccess(`Draft saved successfully at revision ${result.revision}.`);
      setConflict({ occurred: false, message: "" });
    } else if (result.kind === "conflict") {
      // TC-0534: Concurrent draft edit reports conflict without silent data loss
      setConflict({
        occurred: true,
        message: result.message,
        expectedRevision: result.expectedRevision,
        actualRevision: result.actualRevision
      });
      // Important: draft state in form is deliberately preserved!
    } else if (result.kind === "validation-error") {
      // TC-0532: Malformed config shows field error
      const mapped = mapServerErrorsToFields(result.errors);
      setFieldErrors(mapped);
      setGeneralError("Server rejected draft with validation errors. Please check the highlighted fields.");
    } else {
      setGeneralError(result.message);
    }
  };

  return (
    <PageShell>
      <PageHeader
        description="Configure event triggers, nested conditions, and ordered actions to automate workspace workflows."
        eyebrow="Rule Builder"
        icon={<Wrench aria-hidden="true" className="size-5 text-primary" />}
        title="Automation Rule Builder"
      />

      <ConflictAlert
        conflict={conflict}
        onDismiss={() => setConflict({ occurred: false, message: "" })}
      />

      {saveSuccess && (
        <Alert className="my-4 border-emerald-500/50 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200">
          <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription className="text-sm">{saveSuccess}</AlertDescription>
        </Alert>
      )}

      {generalError && (
        <Alert className="my-4" variant="destructive">
          <AlertTitle>Cannot Save Draft</AlertTitle>
          <AlertDescription className="text-sm">{generalError}</AlertDescription>
        </Alert>
      )}

      <form
        aria-label="Automation Rule Form"
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
      >
        {/* Rule Details */}
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">Rule Overview</CardTitle>
            <CardDescription className="text-xs">
              Give your automation a recognizable name and purpose.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rule-name">Rule Name</Label>
              <Input
                aria-describedby={fieldErrors["name"] ? "rule-name-error" : undefined}
                aria-invalid={Boolean(fieldErrors["name"])}
                id="rule-name"
                name="name"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="e.g. Notify team on urgent task completion"
                value={draft.name}
              />
              {fieldErrors["name"] && (
                <p className="text-xs font-medium text-destructive" id="rule-name-error" role="alert">
                  {fieldErrors["name"]}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Trigger Editor */}
        <TriggerEditor
          errors={fieldErrors}
          onChange={(trigger) => setDraft({ ...draft, trigger })}
          trigger={draft.trigger}
        />

        {/* Condition Group Editor */}
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">Conditions</CardTitle>
            <CardDescription className="text-xs">
              Configure filtering conditions. Rules execute actions only when conditions evaluate to true.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {fieldErrors["conditions"] && (
              <p className="text-xs font-medium text-destructive" role="alert">
                {fieldErrors["conditions"]}
              </p>
            )}

            <ConditionGroupEditor
              depth={1}
              errors={fieldErrors}
              group={draft.conditions}
              isRoot
              onChange={(conditions) => setDraft({ ...draft, conditions })}
              totalGroupCount={conditionStats.groupCount}
              totalNodeCount={conditionStats.nodeCount}
              triggerType={draft.trigger.type}
            />
          </CardContent>
        </Card>

        {/* Action List Editor */}
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">Actions Execution</CardTitle>
            <CardDescription className="text-xs">
              Ordered list of operations that execute sequentially when conditions match.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ActionListEditor
              actions={draft.actions}
              errors={fieldErrors}
              onChange={(actions) => setDraft({ ...draft, actions })}
            />
          </CardContent>
        </Card>

        {/* Execution Policy */}
        <Card className="border-border">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Sliders aria-hidden="true" className="size-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium">Execution Policy</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="action-failure-policy">On Action Failure</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                id="action-failure-policy"
                name="onActionFailure"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    executionPolicy: { ...draft.executionPolicy, onActionFailure: e.target.value }
                  })
                }
                value={draft.executionPolicy.onActionFailure}
              >
                <option value="stop">Stop execution immediately (stop)</option>
                <option value="continue">Continue remaining actions (continue)</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="max-attempts">Max Retry Attempts</Label>
              <Input
                id="max-attempts"
                min={1}
                name="maxAttempts"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    executionPolicy: {
                      ...draft.executionPolicy,
                      maxAttempts: Math.max(1, Number.parseInt(e.target.value, 10) || 1)
                    }
                  })
                }
                type="number"
                value={draft.executionPolicy.maxAttempts}
              />
            </div>
          </CardContent>
        </Card>

        {/* Save Controls */}
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-xs text-muted-foreground">
            <span aria-live="polite">{hasUnsavedChanges ? "Unsaved changes · " : "All changes saved · "}</span>
            Revision <code className="font-mono">{revision}</code>
          </div>

          <div className="flex items-center gap-3 sm:justify-end">
            <Button
              className="min-h-10 w-full sm:min-w-32 sm:w-auto"
              disabled={isSaving}
              type="submit"
            >
              {isSaving ? "Saving Draft..." : "Save Draft"}
            </Button>
          </div>
        </div>
      </form>
    </PageShell>
  );
};
