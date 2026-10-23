import * as React from "react";
import { PageShell } from "./page-shell.js";

type MessageStateProps = Readonly<{
  action?: React.ReactNode;
  description: string;
  eyebrow: string;
  icon: React.ReactNode;
  title: string;
}>;

export const MessageState = ({ action, description, eyebrow, icon, title }: MessageStateProps): React.ReactElement => (
  <PageShell className="justify-center" width="narrow">
    {icon}
    <p className="mt-5 text-sm font-semibold text-foreground">{eyebrow}</p>
    <h1 className="mt-3 text-2xl font-semibold text-foreground">{title}</h1>
    <p className="mt-3 text-muted-foreground">{description}</p>
    {action}
  </PageShell>
);
