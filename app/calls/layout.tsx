"use client";
import { useEffect, useState } from "react";
import SectionChrome, { sectionBtn, type SectionTab } from "../components/SectionChrome";

// Shared chrome for the whole Call Room section. Every screen under /calls
// hangs off this nav, so it must have exactly one author. The header itself is
// SectionChrome (shared with /sequences and /automations); this file only owns
// the Call Room tabs and the per-section extras.
//
// "Manage callers" only renders for admins. The check is cosmetic (middleware
// and the API both enforce it for real); hiding a button nobody can use is
// just not showing a caller a door that is locked.

const TABS: SectionTab[] = [
  { href: "/calls", label: "Today", exact: true },
  { href: "/calls/list", label: "Dial list" },
  { href: "/calls/callbacks", label: "Callbacks" },
  { href: "/calls/booked", label: "Booked" },
  { href: "/calls/schedule", label: "Schedule" },
  { href: "/calls/sources", label: "Sources" },
];

export default function CallsLayout({ children }: { children: React.ReactNode }) {
  const [isAdmin, setIsAdmin] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/calls/leads?status=all&limit=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d?.me) return;
        setIsAdmin(Boolean(d.me.isAdmin));
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
          {isAdmin && (
            <a href="/calls/team" style={sectionBtn}>
              Manage callers
            </a>
          )}
        </>
      }
    >
      {children}
    </SectionChrome>
  );
}
