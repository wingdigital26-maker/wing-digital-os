"use client";
import { useState } from "react";
import dynamic from "next/dynamic";

const MessagingBoard = dynamic(() => import("./MessagingBoard"), { ssr: false });
const MessagesBoard = dynamic(() => import("./MessagesBoard"), { ssr: false });
const DeliverabilityBoard = dynamic(() => import("./DeliverabilityBoard"), { ssr: false });

// One Email tab instead of three. Jack asked for fewer CRM tabs (2026-09-01):
// the automated-send queue, the sent-message ledger, and email health are all
// "email", so they live behind one nav entry with internal pills. The three
// boards are mounted lazily and kept mounted once visited, same keep-alive
// idea as the shell.
const PILLS = [
  { id: "queue", label: "Going out next" },
  { id: "ledger", label: "Sent and received" },
  { id: "health", label: "Email health" },
] as const;

type PillId = (typeof PILLS)[number]["id"];

export default function EmailHub() {
  const [active, setActive] = useState<PillId>(() => {
    try {
      const saved = window.localStorage.getItem("wingos.emailhub.tab");
      if (saved === "queue" || saved === "ledger" || saved === "health") return saved;
    } catch {}
    return "queue";
  });
  const [visited, setVisited] = useState<Set<PillId>>(() => new Set<PillId>([active] as PillId[]));

  function go(id: PillId) {
    setActive(id);
    setVisited(v => (v.has(id) ? v : new Set(v).add(id)));
    try { window.localStorage.setItem("wingos.emailhub.tab", id); } catch {}
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 18 }}>
        {PILLS.map(p => (
          <button
            key={p.id}
            onClick={() => go(p.id)}
            style={{
              padding: "7px 16px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
              fontWeight: active === p.id ? 700 : 500,
              border: active === p.id ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: active === p.id ? "var(--accent-glow)" : "transparent",
              color: active === p.id ? "var(--accent)" : "var(--text-secondary)",
              transition: "all 0.15s",
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      {visited.has("queue") && <div style={{ display: active === "queue" ? "block" : "none" }}><MessagingBoard /></div>}
      {visited.has("ledger") && <div style={{ display: active === "ledger" ? "block" : "none" }}><MessagesBoard /></div>}
      {visited.has("health") && <div style={{ display: active === "health" ? "block" : "none" }}><DeliverabilityBoard /></div>}
    </div>
  );
}
