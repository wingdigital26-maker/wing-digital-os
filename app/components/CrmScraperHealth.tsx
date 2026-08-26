"use client";

// Scraper health — the panel that answers "is this client's scraper working?"
//
// The whole point is that an empty panel must never look like a healthy one.
// Every state gets its own colour, its own border treatment, its own headline
// and its own sentence explaining what that state means. A number is only ever
// printed when a source actually reported it; anything unrecorded says so in
// words instead of showing a zero that reads like a measurement.

export type WatchRun = {
  client: string; queries: number | null; results: number | null;
  kept: number | null; rejected: number | null; throttled: number | null;
  ran_at: string | null;
};

export type WatchState =
  | "NOT_CONFIGURED" | "UNKNOWN" | "NEVER_RUN" | "RAN_FOUND_NOTHING" | "WORKING";

export type Watch = {
  state: WatchState;
  detail: string;
  lastRanAt: string | null;
  lastRanTracked: boolean;
  run: WatchRun | null;
  runsAvailable: boolean;
  runsReason: string | null;
  draftsWaiting: number | null;
  draftsReason: string | null;
};

// Colour and shape carry the state as well as the words, so the panel reads at
// a glance without being read. Solid border = we know; dashed = we do not.
const LOOK: Record<WatchState, {
  label: string; color: string; dashed: boolean; mark: string; tint: boolean;
}> = {
  WORKING:           { label: "Working",             color: "var(--green)",     dashed: false, mark: "●", tint: true },
  RAN_FOUND_NOTHING: { label: "Ran, found nothing",  color: "var(--orange)",    dashed: false, mark: "◐", tint: false },
  NEVER_RUN:         { label: "Never run",           color: "var(--red)",       dashed: true,  mark: "○", tint: false },
  NOT_CONFIGURED:    { label: "Not configured",      color: "var(--red)",       dashed: true,  mark: "⊘", tint: false },
  UNKNOWN:           { label: "Can't tell",          color: "var(--text-muted)",dashed: true,  mark: "?", tint: false },
};

// Plain words, not a timestamp Jack has to do arithmetic on.
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "at an unreadable timestamp";
  const s = Math.round((now - t) / 1000);
  if (s < 0) return "just now (its clock is ahead of ours)";
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.round(h / 24);
  if (d < 45) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.round(d / 30);
  return `${mo} month${mo === 1 ? "" : "s"} ago`;
}

// A counter cell. `value === null` means nobody recorded it — never a zero.
function Metric({ value, label, color }: { value: number | null; label: string; color?: string }) {
  const missing = value === null;
  return (
    <div style={{
      border: `1px ${missing ? "dashed" : "solid"} var(--border)`, borderRadius: 10,
      padding: "7px 12px", background: "var(--bg-card)", minWidth: 88,
    }}>
      <div style={{
        fontSize: missing ? 11.5 : 18, fontWeight: missing ? 500 : 700,
        lineHeight: 1.45, fontVariantNumeric: "tabular-nums",
        color: missing ? "var(--text-muted)" : (color ?? "var(--text-primary)"),
      }}>{missing ? "not recorded" : value}</div>
      <div style={{
        fontSize: 10.5, color: "var(--text-secondary)", textTransform: "uppercase",
        letterSpacing: ".07em", marginTop: 2,
      }}>{label}</div>
    </div>
  );
}

export default function CrmScraperHealth({ watch, name }: { watch: Watch; name: string }) {
  const run = watch.run;
  // A run that issued zero queries never searched at all. It shares a state
  // with "found nothing", but it is a failure, not a quiet week — so it gets
  // its own badge rather than hiding behind the amber one.
  const searchedNothing =
    watch.state === "RAN_FOUND_NOTHING" && run != null && run.queries === 0;
  const look = searchedNothing
    ? { label: "Ran, searched nothing", color: "var(--red)", dashed: false, mark: "◌", tint: false }
    : LOOK[watch.state];

  // The "when" line. Three genuinely different sentences for three genuinely
  // different situations — no source, a source that says never, and a real time.
  const when = !watch.lastRanTracked && !run?.ran_at
    ? { text: "Last run: not tracked anywhere yet", muted: true }
    : watch.lastRanAt
    ? { text: `Last ran ${ago(watch.lastRanAt)}`, muted: false, exact: watch.lastRanAt }
    : run?.ran_at
    ? { text: `Last ran ${ago(run.ran_at)}`, muted: false, exact: run.ran_at }
    : { text: "Last run: never — no run has ever been recorded", muted: false };

  return (
    <section
      aria-label={`${name} scraper health: ${look.label}`}
      style={{
        border: `1px ${look.dashed ? "dashed" : "solid"} ${look.color}`,
        borderLeftWidth: 4, borderLeftStyle: "solid", borderLeftColor: look.color,
        borderRadius: 14, padding: "13px 16px",
        background: look.tint ? "var(--accent-glow)" : "var(--bg-card)",
        display: "flex", flexDirection: "column", gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
          fontWeight: 700, color: "var(--text-muted)",
        }}>Is the scraper working?</span>
        <span style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          fontSize: 12.5, fontWeight: 700, color: look.color,
          border: `1px ${look.dashed ? "dashed" : "solid"} ${look.color}`,
          borderRadius: 20, padding: "2px 11px",
        }}>
          <span aria-hidden>{look.mark}</span>{look.label}
        </span>
        <span style={{ flex: 1 }} />
        <span
          title={"exact" in when && when.exact ? when.exact : undefined}
          style={{ fontSize: 11.5, color: when.muted ? "var(--text-muted)" : "var(--text-secondary)" }}
        >
          {when.text}
        </span>
      </div>

      <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--text-secondary)" }}>
        {watch.detail}
      </p>

      {/* What the last run did FOR THIS CLIENT. Shown only when a run log row
          exists; otherwise the reason the numbers are absent is shown instead,
          because four zeros would be a lie. */}
      {run ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Metric value={run.queries} label="queries"
                  color={run.queries === 0 ? "var(--red)" : undefined} />
          <Metric value={run.results} label="results"
                  color={(run.results ?? 0) > 0 ? "var(--green)" : "var(--orange)"} />
          <Metric value={run.kept} label="drafts kept"
                  color={(run.kept ?? 0) > 0 ? "var(--green)" : undefined} />
          {run.throttled != null && run.throttled > 0 && (
            <Metric value={run.throttled} label="throttled" color="var(--orange)" />
          )}
        </div>
      ) : (
        <div style={{
          border: "1px dashed var(--border)", borderRadius: 10, padding: "9px 12px",
        }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--orange)" }}>
            No per-run numbers for {name}
          </div>
          <p style={{ margin: "4px 0 0", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-secondary)" }}>
            {watch.runsReason ??
              "No run has been logged against this client, so queries issued, results returned and " +
              "drafts kept are all unknown — not zero."}
          </p>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Metric value={watch.draftsWaiting} label="drafts waiting now"
                color={(watch.draftsWaiting ?? 0) > 0 ? "var(--accent)" : "var(--text-muted)"} />
        {watch.draftsWaiting === 0 && (
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 380, lineHeight: 1.5 }}>
            Nothing is queued for you to review. That is a real count of the outbound table,
            not a missing value.
          </span>
        )}
        {watch.draftsReason && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", maxWidth: 380, lineHeight: 1.5 }}>
            {watch.draftsReason}
          </span>
        )}
      </div>
    </section>
  );
}
