"use client";
import { useEffect, useState } from "react";
import SectionChrome, { type SectionTab } from "../components/SectionChrome";

// Shared chrome for the whole Call Room section. Every screen under /calls
// hangs off this nav, so it must have exactly one author. The header itself is
// SectionChrome (shared with /sequences and /automations); this file only owns
// the Call Room tabs and the per-section extras.
//
// "Manage callers" only renders for admins. The check is cosmetic (middleware
// and the API both enforce it for real); hiding a button nobody can use is
// just not showing a caller a door that is locked.

const TABS: SectionTab[] = [
  // "Today" and "Dial list" merged into one Call Room screen (2026-09-15), so
  // the section root IS the working list now — no separate Dial list tab.
  { href: "/calls", label: "Dial list", exact: true },
];

export default function CallsLayout({ children }: { children: React.ReactNode }) {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/calls/leads?status=all&limit=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.me) return;
        setEmail(d.me.email ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return (
    <SectionChrome
      title="Call Room"
      tabs={TABS}
      extras={
        <>
          {email && (
            <span className="sc-email" title={email}>{email}</span>
          )}
        </>
      }
    >
      {children}
    </SectionChrome>
  );
}
