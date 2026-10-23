"use client";

import { CircleAlert, RotateCcw } from "lucide-react";
import { useEffect, type ReactElement } from "react";
import { Button, MessageState } from "@workspace/ui";
import type { ErrorPageProps } from "@/types";

const ErrorPage = ({ error, reset }: ErrorPageProps): ReactElement => {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <MessageState
      action={(
        <Button className="mt-7 w-fit" onClick={reset} type="button">
          <RotateCcw aria-hidden="true" className="size-4" /> Retry
        </Button>
      )}
      description="The error was captured at the application boundary."
      eyebrow="Application error"
      icon={<CircleAlert aria-hidden="true" className="size-8 text-red-700" />}
      title="The application could not load."
    />
  );
};

export default ErrorPage;
