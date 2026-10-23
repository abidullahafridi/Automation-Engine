import type { ReactNode } from "react";

export type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export type ErrorPageProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;
