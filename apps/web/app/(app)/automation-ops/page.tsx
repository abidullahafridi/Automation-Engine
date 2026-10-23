import type { ReactElement } from "react";
import OperationsConsole from "@/features/automation-console/operations-console";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const AutomationOperationsPage = (): ReactElement => <OperationsConsole apiBaseUrl={API_BASE_URL} />;

export default AutomationOperationsPage;
