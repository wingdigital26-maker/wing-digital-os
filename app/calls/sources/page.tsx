"use client";
import { useEffect, useState } from "react";

// Where the leads came from, and why some of them are not being called.
//
// The rejection list is the point of this screen: the quality audit's cuts are
// written down in the database, so they can be read back and argued with
// instead of being an invisible filter.
//
// Page chrome (header, nav, sign-out, max-width) comes from app/calls/layout.tsx.

type Counted = { key: string; count: number };

type SourceAgg = {
  source: string;
  total: number;
  dialable: number;
  excluded: number;
  statuses: Counted[];
};

type Batch = {
  id: string;
  source: string;
  imported_at: string | null;
  total: number | null;
  serviceable: number | null;
  excluded: number | null;
  note: string | null;
};

type RejectionGroup = { reason: string; count: number; companies: string[] };

type Payload = {
  totals: {
    leads: number;
    dialable: number;
    excluded: number;
    dialableWithoutPhone: number;
    excludedWithoutReason: number;
    distinctSources: number;
  };
  batches: Batch[];
  batchesReadable: boolean;
  sources: SourceAgg[];
  statuses: Counted[];
  coverage: { verticals: Counted[]; cities: Counted[] };
  rejectionGroups: RejectionGroup[];
  importNote: string;
};

const STATUS_LABEL: Record<string, string> = {
  new: "Not called yet",
  contacted: "Spoken to",
  callback: "Call back",
  booked: "Booked",
  not_interested: "Not interested",
  bad_number: "Bad number",
  dnc: "Do not call",
};
const STATUS_TONE: Record<string, string> = {
  new: "#94a3b8",
  contacted: "#38bdf8",
  callback: "#eab308",
  booked: "#22c55e",
  not_interested: "#f97316",
  bad_number: "#a78bfa",
  dnc: "#ef4444",
};

function when(iso: string | null) {
  if (!iso) return "import date not recorded";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "import date not readable" : d.toLocaleString();
}

export default function SourcesPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    fetch("/api/calls/sources", { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) {
          setError(d.error ?? "Could not load lead sources.");
        } else {
          setData(d as Payload);
        }
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setError("Could not reach the server.");
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading lead sources…</p>;
  }
  if (error || !data) {
    return (
      <div>
        <h1 style={h1}>Where the leads come from</h1>
        <div style={{ ...banner, background: "rgba(239,68,68,0.12)", borderColor: "rgba(239,68,68,0.4)", color: "#f87171" }}>
          {error ?? "No data came back."}
        </div>
      </div>
    );
  }

  const t = data.totals;
  const maxVert = Math.max(1, ...data.coverage.verticals.map((v) => v.count));
  const maxCity = Math.max(1, ...data.coverage.cities.map((v) => v.count));

  return (
    <div>
      <h1 style={h1}>Where the leads come from</h1>
      <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.55, maxWidth: 720 }}>
        Every lead in the call room, traced back to the import that put it here, plus every
        lead the quality audit cut, with the reason it was cut.
      </p>

      {/* totals */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 20 }}>
        <Stat label="Leads in the room" value={t.leads} />
        <Stat label="Dialable" value={t.dialable} tone="#22c55e" />
        <Stat label="Excluded" value={t.excluded} tone="#f97316" />
        <Stat label="Sources" value={t.distinctSources} />
      </div>
      {(t.dialableWithoutPhone > 0 || t.excludedWithoutReason > 0) && (
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          {t.dialableWithoutPhone > 0 && (
            <>{t.dialableWithoutPhone} dialable {t.dialableWithoutPhone === 1 ? "lead has" : "leads have"} no phone number on file. </>
          )}
          {t.excludedWithoutReason > 0 && (
            <>{t.excludedWithoutReason} excluded {t.excludedWithoutReason === 1 ? "lead has" : "leads have"} no reason recorded.</>
          )}
        </p>
      )}

      {/* import ledger */}
      <Section title="Import batches" sub="Every run of the importer, most recent first.">
        {!data.batchesReadable && (
          <Empty>The call_lead_batches table could not be read, so the import history is unknown.</Empty>
        )}
        {data.batchesReadable && data.batches.length === 0 && (
          <Empty>No import batches are recorded. The leads in the room have no batch row explaining how they got here.</Empty>
        )}
        {data.batches.map((b) => (
          <div key={b.id} style={{ ...card, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <div style={{ flex: "1 1 260px", minWidth: 0 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>{b.source}</div>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>{when(b.imported_at)}</p>
              {b.note && <p style={{ fontSize: 12.5, marginTop: 5, lineHeight: 1.45 }}>{b.note}</p>}
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              <MiniStat label="imported" value={b.total} />
              <MiniStat label="serviceable" value={b.serviceable} tone="#22c55e" />
              <MiniStat label="excluded" value={b.excluded} tone="#f97316" />
            </div>
          </div>
        ))}
      </Section>

      {/* per source */}
      <Section title="By source" sub="How each source's leads are split, and where they sit in the pipeline.">
        {data.sources.length === 0 && <Empty>There are no leads in call_leads yet.</Empty>}
        {data.sources.map((s) => (
          <div key={s.source} style={card}>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ fontSize: 14.5, fontWeight: 700 }}>{s.source}</div>
                <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>
                  {s.total} {s.total === 1 ? "lead" : "leads"}
                </p>
              </div>
              <div style={{ display: "flex", gap: 18 }}>
                <MiniStat label="dialable" value={s.dialable} tone="#22c55e" />
                <MiniStat label="excluded" value={s.excluded} tone="#f97316" />
              </div>
            </div>
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 12 }}>
              {s.statuses.map((st) => (
                <span
                  key={st.key}
                  style={{
                    ...pill,
                    borderColor: `${STATUS_TONE[st.key] ?? "#64748b"}66`,
                    color: STATUS_TONE[st.key] ?? "#94a3b8",
                  }}
                >
                  {STATUS_LABEL[st.key] ?? st.key} · {st.count}
                </span>
              ))}
            </div>
          </div>
        ))}
      </Section>

      {/* the important part */}
      <Section
        title="Why we are not calling some of them"
        sub={`${t.excluded} ${t.excluded === 1 ? "lead was" : "leads were"} excluded by the quality audit. Grouped by the reason recorded on the row. Tap a reason to see which companies.`}
      >
        {data.rejectionGroups.length === 0 && (
          <Empty>Nothing has been excluded. Every lead in the room is dialable.</Empty>
        )}
        {data.rejectionGroups.map((g) => {
          const on = Boolean(open[g.reason]);
          return (
            <div key={g.reason} style={{ ...card, padding: 0, overflow: "hidden" }}>
              <button
                onClick={() => setOpen((p) => ({ ...p, [g.reason]: !p[g.reason] }))}
                style={{
                  width: "100%", display: "flex", gap: 12, alignItems: "center",
                  padding: "13px 16px", background: "transparent", border: "none",
                  color: "var(--text-primary)", cursor: "pointer", textAlign: "left",
                }}
              >
                <span
                  style={{
                    minWidth: 30, height: 26, padding: "0 8px", borderRadius: 8,
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    background: "rgba(249,115,22,0.14)", border: "1px solid rgba(249,115,22,0.35)",
                    color: "#fb923c", fontSize: 12.5, fontWeight: 800, flexShrink: 0,
                  }}
                >
                  {g.count}
                </span>
                <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.45 }}>{g.reason}</span>
                <span style={{ fontSize: 11.5, color: "var(--text-muted)", flexShrink: 0 }}>
                  {on ? "hide" : "show"}
                </span>
              </button>
              {on && (
                <div style={{ padding: "0 16px 14px 58px", display: "flex", flexDirection: "column", gap: 5 }}>
                  {g.companies.map((c, i) => (
                    <span key={`${c}-${i}`} style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{c}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </Section>

      {/* coverage */}
      <Section
        title="Coverage of the dialable leads"
        sub="Counts of the leads we can actually call. These are head counts of rows in the database, not an estimate of how big each trade or city really is."
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 12 }}>
          <div style={card}>
            <p style={sectionMini}>By trade</p>
            {data.coverage.verticals.length === 0 ? (
              <Empty>No dialable leads to break down.</Empty>
            ) : (
              data.coverage.verticals.map((v) => <Bar key={v.key} item={v} max={maxVert} />)
            )}
          </div>
          <div style={card}>
            <p style={sectionMini}>By city</p>
            {data.coverage.cities.length === 0 ? (
              <Empty>No dialable leads to break down.</Empty>
            ) : (
              data.coverage.cities.map((v) => <Bar key={v.key} item={v} max={maxCity} />)
            )}
          </div>
        </div>
      </Section>

      {/* honest import note */}
      <div
        style={{
          marginTop: 26, padding: "14px 16px", borderRadius: 12,
          background: "rgba(56,189,248,0.07)", border: "1px solid rgba(56,189,248,0.22)",
        }}
      >
        <p style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, color: "#7dd3fc", fontWeight: 700 }}>
          How new leads get here
        </p>
        <p style={{ fontSize: 13, marginTop: 6, lineHeight: 1.6 }}>
          {data.importNote}
        </p>
        <p style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.6, color: "var(--text-muted)" }}>
          There is deliberately no import button on this page. A button here could not work,
          and a button that cannot work is worse than none.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 24, fontWeight: 800, color: tone ?? "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 3 }}>{label}</div>
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number | null; tone?: string }) {
  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 800, color: tone ?? "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
        {value === null || value === undefined ? "—" : value}
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
    </div>
  );
}

function Bar({ item, max }: { item: Counted; max: number }) {
  return (
    <div style={{ marginTop: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, gap: 10 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.key}</span>
        <span style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{item.count}</span>
      </div>
      <div style={{ height: 5, borderRadius: 999, background: "var(--bg-hover)", marginTop: 4, overflow: "hidden" }}>
        <div
          style={{
            width: `${Math.round((item.count / max) * 100)}%`,
            height: "100%",
            background: "linear-gradient(135deg,#22d3ee,#0e7490)",
          }}
        />
      </div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 30 }}>
      <h2 style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: -0.2 }}>{title}</h2>
      {sub && (
        <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5, maxWidth: 760 }}>{sub}</p>
      )}
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5, marginTop: 8 }}>{children}</p>
  );
}

const h1: React.CSSProperties = { fontSize: 24, fontWeight: 800, letterSpacing: -0.5 };
const card: React.CSSProperties = {
  background: "var(--bg-card)", border: "1px solid var(--border)",
  borderRadius: 14, padding: "14px 16px",
};
const pill: React.CSSProperties = {
  padding: "3px 9px", borderRadius: 999, border: "1px solid", fontSize: 11,
  fontWeight: 700, letterSpacing: 0.2,
};
const banner: React.CSSProperties = {
  marginTop: 14, padding: "11px 14px", borderRadius: 10,
  border: "1px solid", fontSize: 13, fontWeight: 600,
};
const sectionMini: React.CSSProperties = {
  fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6,
  color: "var(--text-muted)", fontWeight: 700,
};
