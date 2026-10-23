import type { ReactElement } from "react";
import { CircleAlert } from "lucide-react";
import Link from "next/link";
import { Button, MessageState } from "@workspace/ui";

const NotFound = (): ReactElement => (
  <MessageState
    action={(
      <Button asChild className="mt-7 w-fit" variant="outline">
        <Link href="/">Return home</Link>
      </Button>
    )}
    description="The requested route does not exist."
    eyebrow="404"
    icon={<CircleAlert aria-hidden="true" className="size-8 text-amber-700" />}
    title="Page not found"
  />
);

export default NotFound;
