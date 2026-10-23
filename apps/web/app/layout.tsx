import type { Metadata } from "next";
import type { ReactElement } from "react";
import { application } from "@/constants/application";
import type { RootLayoutProps } from "@/types";
import "./globals.css";

export const metadata: Metadata = {
  title: application.name,
  description: application.description
};

const RootLayout = ({ children }: RootLayoutProps): ReactElement => (
  <html lang="en">
    <body>{children}</body>
  </html>
);

export default RootLayout;
