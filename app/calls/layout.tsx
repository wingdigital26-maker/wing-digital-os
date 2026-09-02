"use client";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Shared chrome for the whole Outbound section. Owned by the main session --
// every screen under /calls hangs off this nav, so it must have exactly one
// author.
//
// "Manage callers" only renders for admins. The check is cosmetic (middleware
// and the API both enforce it for real); hiding a button nobody can use is
// just not showing a caller a door that is locked.

const TABS = [
  { href: "/calls", label: "Today", exact: true },
  { href: "/calls/list", label: "Dial list" },
  { href: "/calls/callbacks", label: "Callbacks" },
  { href: "/calls/booked", label: "Booked" },
  { href: "/calls/schedule", label: "Schedule" },
  { href: "/calls/sources", label: "Sources" },
];

export default function CallsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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

  const active = (t: (typeof TABS)[number]) =>
    t.exact ? pathname === t.href : pathname.startsWith(t.href);

  return (
    <div className="page-scroll" style={{ minHeight: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
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
        <div
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            padding: "14px 20px 0",
            display: "flex",
            alignItems: "center",
            gap: 14,
            flexWrap: "wrap",
          }}
        >
          <a
            href="/"
            style={{
              display: "flex", alignItems: "center", gap: 9,
              textDecoration: "none", color: "inherit",
            }}
          >
            <span
              style={{
                width: 30, height: 30, borderRadius: 9,
                background: "linear-gradient(135deg,#22d3ee,#0e7490)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 14, fontWeight: 800, color: "#fff",
              }}
            >
              W
            </span>
            <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: -0.3 }}>Outbound</span>
          </a>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            {email && (
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{email}</span>
            )}
            {isAdmin && (
              <a href="/calls/team" style={navBtn}>
                Manage callers
              </a>
            )}
            <a href="/api/logout" style={navBtn}>
              Sign out
            </a>
          </div>
        </div>

        <style>{`
          .calls-tabs-wrap { position: relative; }
          .calls-tabs {
            max-width: 1180px;
            margin: 0 auto;
            padding: 10px 20px 0;
            display: flex;
            gap: 4px;
            overflow-x: auto;
            scrollbar-width: none;
          }
          .calls-tabs::-webkit-scrollbar { display: none; }
          .calls-tab { padding: 12px 16px 13px; }
          .calls-tabs-wrap::after {
            content: "";
            position: absolute;
            top: 0; right: 0; bottom: 0;
            width: 34px;
            pointer-events: none;
            background: linear-gradient(to left, var(--bg-primary), transparent);
          }
          @media (max-width: 480px) {
            .calls-tab { padding: 11px 10px 12px; font-size: 13px !important; }
          }
        `}</style>
        <div className="calls-tabs-wrap">
          <nav className="calls-tabs">
            {TABS.map((t) => {
              const on = active(t);
              return (
                <a
                  key={t.href}
                  href={t.href}
                  className="calls-tab"
                  style={{
                    fontSize: 14,
                    fontWeight: on ? 700 : 500,
                    color: on ? "var(--text-primary)" : "var(--text-muted)",
                    textDecoration: "none",
                    borderBottom: `2px solid ${on ? "#22d3ee" : "transparent"}`,
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.label}
                </a>
              );
            })}
          </nav>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 20px 80px" }}>{children}</main>
    </div>
  );
}

const navBtn: React.CSSProperties = {
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
