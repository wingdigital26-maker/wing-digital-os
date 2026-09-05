"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { CSSProperties, ReactNode } from "react";

// One header for every standalone routed section (Call Room, Sequences,
// Automations). Before this each layout drew its own logo and title, so the
// three screens read as three different apps. Now they share: the W logo home,
// the product name, a section switcher that is identical everywhere, the
// per-section extras on the right, Sign out, and the section's own tab strip
// underneath.
//
// Sections that live inside the OS shell (Calendar, CRM, Agents) are not
// listed in the switcher because "/" is the only way in; Home covers them.

export type SectionTab = { href: string; label: string; exact?: boolean };

const SECTIONS: { href: string; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/calls", label: "Call Room" },
  { href: "/sequences", label: "Sequences" },
  { href: "/email", label: "Email" },
  { href: "/automations", label: "Automations" },
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
