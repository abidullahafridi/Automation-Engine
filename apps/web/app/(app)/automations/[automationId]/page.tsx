import type { ReactElement } from "react";
import { AutomationConsole } from "@/features/automation-console";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const AutomationDetailsPage = async ({ params }: Readonly<{ params: Promise<{ automationId: string }> }>): Promise<ReactElement> => {
  const { automationId } = await params;
  return <AutomationConsole apiBaseUrl={API_BASE_URL} automationId={automationId} />;
};

export default AutomationDetailsPage;
