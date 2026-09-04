"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Activity, TIMELINE_FILTERS, TimelineGroup, TimelineItem, whenText,
} from "./types";

// ── Unified timeline ──────────────────────────────────────────────────────
// Renders the merged list the contact route builds (activities, messages,
// form submissions, bookings, automation runs and triggers). Filter pills
// narrow by group; "All" shows everything including forms and bookings.
// An empty list says nothing has happened; a load failure is the caller's to
// show, since it knows which lists actually failed.

const TONE: Record<TimelineItem["tone"], string> = {
  ok: "var(--green)",
  warn: "var(--orange)",
  bad: "var(--red)",
  muted: "var(--text-muted)",
  plain: "var(--accent)",
};

const KIND_WORD: Record<TimelineItem["kind"], string> = {
  message: "Message",
  automation: "Automation",
  trigger: "Trigger",
  note: "Note",
  call: "Call",
  meeting: "Meeting",
  email_log: "Email",
  sms_log: "Text",
  stage: "Stage",
  form: "Form",
  booking: "Booking",
};

const PAGE = 30;

export function UnifiedTimeline({
  items,
  capped,
  filter,
  onFilter,
}: {
  items: TimelineItem[];
  // True when at least one source list hit its server cap, so the reader
  // knows the oldest history may be missing rather than assuming this is all.
  capped: boolean;
  filter: "all" | TimelineGroup;
  onFilter: (f: "all" | TimelineGroup) => void;
}) {
  const [shown, setShown] = useState(PAGE);
  const visible = filter === "all" ? items : items.filter((i) => i.group === filter);
  const page = visible.slice(0, shown);

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {TIMELINE_FILTERS.map((f) => {
          const on = f.key === filter;
          return (
            <button
              key={f.key}
              type="button"
              onClick={() => { onFilter(f.key); setShown(PAGE); }}
              style={{
                padding: "6px 10px", borderRadius: 999, fontSize: 12, cursor: "pointer",
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                color: on ? "var(--accent)" : "var(--text-muted)", background: "transparent",
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {items.length === 0
            ? "Nothing has happened with this contact yet."
            : "Nothing in this filter. Forms and bookings show under All."}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
          {page.map((it) => (
            <li key={it.id} style={{ borderLeft: `2px solid ${TONE[it.tone]}`, paddingLeft: 10 }}>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: TONE[it.tone] }}>
                  {KIND_WORD[it.kind]}
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{whenText(it.at)}</span>
              </div>
              <div style={{ fontSize: 13, marginTop: 2, overflowWrap: "anywhere" }}>{it.line}</div>
              {it.detail && (
                <div style={{
                  fontSize: 12, marginTop: 3, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
                  color: "var(--text-muted)",
                }}>
                  {it.detail}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {visible.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          style={{
            justifySelf: "start", padding: "6px 12px", borderRadius: 8, fontSize: 12,
            cursor: "pointer", border: "1px solid var(--border)", background: "transparent",
            color: "var(--text-muted)",
          }}
        >
          Load more ({visible.length - shown} more)
        </button>
      )}
      {capped && visible.length <= shown && (
        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Showing the most recent history only. Older items exist but were not loaded.
        </div>
      )}
    </div>
  );
}

// ── Legacy activities-only timeline (used by DealDetail) ──────────────────

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
