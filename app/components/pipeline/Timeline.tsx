"use client";
import { useCallback, useEffect, useState } from "react";
import { Activity, whenText } from "./types";

// Activity timeline for one contact or one deal.
//
// The pipeline API contract documents POST /api/pipeline/activities but no read
// route, so this asks for one and reports honestly if it is not there yet. An
// unreachable timeline says it is unreachable; it never renders as "no activity
// yet", because those two things mean very different things to someone deciding
// whether a lead has been called.

export default function Timeline({
  contactId,
  dealId,
  reloadKey,
}: {
  contactId: number | null;
  dealId?: number | null;
  reloadKey: number;
}) {
  const [rows, setRows] = useState<Activity[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams();
      if (contactId !== null) qs.set("contact_id", String(contactId));
      if (dealId !== null && dealId !== undefined) qs.set("deal_id", String(dealId));
      const res = await fetch(`/api/pipeline/activities?${qs.toString()}`);
      if (!res.ok) {
        setErr(`Timeline unavailable (HTTP ${res.status})`);
        setRows(null);
        return;
      }
      const data = await res.json().catch(() => null);
      const list = data && Array.isArray(data.activities) ? (data.activities as Activity[]) : null;
      if (data?.error) { setErr(String(data.error)); setRows(null); return; }
      if (!list) { setErr("Timeline unavailable: the API returned no activity list."); setRows(null); return; }
      setRows(list);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, [contactId, dealId]);

  // Kicked off on a task boundary so the first paint is not a cascading render.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load, reloadKey]);

  if (loading) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading activity</div>;
  }
  if (err) {
    return (
      <div style={{
        fontSize: 13, color: "var(--red)", border: "1px solid var(--border)",
        borderRadius: 8, padding: 10,
      }}>
        {err}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No activity logged yet</div>;
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
      {rows.map((a) => (
        <li
          key={a.id}
          style={{
            borderLeft: "2px solid var(--border)", paddingLeft: 10,
          }}
        >
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
            <span style={{
              fontSize: 12, fontWeight: 700, textTransform: "capitalize",
              color: "var(--accent)",
            }}>
              {a.kind}
            </span>
            {a.outcome && (
              <span style={{ fontSize: 12, color: "var(--orange)" }}>{a.outcome}</span>
            )}
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              {whenText(a.occurred_at)}
            </span>
            {a.source && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>via {a.source}</span>
            )}
          </div>
          <div style={{ fontSize: 13, marginTop: 2, whiteSpace: "pre-wrap" }}>
            {a.body ? a.body : <span style={{ color: "var(--text-muted)" }}>no note recorded</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
