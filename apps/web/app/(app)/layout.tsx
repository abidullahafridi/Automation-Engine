import type { ReactElement } from "react";
import type { RootLayoutProps } from "@/types";
import { ApplicationShell } from "@/features/app-shell";

const ApplicationLayout = ({ children }: RootLayoutProps): ReactElement => <ApplicationShell>{children}</ApplicationShell>;

export default ApplicationLayout;
