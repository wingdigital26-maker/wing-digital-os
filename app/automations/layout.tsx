"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Shared chrome for the Automations section, copying the /sequences layout:
// one TABS const, one navBtn style, sticky translucent header, and a Back to
// the OS button because this is a routed page, not an in-shell view.

const TABS = [
  { href: "/automations", label: "Workflows", exact: true },
  { href: "/automations/forms", label: "Forms" },
  { href: "/automations/tasks", label: "Tasks" },
  { href: "/automations/phone", label: "Phone numbers" },
  { href: "/automations/runs", label: "Activity" },
];

export default function AutomationsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const active = (t: (typeof TABS)[number]) =>
    t.exact
      ? pathname === t.href || /^\/automations\/(?!forms|tasks|phone|runs)[^/]+$/.test(pathname)
      : pathname.startsWith(t.href);

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
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 9, textDecoration: "none", color: "inherit" }}>
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
            <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: -0.3 }}>Automations</span>
          </Link>

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Link href="/" style={{ ...navBtn, border: "1px solid var(--accent)", color: "var(--accent)" }}>
              &larr; Back to the OS
            </Link>
            <a href="/api/logout" style={navBtn}>
              Sign out
            </a>
          </div>
        </div>

        <nav
          style={{
            maxWidth: 1180,
            margin: "0 auto",
            padding: "10px 20px 0",
            display: "flex",
            gap: 4,
            overflowX: "auto",
          }}
        >
          {TABS.map((t) => {
            const on = active(t);
            return (
              <Link
                key={t.href}
                href={t.href}
                style={{
                  padding: "9px 14px 11px",
                  fontSize: 13.5,
                  fontWeight: on ? 700 : 500,
                  color: on ? "var(--text-primary)" : "var(--text-muted)",
                  textDecoration: "none",
                  borderBottom: `2px solid ${on ? "#22d3ee" : "transparent"}`,
                  whiteSpace: "nowrap",
                }}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
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
