"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// School — Jack's live class schedule, pulled straight from the published
// schedule app (wingdigital26-maker.github.io/schedule) on every request.
//
// Nothing here is a copy. /api/school fetches the live page, parses the DATA
// block build.py writes, and hands back the real courses. Edit the markers,
// run build.py, push: this board changes on its next load with no step here.
//
// If the fetch or the parse fails, the board says so and names what failed.
// It never falls back to remembered classes.

type Final = {
  date?: string;
  start?: string;
  end?: string;
  bldg?: string;
  room?: string;
  tba?: boolean;
} | null;

type Meeting = {
  code: string | null;
  title: string;
  short: string;
  days: string;
  start: string;
  end: string;
  bldg: string;
  room: string;
  final: Final;
};

type Payload = {
  ok: boolean;
  error?: string;
  source: string;
  fetched_at: string;
  published_at: string | null;
  label: string | null;
  campus: string | null;
  semester: { start?: string; lastClass?: string; finalsEnd?: string } | null;
  courses: Meeting[];
};

export type SchoolSectionProps = {
  /** Poll interval in ms for re-pulling the live schedule. 0 disables polling. */
  refreshMs?: number;
};

const DAY_KEYS = ["M", "T", "W", "R", "F"] as const;
const DAY_NAMES: Record<string, string> = {
  M: "Monday",
  T: "Tuesday",
  W: "Wednesday",
  R: "Thursday",
  F: "Friday",
};
// JS getDay() 0..6 → the app's day letters. Weekends have no letter.
const JS_DAY: Record<number, string> = { 1: "M", 2: "T", 3: "W", 4: "R", 5: "F" };

function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

function pretty(hhmm: string): string {
  const mins = toMinutes(hhmm);
  if (mins < 0) return hhmm;
  const h24 = Math.floor(mins / 60);
  const mm = String(mins % 60).padStart(2, "0");
  const ampm = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${mm}${ampm}`;
}

function ago(iso: string | null): string {
  if (!iso) return "unknown";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  padding: 16,
};

/**
 * The School section.
 *
 * Import: `import SchoolSection from "./components/SchoolBoard";`
 * Usage:  `<SchoolSection />` or `<SchoolSection refreshMs={0} />`
 */
export default function SchoolSection({ refreshMs = 300000 }: SchoolSectionProps) {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/school", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Payload) => {
        setData(d);
        setErr(d.ok ? "" : d.error || "The schedule could not be read.");
      })
      .catch((e) => setErr(`Could not reach /api/school: ${String(e)}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!refreshMs) return;
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [load, refreshMs]);

  const todayLetter = JS_DAY[new Date().getDay()] ?? "";

  const byDay = useMemo(() => {
    const out: Record<string, Meeting[]> = { M: [], T: [], W: [], R: [], F: [] };
    for (const c of data?.courses ?? []) {
      for (const d of c.days || "") {
        if (out[d]) out[d].push(c);
      }
    }
    for (const d of DAY_KEYS) out[d].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    return out;
  }, [data]);

  const finals = useMemo(
    () =>
      (data?.courses ?? [])
        .filter((c) => c.final)
        .sort((a, b) => String(a.final?.date ?? "9").localeCompare(String(b.final?.date ?? "9"))),
    [data]
  );

  const link = data?.source || "https://wingdigital26-maker.github.io/schedule/";

  const header = (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>School</h2>
      <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
        {data?.label || "Class schedule"}
        {data?.campus ? ` · ${data.campus}` : ""}
      </span>
      <span style={{ flex: 1 }} />
      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          fontSize: 13,
          fontWeight: 600,
          padding: "8px 14px",
          borderRadius: 10,
          border: "1px solid var(--accent)",
          color: "var(--accent)",
          textDecoration: "none",
        }}
      >
        Open the schedule app
      </a>
      <button
        onClick={load}
        disabled={loading}
        style={{
          fontSize: 13,
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid var(--border)",
          background: "var(--bg-hover)",
          color: "var(--text-primary)",
          cursor: loading ? "default" : "pointer",
        }}
      >
        {loading ? "Refreshing" : "Refresh"}
      </button>
    </div>
  );

  const freshness = data && (
    <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
      {data.ok ? "Live from " : "Tried "}
      <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)" }}>
        {link}
      </a>
      {" · pulled "}
      {ago(data.fetched_at)}
      {data.published_at ? ` · app last published ${new Date(data.published_at).toLocaleString()}` : ""}
    </p>
  );

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 12 }} aria-label="Loading School">
        {header}
        {[0, 1, 2].map((i) => (
          <div key={i} className="skel" style={{ height: 90, borderRadius: 14 }} />
        ))}
      </div>
    );
  }

  if (!data.ok || err) {
    return (
      <div style={{ display: "grid", gap: 12 }}>
        {header}
        <div style={{ ...card, borderColor: "var(--red)" }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15, color: "var(--red)" }}>
            The live schedule could not be read
          </h3>
          <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-secondary)" }}>
            {err || data.error}
          </p>
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>
            Nothing is shown below on purpose. This board only ever displays what the published app
            is serving right now, so it will not fall back to an older copy of your classes. Open
            the app directly to check it:{" "}
            <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
              {link}
            </a>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {header}
      {freshness}

      {data.semester && (
        <div style={{ ...card, display: "flex", flexWrap: "wrap", gap: 22 }}>
          {[
            ["Semester starts", data.semester.start],
            ["Last class day", data.semester.lastClass],
            ["Finals end", data.semester.finalsEnd],
            ["Courses", String(data.courses.length)],
          ].map(([k, v]) => (
            <div key={k as string}>
              <div style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)" }}>
                {k}
              </div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{v || "not set"}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12 }}>
        {DAY_KEYS.map((d) => (
          <div
            key={d}
            style={{
              ...card,
              borderColor: d === todayLetter ? "var(--accent)" : "var(--border)",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>{DAY_NAMES[d]}</strong>
              {d === todayLetter && (
                <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 700 }}>TODAY</span>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{byDay[d].length}</span>
            </div>
            {byDay[d].length === 0 ? (
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>No classes.</p>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {byDay[d].map((c, i) => (
                  <div
                    key={`${c.title}-${i}`}
                    style={{
                      borderLeft: "3px solid var(--accent-dim)",
                      paddingLeft: 9,
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{c.short}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {pretty(c.start)} to {pretty(c.end)}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {[c.bldg, c.room].filter(Boolean).join(" ") || "Room not listed"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={card}>
        <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Courses</h3>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" }}>
                <th style={{ padding: "6px 8px" }}>Course</th>
                <th style={{ padding: "6px 8px" }}>Days</th>
                <th style={{ padding: "6px 8px" }}>Time</th>
                <th style={{ padding: "6px 8px" }}>Where</th>
              </tr>
            </thead>
            <tbody>
              {data.courses.map((c, i) => (
                <tr key={`${c.title}-${i}`} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px" }}>
                    <div style={{ fontWeight: 600 }}>{c.title}</div>
                    {c.code && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{c.code}</div>}
                  </td>
                  <td style={{ padding: "8px", color: "var(--text-secondary)" }}>{c.days || "not listed"}</td>
                  <td style={{ padding: "8px", color: "var(--text-secondary)" }}>
                    {c.start && c.end ? `${pretty(c.start)} to ${pretty(c.end)}` : "not listed"}
                  </td>
                  <td style={{ padding: "8px", color: "var(--text-secondary)" }}>
                    {[c.bldg, c.room].filter(Boolean).join(" ") || "not listed"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {finals.length > 0 && (
        <div style={card}>
          <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>Finals</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {finals.map((c, i) => (
              <div key={`${c.title}-final-${i}`} style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 13 }}>
                <strong style={{ minWidth: 170 }}>{c.short}</strong>
                <span style={{ color: "var(--text-secondary)" }}>
                  {c.final?.tba
                    ? "Time to be announced"
                    : `${c.final?.date ?? "date not listed"} · ${
                        c.final?.start ? `${pretty(c.final.start)} to ${pretty(c.final.end || "")}` : "time not listed"
                      }`}
                </span>
                <span style={{ color: "var(--text-muted)" }}>
                  {[c.final?.bldg, c.final?.room].filter(Boolean).join(" ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
