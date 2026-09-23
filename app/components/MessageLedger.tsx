"use client";
import dynamic from "next/dynamic";

// ───────────────────────────────────────────────────────────────────────────
// MessageLedger — kept as the name the rest of the app imports, now email only.
//
// History, so nobody re-adds what was deliberately taken out:
//   * 2026-09-05 renamed from MessagesBoard (a ledger, not a send queue).
//   * 2026-09-22 the CRM stopped carrying texting at all. Jack: email is what
//     the CRM is going to be. Every SMS branch this file had — the channel
//     pills, the Twilio status panel, the Twilio setup checklist, the per-
//     thread reply box that posted to /api/sms/send — is gone, not hidden.
//     Do not restore them here; texting is not part of this product.
//
// What is left is a thin alias onto the real surface, app/components/email/
// EmailFeed.tsx, which reads every lane at once instead of only the `messages`
// table this file used to poll. Keeping the alias means app/page.tsx and the
// email hub keep working while the nav settles.
// ───────────────────────────────────────────────────────────────────────────

const EmailFeed = dynamic(() => import("./email/EmailFeed"), { ssr: false });

// `channel` survives only so existing call sites type-check while the nav is
// being rewritten. There is no sms surface behind it any more: a caller that
// still asks for texts gets told plainly, and gets nothing else.
export default function MessageLedger({ channel }: { channel?: "sms" | "email" } = {}) {
  if (channel === "sms") {
    return (
      <div style={{
        border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)",
        padding: "12px 14px", fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)",
      }}>
        Texting is no longer part of the CRM. Email is the only channel this ledger serves.
      </div>
    );
  }
  return <EmailFeed />;
}
