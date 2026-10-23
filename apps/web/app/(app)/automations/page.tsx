import type { ReactElement } from "react";
import { AutomationConsole } from "@/features/automation-console";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const AutomationsPage = (): ReactElement => <AutomationConsole apiBaseUrl={API_BASE_URL} />;

export default AutomationsPage;
