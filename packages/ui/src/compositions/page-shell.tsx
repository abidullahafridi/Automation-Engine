import * as React from "react";
import { cn } from "../utilities/index.js";

type PageShellProps = Readonly<{
  children: React.ReactNode;
  className?: string;
  width?: "standard" | "narrow";
}>;

const widths: Readonly<Record<NonNullable<PageShellProps["width"]>, string>> = {
  standard: "max-w-7xl",
  narrow: "max-w-3xl"
};

export const PageShell = ({ children, className, width = "standard" }: PageShellProps): React.ReactElement => (
  <main className={cn("mx-auto flex w-full min-w-0 flex-col gap-7 px-4 py-7 sm:px-7 sm:py-9 xl:px-10", widths[width], className)}>
    {children}
  </main>
);
