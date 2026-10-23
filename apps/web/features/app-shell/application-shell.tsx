"use client";

import Link from "next/link";
import type { Route } from "next";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode, ReactElement } from "react";
import { Activity, CalendarClock, Command, ListChecks, Menu, Moon, Plus, Sun, X, type LucideIcon } from "lucide-react";
import { Button } from "@workspace/ui";

type NavigationItem = Readonly<{ href: string; label: string; icon: LucideIcon }>;

const navigation: readonly NavigationItem[] = [
  { href: "/automations", label: "Automations", icon: ListChecks },
  { href: "/schedules", label: "Schedules", icon: CalendarClock },
  { href: "/automation-ops", label: "Operations", icon: Activity }
];

const pageTitle = (pathname: string): string => {
  if (pathname.endsWith("/builder")) return "Create automation";
  if (pathname.endsWith("/schedule")) return "Schedule";
  if (pathname.startsWith("/automation-runs/")) return "Run details";
  if (pathname.startsWith("/automations/") && pathname !== "/automations") return "Automation details";
  if (pathname === "/schedules") return "Schedules";
  if (pathname === "/automation-ops") return "Operations";
  return "Automations";
};

const NavigationLinks = ({ pathname, onNavigate }: Readonly<{ pathname: string; onNavigate?: () => void }>): ReactElement => (
  <nav aria-label="Workspace" className="space-y-1">
    <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Workspace</p>
    {navigation.map(({ href, label, icon: Icon }) => {
      const active = pathname === href || (href === "/automations" && ((pathname.startsWith("/automations/") && !pathname.endsWith("/schedule")) || pathname.startsWith("/automation-runs/"))) || (href === "/schedules" && pathname.endsWith("/schedule"));
      return <Link
        aria-current={active ? "page" : undefined}
        className={`group flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${active ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-white"}`}
        href={href as Route}
        key={href}
        {...(onNavigate ? { onClick: onNavigate } : {})}
      >
        <Icon aria-hidden="true" className={`size-4 ${active ? "text-sidebar-primary" : "text-sidebar-foreground/70 group-hover:text-white"}`} />
        {label}
      </Link>;
    })}
  </nav>
);

export const ApplicationShell = ({ children }: Readonly<{ children: ReactNode }>): ReactElement => {
  const pathname = usePathname();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => {
    const storedTheme = window.localStorage.getItem("automation-engine-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = storedTheme ? storedTheme === "dark" : prefersDark;
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.classList.toggle("light", !isDark);
  }, []);
  const toggleTheme = (): void => {
    const nextIsDark = !document.documentElement.classList.contains("dark");
    document.documentElement.classList.toggle("dark", nextIsDark);
    document.documentElement.classList.toggle("light", !nextIsDark);
    window.localStorage.setItem("automation-engine-theme", nextIsDark ? "dark" : "light");
  };
  return <div className="min-h-screen w-full overflow-x-clip bg-background text-foreground">
    <a className="sr-only z-50 rounded-md bg-background p-3 text-sm font-medium focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:ring-2 focus:ring-ring" href="#main-content">Skip to content</a>
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground lg:flex" aria-label="Application sidebar">
        <Link className="flex h-[72px] items-center gap-3 border-b border-sidebar-border px-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring" href={"/automations" as Route}>
        <span className="flex size-9 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground shadow-lg shadow-black/20"><Command aria-hidden="true" className="size-[18px]" /></span>
        <span className="min-w-0"><span className="block truncate text-sm font-semibold tracking-tight text-white">Automation Engine</span><span className="mt-0.5 block text-[11px] text-sidebar-foreground/70">WORKSPACE</span></span>
      </Link>
      <div className="flex-1 px-3 py-7"><NavigationLinks pathname={pathname} /></div>
      <div className="border-t border-sidebar-border p-4"><div className="rounded-xl border border-sidebar-border bg-white/[0.04] p-3.5"><p className="text-xs font-semibold text-white">Build reliable workflows</p><p className="mt-1.5 text-xs leading-5 text-sidebar-foreground/75">Draft, validate, publish, then monitor each automation.</p></div></div>
    </aside>
    <div className="min-w-0 lg:pl-64">
      <header className="sticky top-0 z-20 flex h-[68px] items-center justify-between border-b border-border/80 bg-background/90 px-4 backdrop-blur-xl sm:h-[72px] sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <div className="relative lg:hidden">
            <button aria-controls="mobile-workspace-navigation" aria-expanded={mobileNavOpen} aria-label={mobileNavOpen ? "Close navigation" : "Open navigation"} className="flex size-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setMobileNavOpen((open) => !open)} type="button">
              {mobileNavOpen ? <X aria-hidden="true" className="size-4" /> : <Menu aria-hidden="true" className="size-4" />}
            </button>
            {mobileNavOpen && <><button aria-label="Close navigation menu" className="fixed inset-0 z-30 cursor-default bg-slate-950/35 backdrop-blur-[2px] lg:hidden" onClick={() => setMobileNavOpen(false)} type="button" /><div className="fixed inset-y-0 left-0 z-40 w-[min(18rem,85vw)] border-r border-sidebar-border bg-sidebar p-4 pt-20 text-sidebar-foreground shadow-2xl lg:hidden" id="mobile-workspace-navigation"><div className="mb-5 flex items-center gap-3 px-2"><span className="flex size-9 items-center justify-center rounded-xl bg-sidebar-primary text-sidebar-primary-foreground"><Command aria-hidden="true" className="size-4" /></span><div><p className="text-sm font-semibold text-white">Automation Engine</p><p className="text-[11px] text-sidebar-foreground/70">WORKSPACE</p></div></div><NavigationLinks onNavigate={() => setMobileNavOpen(false)} pathname={pathname} /></div></>}
          </div>
          <div className="min-w-0"><p className="truncate text-sm font-semibold tracking-tight">{pageTitle(pathname)}</p><p className="hidden text-xs text-muted-foreground sm:block">Automation workspace <span className="px-1 text-border">/</span> Manage your workflows</p></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button aria-label="Toggle color theme" className="size-9" onClick={toggleTheme} size="icon" title="Toggle color theme" variant="ghost">
            <Moon aria-hidden="true" className="dark:hidden" />
            <Sun aria-hidden="true" className="hidden dark:block" />
          </Button>
          {!pathname.endsWith("/builder") && <Button asChild className="h-9" size="sm"><Link href={"/automations/builder" as Route}><Plus aria-hidden="true" /> <span className="hidden sm:inline">Create automation</span><span className="sm:hidden">Create</span></Link></Button>}
        </div>
      </header>
      <div id="main-content" className="min-w-0" tabIndex={-1}>{children}</div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 px-4 py-5 text-xs text-muted-foreground sm:px-6 lg:px-8"><span>Automation Engine</span><span>Workspace automation console</span></footer>
    </div>
  </div>;
};
