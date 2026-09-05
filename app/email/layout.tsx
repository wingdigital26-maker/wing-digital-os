"use client";
import SectionChrome, { type SectionTab } from "../components/SectionChrome";

// Shared chrome for the Email section. The header is SectionChrome (shared with
// /calls, /sequences and /automations); this file only owns the Email tabs.
// One surface today (Compose), but the strip keeps the section consistent with
// the rest of the OS and leaves room for an inbox tab later.

const TABS: SectionTab[] = [
  { href: "/email", label: "Compose", exact: true },
];

export default function EmailLayout({ children }: { children: React.ReactNode }) {
  return (
    <SectionChrome title="Email" tabs={TABS}>
      {children}
    </SectionChrome>
  );
}
