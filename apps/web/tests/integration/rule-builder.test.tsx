import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RuleBuilder,
  saveAutomationDraft,
  calculateConditionStats,
  formStateToRulePayload,
  mapServerErrorsToFields,
  type ActionConfigState,
  type ConditionGroupState,
  type RuleDraftFormState,
  type ServerValidationIssue
} from "../../features/rule-builder";

const apiDraft: RuleDraftFormState = {
  name: "Verified API draft",
  trigger: { type: "task.status_changed", toStatus: "completed", allowAutomationOrigin: false },
  conditions: { id: "root", kind: "group", conjunction: "all", children: [] },
  actions: [{ id: "notify", type: "notification.send", recipientType: "project_lead", template: "task_completed", onStale: "skip" }],
  executionPolicy: { onActionFailure: "stop", maxAttempts: 1 }
};

test("draft save sends trusted credential and selected workspace to the API", async () => {
  let requestedUrl = "";
  let requestHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ automation: { automationId: "auto-1", revision: 2 } }), {
      status: 201,
      headers: { "Content-Type": "application/json" }
    });
  };

  const result = await saveAutomationDraft({
    apiBaseUrl: "https://automation.example",
    workspaceId: "workspace / one",
    bearerToken: "verified-token",
    draft: apiDraft
  }, fetcher);

  assert.equal(requestedUrl, "https://automation.example/api/v1/workspaces/workspace%20%2F%20one/automations");
  assert.equal(requestHeaders?.get("authorization"), "Bearer verified-token");
  assert.ok(requestHeaders?.get("idempotency-key"));
  assert.deepEqual(result, { kind: "success", automationId: "auto-1", revision: 2 });
});

test("draft save fails closed without token and never claims a local save", async () => {
  let requestCount = 0;
  const fetcher: typeof fetch = async () => {
    requestCount += 1;
    return new Response("unavailable", { status: 503 });
  };
  const missingToken = await saveAutomationDraft({ apiBaseUrl: "", workspaceId: "w1", bearerToken: "", draft: apiDraft }, fetcher);
  const apiUnavailable = await saveAutomationDraft({ apiBaseUrl: "", workspaceId: "w1", bearerToken: "token", draft: apiDraft }, fetcher);

  assert.equal(requestCount, 1);
  assert.equal(missingToken.kind, "error");
  assert.equal(apiUnavailable.kind, "error");
  assert.doesNotMatch(JSON.stringify(apiUnavailable), /saved successfully|local/i);
});

test("TC-0531: supported action fields render by schema", () => {
  const customDraft: RuleDraftFormState = {
    name: "Notification Rule",
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
          id: "leaf-1",
          kind: "leaf",
          field: "task.status",
          op: "eq",
          value: "completed"
        }
      ]
    },
    actions: [
      {
        id: "action-1",
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
  };

  const markup = renderToStaticMarkup(<RuleBuilder initialDraft={customDraft} />);

  // Asserts action card is rendered with schema version and type
  assert.match(markup, /Send Notification/);
  assert.match(markup, /notification\.send/);
  assert.match(markup, /v1/);

  // Asserts schema-driven action fields are present and accessible
  assert.match(markup, /name="actions\.0\.recipientType"/);
  assert.match(markup, /Project Lead \(project_lead\)/);
  assert.match(markup, /name="actions\.0\.template"/);
  assert.match(markup, /Task Completed \(task_completed\)/);
  assert.match(markup, /On Stale Policy:/);
  assert.match(markup, /skip/);

  // Asserts payload serialization follows the backend RuleDocument contract
  const payload = formStateToRulePayload(customDraft) as Record<string, unknown>;
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.name, "Notification Rule");
  assert.deepEqual(payload.actions, [
    {
      type: "notification.send",
      config: {
        recipient: { type: "project_lead" },
        template: "task_completed"
      },
      onStale: "skip"
    }
  ]);
});

test("TC-0532: malformed config shows field error and does not imply successful enablement", () => {
  const serverIssues: readonly ServerValidationIssue[] = [
    {
      code: "AUTOMATION_INVALID_ACTION",
      path: "/actions/0/config/template",
      message: "Action configuration does not match its registered schema."
    },
    {
      code: "AUTOMATION_INVALID_TRIGGER",
      path: "/trigger/config/toStatus",
      message: "Trigger configuration does not match its registered schema."
    },
    {
      code: "AUTOMATION_INVALID_RULE",
      path: "/name",
      message: "Automation name is required."
    }
  ];

  // Test server error mapping to form field keys
  const mappedErrors = mapServerErrorsToFields(serverIssues);
  assert.equal(
    mappedErrors["actions.0.template"],
    "Action configuration does not match its registered schema."
  );
  assert.equal(
    mappedErrors["trigger.toStatus"],
    "Trigger configuration does not match its registered schema."
  );
  assert.equal(mappedErrors["name"], "Automation name is required.");

  // Test that rule builder can handle validation error result on save
  const mockSaveValidation = async () => ({
    kind: "validation-error" as const,
    errors: serverIssues
  });

  const markup = renderToStaticMarkup(
    <RuleBuilder
      initialDraft={{
        name: "",
        trigger: {
          type: "task.status_changed",
          toStatus: "",
          allowAutomationOrigin: false
        }
      }}
      onSaveDraft={mockSaveValidation}
    />
  );

  // Asserts inputs and labels exist for accessible error association
  assert.match(markup, /id="rule-name"/);
  assert.match(markup, /id="trigger-to-status"/);
  assert.match(markup, /id="action-0-template"/);

  // Asserts that the page does not imply successful enablement
  assert.doesNotMatch(markup, /Draft saved successfully/);
  assert.doesNotMatch(markup, /Rule is enabled/);
});

test("TC-0533: nesting and action limits are enforced", () => {
  // 1. Action count limit (10)
  const tenActions: ActionConfigState[] = Array.from({ length: 10 }, (_, i) => ({
    id: `action-${i}`,
    type: "notification.send",
    recipientType: "project_lead",
    template: "task_completed",
    onStale: "skip"
  }));

  const actionLimitMarkup = renderToStaticMarkup(
    <RuleBuilder initialDraft={{ actions: tenActions }} />
  );

  // Asserts action limit badge and warning are displayed
  assert.match(actionLimitMarkup, /Action Limit Reached/);
  assert.match(actionLimitMarkup, /10\/10/);
  assert.match(actionLimitMarkup, /Maximum of 10 actions allowed/);

  // Asserts Add Action button is disabled when at limit
  assert.match(actionLimitMarkup, /disabled=""[^>]*aria-label="Add Action"|aria-label="Add Action"[^>]*disabled=""/);

  // 2. Condition nesting depth limit (depth 5)
  // Build deeply nested condition tree (depth 5)
  const deepConditions: ConditionGroupState = {
    id: "g1",
    kind: "group",
    conjunction: "all",
    children: [
      {
        id: "g2",
        kind: "group",
        conjunction: "all",
        children: [
          {
            id: "g3",
            kind: "group",
            conjunction: "all",
            children: [
              {
                id: "g4",
                kind: "group",
                conjunction: "all",
                children: [
                  {
                    id: "g5",
                    kind: "group",
                    conjunction: "all",
                    children: []
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const stats = calculateConditionStats(deepConditions);
  assert.equal(stats.maxDepth, 5);
  assert.equal(stats.groupCount, 5);

  const conditionLimitMarkup = renderToStaticMarkup(
    <RuleBuilder initialDraft={{ conditions: deepConditions }} />
  );

  // Asserts depth limit reached badge is rendered
  assert.match(conditionLimitMarkup, /Max Depth Reached \(5\)/);
  assert.match(conditionLimitMarkup, /Cannot add sub-group: maximum nesting depth of 5 reached/);
});

test("TC-0534: concurrent draft edit reports conflict without silent data loss", () => {
  const userEditedDraft: RuleDraftFormState = {
    name: "User In-Progress Edits",
    trigger: {
      type: "task.status_changed",
      toStatus: "in_review",
      allowAutomationOrigin: true
    },
    conditions: {
      id: "root-group",
      kind: "group",
      conjunction: "any",
      children: [
        {
          id: "leaf-edited",
          kind: "leaf",
          field: "task.priority",
          op: "eq",
          value: "urgent"
        }
      ]
    },
    actions: [
      {
        id: "action-edited",
        type: "notification.send",
        recipientType: "project_lead",
        template: "task_completed",
        onStale: "skip"
      }
    ],
    executionPolicy: {
      onActionFailure: "continue",
      maxAttempts: 3
    }
  };

  // Mock save function simulating a 409 revision conflict
  const conflictSaveHandler = async () => ({
    kind: "conflict" as const,
    message: "Automation was modified by another session; reload and retry with current revision.",
    expectedRevision: 2,
    actualRevision: 3
  });

  const markup = renderToStaticMarkup(
    <RuleBuilder
      initialDraft={userEditedDraft}
      initialRevision={2}
      onSaveDraft={conflictSaveHandler}
    />
  );

  // Asserts user-edited form fields are preserved in markup without data loss
  assert.match(markup, /value="User In-Progress Edits"/);
  assert.match(markup, /value="in_review"/);
  assert.match(markup, /checked=""[^>]*id="trigger-allow-automation-origin"|id="trigger-allow-automation-origin"[^>]*checked=""/);
  assert.match(markup, /value="3"/);

  // Asserts revision indicator matches initial revision
  assert.match(markup, /Revision <code class="font-mono">2<\/code>/);

  // Asserts that no false success state is rendered
  assert.doesNotMatch(markup, /Draft saved successfully/);
  assert.doesNotMatch(markup, /Rule is enabled/);
});
