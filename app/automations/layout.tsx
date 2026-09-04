"use client";
import SectionChrome, { type SectionTab } from "../components/SectionChrome";

// Shared chrome for the Automations section. The header is SectionChrome
// (shared with /calls and /sequences); this file only owns the Automations
// tabs. Forms lives here as a tab and nowhere else in the nav.

const TABS: SectionTab[] = [
  { href: "/automations", label: "Workflows", exact: true },
  { href: "/automations/forms", label: "Forms" },
  { href: "/automations/tasks", label: "Tasks" },
  { href: "/automations/phone", label: "Phone numbers" },
  { href: "/automations/runs", label: "Activity" },
];

// A workflow detail page (/automations/<id>) still belongs to the Workflows
// tab; the named sub-sections are their own tabs.
function isActive(t: SectionTab, pathname: string): boolean {
  return t.exact
    ? pathname === t.href || /^\/automations\/(?!forms|tasks|phone|runs)[^/]+$/.test(pathname)
    : pathname.startsWith(t.href);
}

export default function AutomationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionChrome title="Automations" tabs={TABS} isTabActive={isActive}>
      {children}
    </SectionChrome>
  );
}
