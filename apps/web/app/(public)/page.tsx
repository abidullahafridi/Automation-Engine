import type { ReactElement } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Button } from "@workspace/ui";
import { createApiConfiguration, readWebEnvironment } from "@/config";
import { WorkspaceFoundation } from "@/features/workspace-foundation";

const HomePage = (): ReactElement => {
  const api = createApiConfiguration(readWebEnvironment());
  return <>
    <WorkspaceFoundation apiBaseUrl={api.baseUrl} />
    <div className="mx-auto max-w-5xl px-6 pb-10">
      <Button asChild><Link href={"/automations" as Route}>Open automation workspace</Link></Button>
    </div>
  </>;
};

export default HomePage;
