"use client";

import dynamic from "next/dynamic";
import { useEffect, useState, type ReactElement } from "react";
import { Card, CardContent, Input, Label } from "@workspace/ui";

const RuleBuilder = dynamic(
  () => import("@/features/rule-builder").then((mod) => mod.RuleBuilder),
  { ssr: false }
);

// NEXT_PUBLIC_ vars must be read at module level so Next.js inlines them
// at compile time. Reading process.env inside a function body at runtime
// in the browser yields undefined and fails Zod validation.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";
const TOKEN_KEY = "automation_console_bearer_token";
const WORKSPACE_KEY = "automation_console_workspace_id";

const AutomationBuilderPage = (): ReactElement => {
  const [workspaceId, setWorkspaceId] = useState("");
  const [bearerToken, setBearerToken] = useState("");

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setWorkspaceId(window.sessionStorage.getItem(WORKSPACE_KEY) ?? "");
      setBearerToken(window.sessionStorage.getItem(TOKEN_KEY) ?? "");
    }, 0);
    return () => window.clearTimeout(handle);
  }, []);

  return <>
    <Card className="mx-auto mt-8 max-w-5xl">
      <CardContent className="grid gap-4 py-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="builder-workspace-id">Workspace ID</Label>
          <Input
            autoComplete="off"
            className="mt-2"
            id="builder-workspace-id"
            onChange={(event) => {
              const value = event.currentTarget.value.trim();
              setWorkspaceId(value);
              window.sessionStorage.setItem(WORKSPACE_KEY, value);
            }}
            placeholder="Enter a workspace you belong to"
            value={workspaceId}
          />
          <p className="mt-1 text-xs text-muted-foreground">Workspace access is verified by the API; this value does not grant access.</p>
        </div>
        <div>
          <Label htmlFor="builder-platform-token">Platform access token</Label>
          <Input
            autoComplete="off"
            className="mt-2"
            id="builder-platform-token"
            onChange={(event) => {
              const value = event.currentTarget.value;
              setBearerToken(value);
              if (value) window.sessionStorage.setItem(TOKEN_KEY, value);
              else window.sessionStorage.removeItem(TOKEN_KEY);
            }}
            placeholder="Bearer token"
            type="password"
            value={bearerToken}
          />
        </div>
      </CardContent>
    </Card>
    <RuleBuilder
      apiBaseUrl={API_BASE_URL}
      bearerToken={bearerToken}
      workspaceId={workspaceId}
    />
  </>;
};

export default AutomationBuilderPage;
