"use client";
import SectionChrome, { type SectionTab } from "../components/SectionChrome";

// Shared chrome for the Sequences section. The header is SectionChrome (shared
// with /calls and /automations); this file only owns the Sequences tabs.

const TABS: SectionTab[] = [
  { href: "/sequences", label: "Sequences", exact: true },
  { href: "/sequences/people", label: "People" },
];

// A sequence detail page (/sequences/<id>) still belongs to the Sequences tab;
// only /sequences/people is its own tab.
function isActive(t: SectionTab, pathname: string): boolean {
  return t.exact
    ? pathname === t.href || /^\/sequences\/(?!people)[^/]+$/.test(pathname)
    : pathname.startsWith(t.href);
}

export default function SequencesLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionChrome title="Sequences" tabs={TABS} isTabActive={isActive}>
      {children}
    </SectionChrome>
  );
}
