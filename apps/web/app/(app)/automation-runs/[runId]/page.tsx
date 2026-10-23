import type { ReactElement } from "react";
import { AutomationRunConsole } from "@/features/automation-console";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const AutomationRunPage = async ({ params }: Readonly<{ params: Promise<{ runId: string }> }>): Promise<ReactElement> => {
  const { runId } = await params;
  return <AutomationRunConsole apiBaseUrl={API_BASE_URL} runId={decodeURIComponent(runId)} />;
};

export default AutomationRunPage;
