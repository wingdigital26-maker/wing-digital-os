"use client";

// ───────────────────────────────────────────────────────────────────────────
// New-video notification — shows on the home screen when the creator intel
// watcher has picked up videos Jack hasn't looked at yet (intel_items rows
// still at status 'new'). Clicking it opens the Intel section; dismissing it
// remembers the newest item id in localStorage so the same videos don't nag
// on every login — it reappears only when a NEWER video lands.
// ───────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { goToView } from "./StartHere";

const SEEN_KEY = "wingos.intelSeenMaxId";

type IntelItem = { id: number; source_handle: string; title: string };

function readSeen(): number {
  try { return Number(window.localStorage.getItem(SEEN_KEY) || 0); } catch { return 0; }
}
function writeSeen(id: number) {
  try { window.localStorage.setItem(SEEN_KEY, String(id)); } catch { /* fine */ }
}

export default function NewIntelBanner() {
  const [items, setItems] = useState<IntelItem[] | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/intel?status=new", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => { if (alive) setItems(j.items ?? []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, []);

  if (dismissed || !items || items.length === 0) return null;
  const maxId = Math.max(...items.map((i) => i.id));
  if (maxId <= readSeen()) return null;

  const creators = [...new Set(items.map((i) => i.source_handle))];

  return (
    <section
      role="status"
      style={{
        display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        border: "1px solid var(--border)", borderLeft: "3px solid var(--accent)",
        borderRadius: 12, padding: "10px 14px", marginBottom: 14,
        background: "var(--bg-card)",
      }}
    >
      <span aria-hidden style={{ fontSize: 16 }}>📺</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>
          {items.length} new video{items.length === 1 ? "" : "s"} from your watched creators
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 2 }}>
          {creators.join(", ")} — latest: “{items[0]?.title}”
        </div>
      </div>
      <button
        type="button"
        onClick={() => goToView("competitors")}
        style={{
          border: "1px solid var(--accent)", background: "none", color: "var(--accent)",
          borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}
      >
        Open Intel
      </button>
      <button
        type="button"
        onClick={() => { writeSeen(maxId); setDismissed(true); }}
        aria-label="Dismiss"
        style={{
          border: "none", background: "none", color: "var(--text-muted)",
          fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: 0, minHeight: 0,
        }}
      >
        Dismiss
      </button>
    </section>
  );
}
