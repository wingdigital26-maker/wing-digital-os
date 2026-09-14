import Link from "next/link";
import EmailComposer from "./EmailComposer";

// /email — the staff email landing. Two clearly separated manual jobs live in
// the composer below:
//  * Send now (1:1): an instant SMTP send through /api/email/send.
//  * Add to cold campaign: enqueue a prospect into the Instantly cold
//    campaign through /api/email/campaign (Instantly sends on its own
//    schedule, NOT immediately).
// Both are manual, one-at-a-time actions taken by a person on this page. The
// automated scheduled-send lanes are a separate thing and are not running, so
// nothing on this page fires on its own. The page is a thin server shell; the
// form and fetch logic live in the client composer so the honest,
// non-optimistic states run in the browser.
export const metadata = {
  title: "Email",
  description: "Send a 1:1 email or add a prospect to the cold campaign.",
};

const surfaces: { href: string; title: string; body: string }[] = [
  {
    href: "/sequences",
    title: "Sequences",
    body: "Build multi-step email cadences and activate or pause them. Sending is done by a separate machine, never from here.",
  },
  {
    href: "/sequences/people",
    title: "People on sequences",
    body: "Everyone currently enrolled, which email they get next, and one-click pause, resume or remove.",
  },
  {
    href: "/#view=email",
    title: "CRM · Email",
    body: "Sent mail, the message ledger and deliverability health for the account.",
  },
];

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
};

export default function EmailPage() {
  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "28px 20px 60px" }}>
      <header style={{ marginBottom: 22 }}>
        <h1 style={{ margin: 0, fontFamily: "'Space Grotesk',sans-serif", fontSize: 24, fontWeight: 700 }}>
          Email
        </h1>
        <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.55 }}>
          Everything here is a manual action you take one at a time. Nothing on this page sends on its own.
        </p>
      </header>

      <EmailComposer embedded />

      <section style={{ marginTop: 34 }}>
        <h2 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "var(--text-secondary)" }}>
          More email surfaces
        </h2>
        <div style={{ display: "grid", gap: 10 }}>
          {surfaces.map((s) => (
            <Link
              key={s.href}
              href={s.href}
              style={{ ...card, display: "block", textDecoration: "none", color: "inherit" }}
            >
              <div style={{ fontWeight: 700, fontSize: 14.5, color: "var(--accent)" }}>{s.title}</div>
              <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3, lineHeight: 1.5 }}>
                {s.body}
              </div>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
