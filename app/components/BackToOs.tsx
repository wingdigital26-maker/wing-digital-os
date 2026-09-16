import Link from "next/link";

// A consistent "back to the OS home" link for standalone routed pages that do
// not use SectionChrome (Dashboards, Activity, Mission). Without it, opening one
// of these pages is a dead end -- there is no way back to the OS shell short of
// editing the URL. Added 2026-09-16 (Jack).
export default function BackToOs({ style }: { style?: React.CSSProperties }) {
  return (
    <Link
      href="/"
      aria-label="Back to the Wing Digital OS home"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        padding: "7px 13px",
        borderRadius: 999,
        border: "1px solid var(--border)",
        background: "var(--bg-card)",
        color: "var(--text-secondary)",
        fontSize: 12.5,
        fontWeight: 600,
        textDecoration: "none",
        width: "fit-content",
        ...style,
      }}
    >
      <span aria-hidden="true">←</span> Wing OS
    </Link>
  );
}
