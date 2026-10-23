import type { ReactElement } from "react";
import ScheduleConsole from "@/features/automation-console/schedule-console";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const AutomationSchedulePage = async ({ params }: Readonly<{ params: Promise<{ automationId: string }> }>): Promise<ReactElement> => {
  const { automationId } = await params;
  return <ScheduleConsole apiBaseUrl={API_BASE_URL} automationId={automationId} />;
};

export default AutomationSchedulePage;
