import type { ReactElement } from "react";
import SchedulesOverview from "@/features/automation-console/schedules-overview";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const SchedulesPage = (): ReactElement => <SchedulesOverview apiBaseUrl={API_BASE_URL} />;

export default SchedulesPage;
