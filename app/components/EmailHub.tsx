"use client";
import { useState } from "react";
import dynamic from "next/dynamic";

const EmailFeed = dynamic(() => import("./email/EmailFeed"), { ssr: false });
const ReplyInboxBoard = dynamic(() => import("./ReplyInboxBoard"), { ssr: false });
const SendQueueBoard = dynamic(() => import("./SendQueueBoard"), { ssr: false });
const DeliverabilityBoard = dynamic(() => import("./DeliverabilityBoard"), { ssr: false });
const Composer = dynamic(() => import("./email/Composer"), { ssr: false });

// ───────────────────────────────────────────────────────────────────────────
// EmailHub — the CRM's front door.
//
// 2026-09-22, Jack: "Primarily work on the emailing because that's what the
// majority of our CRM is going to be." So the feed of everything going out is
// not one pill among equals any more, it is what the tab opens on and what
// gets the room. The other four are the jobs you go and do: read the replies,
// check the QA on what is about to send, check whether the mail is landing,
// write one.
//
// Texting used to live behind one of these pills. It was removed, not hidden.
//
// Boards mount lazily and stay mounted once visited, the same keep-alive the
// shell uses, so switching back to the feed does not re-open its live stream.
// ───────────────────────────────────────────────────────────────────────────
const VIEWS = [
  { id: "feed", label: "All email", blurb: "Every email going out and coming back, newest first." },
  { id: "replies", label: "Replies", blurb: "Everyone who wrote back, hottest first." },
  { id: "queue", label: "Going out next", blurb: "What the automated sender will send, and the QA on it." },
  { id: "health", label: "Deliverability", blurb: "Whether the mail is landing in inboxes at all." },
  { id: "compose", label: "Compose", blurb: "Write one. Sending stays gated on the server." },
] as const;

type ViewId = (typeof VIEWS)[number]["id"];

function isViewId(v: string | null): v is ViewId {
  return VIEWS.some((x) => x.id === v);
}

export default function EmailHub() {
  const [active, setActive] = useState<ViewId>(() => {
    try {
      const saved = window.localStorage.getItem("wingos.emailhub.tab");
      if (isViewId(saved)) return saved;
    } catch { /* private mode, fall through to the default */ }
    return "feed";
  });
  const [visited, setVisited] = useState<Set<ViewId>>(() => new Set<ViewId>([active]));

  function go(id: ViewId) {
    setActive(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
    try { window.localStorage.setItem("wingos.emailhub.tab", id); } catch { /* not worth failing over */ }
  }

  const blurb = VIEWS.find((v) => v.id === active)?.blurb ?? "";

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ marginBottom: 16, paddingBottom: 14, borderBottom: "1px solid var(--border)" }}>
        <div style={{
          fontSize: 12, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase",
          color: "var(--accent)", marginBottom: 6,
        }}>
          CRM
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)", margin: "0 0 6px" }}>
          Email
        </h2>
        <p style={{ fontSize: 13.5, color: "var(--text-secondary)", margin: 0, maxWidth: 620, lineHeight: 1.5 }}>
          {blurb}
        </p>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => go(v.id)}
            style={{
              padding: "7px 16px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: active === v.id ? 700 : 500,
              border: active === v.id ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: active === v.id ? "var(--accent-glow)" : "transparent",
              color: active === v.id ? "var(--accent)" : "var(--text-secondary)",
              transition: "all 0.15s",
            }}
          >
            {v.label}
          </button>
        ))}
      </div>

      {visited.has("feed") && <div style={{ display: active === "feed" ? "block" : "none" }}><EmailFeed /></div>}
      {visited.has("replies") && <div style={{ display: active === "replies" ? "block" : "none" }}><ReplyInboxBoard /></div>}
      {visited.has("queue") && <div style={{ display: active === "queue" ? "block" : "none" }}><SendQueueBoard /></div>}
      {visited.has("health") && <div style={{ display: active === "health" ? "block" : "none" }}><DeliverabilityBoard /></div>}
      {visited.has("compose") && <div style={{ display: active === "compose" ? "block" : "none" }}><Composer /></div>}
    </div>
  );
}
