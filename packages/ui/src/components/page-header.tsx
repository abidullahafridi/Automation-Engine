import * as React from "react";

type PageHeaderProps = Readonly<{
  description: string;
  eyebrow: string;
  icon: React.ReactNode;
  title: string;
}>;

export const PageHeader = ({ description, eyebrow, icon, title }: PageHeaderProps): React.ReactElement => (
  <header className="flex min-w-0 items-start gap-4 border-b border-border/80 pb-7 sm:gap-5">
    <div className="mt-1 flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15">
      {icon}
    </div>
    <div className="min-w-0">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-primary">{eyebrow}</p>
      <h1 className="break-words text-[26px] font-semibold leading-tight tracking-[-0.035em] text-foreground sm:text-[32px]">{title}</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-[15px]">{description}</p>
    </div>
  </header>
);
