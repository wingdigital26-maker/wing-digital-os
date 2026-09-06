"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// One header for every standalone routed section (Call Room, Sequences,
// Email, Automations). Before this each layout drew its own logo and title, so
// the screens read as different apps. Now they share: the W logo home, the
// product name, a section switcher that is identical everywhere, an "All
// sections" menu mirroring the OS shell's full nav, the per-section extras on
// the right, Sign out, and the section's own tab strip underneath.
//
// The switcher pills are the ROUTED sections only. Everything that lives
// inside the OS shell (Clients, CRM, Marketing, Calendar, Agents, Intel) is in
// the "All sections" menu, so someone on /sequences can reach the CRM without
// going Home first. Those links use "/#view=<subId>": the shell's os:navigate
// CustomEvent only works once "/" is mounted, so a plain link can't use it —
// page.tsx reads the hash on mount instead (see SHELL_GROUPS below).

export type SectionTab = { href: string; label: string; exact?: boolean };

const SECTIONS: { href: string; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/calls", label: "Call Room" },
  { href: "/sequences", label: "Sequences" },
  { href: "/email", label: "Email" },
  { href: "/automations", label: "Automations" },
];

// Mirror of the shell's NAV in app/page.tsx (groups that live inside "/").
// Each sub links to "/#view=<subId>"; the shell honors the hash on mount and
// plain "/" still works as before. Keep the ids in sync with page.tsx NAV.
const SHELL_GROUPS: { label: string; subs: { id: string; label: string }[] }[] = [
  { label: "Command Center", subs: [{ id: "command", label: "Overview" }, { id: "personal", label: "Personal" }] },
  {
    label: "Clients",
    subs: [
      { id: "clients", label: "Clients" },
      { id: "potential", label: "Potential clients" },
      { id: "sonar", label: "Sonar Leads" },
      { id: "storms", label: "Storm Response" },
    ],
  },
  {
    label: "CRM",
    subs: [
      { id: "crm", label: "Everything" },
      { id: "email", label: "Email" },
      { id: "text", label: "Text" },
      { id: "replies", label: "Reply Inbox" },
    ],
  },
  {
    label: "Marketing",
    subs: [
      { id: "social", label: "Social" },
      { id: "reviews", label: "Reviews" },
      { id: "customers", label: "Customers" },
    ],
  },
  { label: "Calendar", subs: [{ id: "calendar", label: "Calendar" }] },
  { label: "Agents", subs: [{ id: "agent", label: "Mission Control" }] },
  {
    label: "Intel",
    subs: [
      { id: "knowledge", label: "Knowledge Base" },
      { id: "competitors", label: "Competitor Intel" },
    ],
  },
];

type Props = {
  /** Bold section name shown next to the logo, e.g. "Call Room". */
  title: string;
  /** The section's own tab strip, rendered under the header. */
  tabs: SectionTab[];
  /** Override for which tab is lit. Default: exact match when `exact`, else
   *  pathname.startsWith(href). Sections with catch-all detail routes pass
   *  their own regex here. */
  isTabActive?: (tab: SectionTab, pathname: string) => boolean;
  /** Per-section header extras (a signed-in email, an admin button). Rendered
   *  to the left of Sign out. */
  extras?: ReactNode;
  children: ReactNode;
};

function defaultActive(t: SectionTab, pathname: string): boolean {
  return t.exact ? pathname === t.href : pathname.startsWith(t.href);
}

/** "All sections ▾" — the OS shell's full nav as a dropdown, so routed pages
 *  present the same mental model as "/". Plain button + absolutely positioned
 *  panel; closes on outside click and Escape. Works at 375px (panel is capped
 *  to the viewport and scrolls). */
function AllSectionsMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="sc-menu-root" ref={rootRef}>
      <button
        type="button"
        className="sc-btn sc-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        All sections <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.8 }}>▾</span>
      </button>
      {open && (
        <div className="sc-menu" role="menu" aria-label="All OS sections">
          <a href="/" className="sc-menu-home" role="menuitem" onClick={() => setOpen(false)}>
            ← Back to OS home
          </a>
          {SHELL_GROUPS.map(g => (
            <div key={g.label} className="sc-menu-group">
              <div className="sc-menu-label">{g.label}</div>
              {g.subs.map(s => (
                // Full <a> navigation on purpose: "/" is not mounted here, so
                // os:navigate can't be dispatched — the shell reads the hash.
                <a
                  key={s.id}
                  href={`/#view=${s.id}`}
                  className="sc-menu-item"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                >
                  {s.label}
                </a>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SectionChrome({ title, tabs, isTabActive, extras, children }: Props) {
  const pathname = usePathname() ?? "/";
  const tabOn = (t: SectionTab) => (isTabActive ?? defaultActive)(t, pathname);
  const sectionOn = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    // page-scroll must stay on this root: a body scroll-lock once froze every
    // standalone page and this class is what exempts them.
    <div className="page-scroll" style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      <style>{`
        .sc-top {
          max-width: 1180px; margin: 0 auto; padding: 12px 20px 0;
          display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
        }
        .sc-brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; min-width: 0; }
        .sc-brand-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
        .sc-brand-os { font-size: 10.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); }
        .sc-brand-title { font-size: 15px; font-weight: 800; letter-spacing: -0.3px; white-space: nowrap; }
        .sc-switch {
          display: flex; align-items: center; gap: 4px; flex: 1 1 auto; justify-content: center;
          overflow-x: auto; scrollbar-width: none; min-width: 0; padding: 2px 0;
        }
        .sc-switch::-webkit-scrollbar { display: none; }
        .sc-pill {
          padding: 6px 12px; border-radius: 999px; font-size: 12.5px; font-weight: 600;
          text-decoration: none; white-space: nowrap; color: var(--text-muted);
          border: 1px solid transparent;
        }
        .sc-pill:hover { color: var(--text-primary); background: var(--bg-hover); }
        .sc-pill[aria-current="page"] {
          color: var(--accent); border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 10%, transparent);
        }
        .sc-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .sc-btn {
          padding: 7px 13px; border-radius: 9px; border: 1px solid var(--border);
          background: var(--bg-hover); color: var(--text-primary);
          font-size: 12.5px; font-weight: 600; text-decoration: none; white-space: nowrap;
        }
        .sc-menu-root { position: relative; }
        .sc-menu-btn { cursor: pointer; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12.5px; font-weight: 600; }
        .sc-menu {
          position: absolute; top: calc(100% + 6px); right: 0; z-index: 40;
          min-width: 230px; max-width: calc(100vw - 24px);
          max-height: min(70vh, 480px); overflow-y: auto;
          background: var(--bg-primary); border: 1px solid var(--border); border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.35);
          padding: 8px;
        }
        .sc-menu-home {
          display: block; padding: 8px 10px; margin-bottom: 4px; border-radius: 8px;
          font-size: 12.5px; font-weight: 700; text-decoration: none; color: var(--accent);
        }
        .sc-menu-home:hover { background: var(--bg-hover); }
        .sc-menu-group { padding: 4px 0; border-top: 1px solid var(--border); }
        .sc-menu-label {
          padding: 6px 10px 2px; font-size: 10px; font-weight: 700; letter-spacing: 0.07em;
          text-transform: uppercase; color: var(--text-muted);
        }
        .sc-menu-item {
          display: block; padding: 7px 10px; border-radius: 8px;
          font-size: 13px; font-weight: 500; text-decoration: none; color: var(--text-primary);
        }
        .sc-menu-item:hover { background: var(--bg-hover); color: var(--accent); }
        .sc-email { font-size: 12px; color: var(--text-muted); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .sc-tabs-wrap { position: relative; }
        .sc-tabs {
          max-width: 1180px; margin: 0 auto; padding: 8px 20px 0;
          display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
        }
        .sc-tabs::-webkit-scrollbar { display: none; }
        .sc-tab {
          padding: 12px 16px 13px; font-size: 14px; text-decoration: none; white-space: nowrap;
          color: var(--text-muted); font-weight: 500; border-bottom: 2px solid transparent;
        }
        .sc-tab[aria-current="page"] { color: var(--text-primary); font-weight: 700; border-bottom-color: var(--accent); }
        .sc-tabs-wrap::after {
          content: ""; position: absolute; top: 0; right: 0; bottom: 0; width: 34px; pointer-events: none;
          background: linear-gradient(to left, var(--bg-primary), transparent);
        }
        @media (max-width: 760px) {
          /* Phone: brand left, actions right, the switcher drops to its own
             full-width row and scrolls sideways instead of wrapping. */
          .sc-switch { order: 3; flex-basis: 100%; justify-content: flex-start; }
          .sc-actions { margin-left: auto; }
          .sc-email { display: none; }
          .sc-tab { padding: 11px 10px 12px; font-size: 13px; }
          /* The panel hangs from the actions row on the right; cap it to the
             viewport so it never clips off-screen at 375px. */
          .sc-menu { right: 0; }
        }
      `}</style>

      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          background: "color-mix(in srgb, var(--bg-primary) 88%, transparent)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div className="sc-top">
          <Link href="/" className="sc-brand" aria-label="Wing Digital OS home">
            <span
              style={{
                width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                background: "linear-gradient(135deg,#22d3ee,#0e7490)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, fontWeight: 800, color: "#fff",
              }}
            >
              W
            </span>
            <span className="sc-brand-text">
              <span className="sc-brand-os">Wing Digital OS</span>
              <span className="sc-brand-title">{title}</span>
            </span>
          </Link>

          <nav className="sc-switch" aria-label="Sections">
            {SECTIONS.map((s) => (
              <Link
                key={s.href}
                href={s.href}
                className="sc-pill"
                aria-current={sectionOn(s.href) ? "page" : undefined}
              >
                {s.label}
              </Link>
            ))}
          </nav>

          <div className="sc-actions">
            {extras}
            <AllSectionsMenu />
            <a href="/api/logout" className="sc-btn">
              Sign out
            </a>
          </div>
        </div>

        <div className="sc-tabs-wrap">
          <nav className="sc-tabs" aria-label={`${title} pages`}>
            {tabs.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="sc-tab"
                aria-current={tabOn(t) ? "page" : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 20px 80px" }}>{children}</main>
    </div>
  );
}

/** Button style for per-section extras, so they match Sign out exactly. */
export const sectionBtn: CSSProperties = {
  padding: "7px 13px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  fontWeight: 600,
  textDecoration: "none",
  whiteSpace: "nowrap",
};
