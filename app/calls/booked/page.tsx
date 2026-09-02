"use client";
import { useCallback, useEffect, useState } from "react";
import { displayName } from "../names";

// The wins board. Every lead at status='booked', most recent booking first,
// with the notes from the call that booked it.
//
// Deliberately no revenue, no close-probability, no projections: the database
// holds none of that, so this screen shows none of it. A count and the real
// notes are the whole story.

type Lead = {
  id: string;
  company: string;
  contact_name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  vertical: string | null;
  status: string;
  last_called_at: string | null;
  call_count: number;
  next_action_at: string | null;
  excluded?: boolean | null;
};

type Activity = {
  id: number;
  user_email: string | null;
  outcome: string;
  notes: string | null;
  created_at: string;
};

type Row = { lead: Lead; booking: Activity | null };

export default function Booked() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/calls/leads?status=booked&limit=500", { cache: "no-store" });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      setError(d.error ?? "Could not load booked calls");
      setLoading(false);
      return;
    }
    const d = await r.json();
    const leads: Lead[] = (d.leads ?? []).filter((l: Lead) => !l.excluded);

    // The booking itself lives in call_activity, so pull each lead's history and
    // keep the most recent 'booked' row -- that is who booked it and when.
    const built = await Promise.all(
      leads.map(async (lead): Promise<Row> => {
        const h = await fetch(`/api/calls/disposition?leadId=${lead.id}`, { cache: "no-store" });
        if (!h.ok) return { lead, booking: null };
        const act: Activity[] = (await h.json()).activity ?? [];
        const booking =
          act
            .filter((a) => a.outcome === "booked")
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
        return { lead, booking };
      })
    );

    built.sort((a, b) => {
      const at = Date.parse(a.booking?.created_at ?? a.lead.last_called_at ?? "") || 0;
      const bt = Date.parse(b.booking?.created_at ?? b.lead.last_called_at ?? "") || 0;
      return bt - at;
    });

    setRows(built);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.5 }}>
            {loading ? "Booked" : `${rows.length} booked`}
          </h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            {loading
              ? "Loading booked calls…"
              : rows.length === 0
                ? "No calls on the board yet."
                : "Every lead that said yes to a call, newest first."}
          </p>
        </div>
      </div>

      {error && (
        <div style={{
          marginTop: 14, padding: "11px 14px", borderRadius: 10, border: "1px solid",
          fontSize: 13, fontWeight: 600,
          background: "rgba(239,68,68,0.12)", borderColor: "rgba(239,68,68,0.4)", color: "#f87171",
        }}>
          {error}
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div style={{ ...card, textAlign: "center", padding: 44, color: "var(--text-muted)", marginTop: 18 }}>
          <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
            No calls booked yet
          </p>
          <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>
            The first time someone logs “Booked a call” on the dial list, it shows up here with
            who booked it and what was said.
          </p>
        </div>
      )}

      <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
        {rows.map(({ lead, booking }) => (
          <div
            key={lead.id}
            style={{
              ...card,
              borderLeft: "4px solid #22c55e",
              display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 300px", minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15.5, fontWeight: 700 }}>{lead.company}</span>
                <span style={{ ...pill, borderColor: "#22c55e", color: "#4ade80" }}>Booked</span>
              </div>

              <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
                {[lead.contact_name, lead.title, lead.city, lead.vertical].filter(Boolean).join(" · ")
                  || "No named contact"}
              </p>

              <p style={{ fontSize: 12.5, color: "#4ade80", marginTop: 6, fontWeight: 600 }}>
                {booking
                  ? `Booked by ${displayName(booking.user_email)} · ${new Date(booking.created_at).toLocaleString()}`
                  : lead.last_called_at
                    ? `Marked booked ${new Date(lead.last_called_at).toLocaleString()} · caller not recorded`
                    : "No booking activity recorded"}
              </p>

              {lead.next_action_at && (
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                  Meeting set for {new Date(lead.next_action_at).toLocaleString()}
                </p>
              )}

              {booking?.notes ? (
                <div style={{
                  marginTop: 9, padding: 11, borderRadius: 10,
                  background: "rgba(34,197,94,0.07)", border: "1px solid rgba(34,197,94,0.25)",
                }}>
                  <p style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.6, color: "#4ade80", fontWeight: 700 }}>
                    Notes from the call
                  </p>
                  <p style={{ fontSize: 13, marginTop: 5, lineHeight: 1.5 }}>{booking.notes}</p>
                </div>
              ) : (
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, fontStyle: "italic" }}>
                  No notes were left on the booking call.
                </p>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flexShrink: 0 }}>
              {lead.phone ? (
                <a href={`tel:${lead.phone.replace(/[^+\d]/g, "")}`} style={{ ...btnGhost, fontVariantNumeric: "tabular-nums" }}>
                  {lead.phone}
                </a>
              ) : (
                <span style={{ ...btnGhost, opacity: 0.5, cursor: "default" }}>no phone</span>
              )}
              {lead.email && <a href={`mailto:${lead.email}`} style={btnGhost}>Email</a>}
              {lead.website && (
                <a href={lead.website} target="_blank" rel="noreferrer" style={btnGhost}>Website</a>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)",
  borderRadius: 14, padding: "14px 16px",
};
const pill: React.CSSProperties = {
  padding: "2px 8px", borderRadius: 999, border: "1px solid", fontSize: 10.5, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: 0.4,
};
const btnGhost: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 10, border: "1px solid var(--border)",
  background: "var(--bg-hover)", color: "var(--text-primary)",
  fontSize: 12.5, fontWeight: 600, cursor: "pointer", textDecoration: "none",
};
