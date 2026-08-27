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
export type Look = {
  label: string; color: string; dashed: boolean; mark: string; tint: boolean;
  /** bad = fix it, warn = watch it, ok = fine, idle = deliberately not running. */
  severity: "ok" | "warn" | "bad" | "idle";
};

const LOOK: Record<WatchState, Look> = {
  WORKING:           { label: "Working",            color: "var(--green)",      dashed: false, mark: "●", tint: true,  severity: "ok" },
  RAN_FOUND_NOTHING: { label: "Ran, found nothing", color: "var(--orange)",     dashed: false, mark: "◐", tint: false, severity: "warn" },
  NEVER_RUN:         { label: "Never run",          color: "var(--red)",        dashed: true,  mark: "○", tint: false, severity: "bad" },
  NOT_CONFIGURED:    { label: "Not configured",     color: "var(--red)",        dashed: true,  mark: "⊘", tint: false, severity: "bad" },
  UNKNOWN:           { label: "Can't tell",         color: "var(--text-muted)", dashed: true,  mark: "?", tint: false, severity: "warn" },
};

const SEARCHED_NOTHING: Look = {
  label: "Ran, searched nothing", color: "var(--red)", dashed: false, mark: "◌", tint: false, severity: "bad",
};
const OFF_BY_CHOICE: Look = {
  label: "Off by choice", color: "var(--text-secondary)", dashed: false, mark: "⏻", tint: false, severity: "idle",
};

// A client whose `channels` is literally "none" has had scraping switched OFF
// deliberately. The config-shaped check the API runs ("no niche, no cities")
// cannot tell that apart from a client someone forgot to fill in, so it reports
// NOT_CONFIGURED — which reads as a defect. It is not one. Deciding not to
// scrape is a setting, and the UI has to say so, or the board cries wolf every
// day about a client that is working exactly as intended.
export function isOffByChoice(channels: string | null | undefined): boolean {
  const v = (channels ?? "").trim().toLowerCase();
  return v === "none" || v === "off" || v === "disabled";
}

/** The single source of truth for how a watch state looks, everywhere. */
export function healthLook(watch: Watch, channels?: string | null): Look {
  if (isOffByChoice(channels)) return OFF_BY_CHOICE;
  // Zero queries means it never actually searched: a failure, not a quiet week.
  if (watch.state === "RAN_FOUND_NOTHING" && watch.run != null && watch.run.queries === 0) {
    return SEARCHED_NOTHING;
  }
  return LOOK[watch.state] ?? LOOK.UNKNOWN;
}

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

export default function CrmScraperHealth({ watch, name, channels }: {
  watch: Watch; name: string; channels?: string | null;
}) {
  const run = watch.run;
  const off = isOffByChoice(channels);
  const look = healthLook(watch, channels);

  // When scraping is off on purpose, the API's NOT_CONFIGURED sentence ("fill
  // the fields in and the next run will hunt") is actively wrong advice, so it
  // gets replaced rather than decorated.
  const detail = off
    ? `Scraping is switched off for ${name} on purpose — their platforms field is set to ` +
      `"none", so no watcher searches on their behalf and no drafts are expected to appear. ` +
      `Nothing here is broken and nothing is missing; this is a setting. Set platforms to a ` +
      `real channel list if you ever want the watcher to start hunting for them.`
    : watch.detail;

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
        {detail}
      </p>

      {/* What the last run did FOR THIS CLIENT. Shown only when a run log row
          exists; otherwise the reason the numbers are absent is shown instead,
          because four zeros would be a lie. */}
      {run ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Metric value={run.queries} label="queries"
                  color={off ? "var(--text-muted)" : run.queries === 0 ? "var(--red)" : undefined} />
          <Metric value={run.results} label="results"
                  color={off ? "var(--text-muted)"
                       : (run.results ?? 0) > 0 ? "var(--green)" : "var(--orange)"} />
          <Metric value={run.kept} label="drafts kept"
                  color={off ? "var(--text-muted)" : (run.kept ?? 0) > 0 ? "var(--green)" : undefined} />
          <Metric value={run.rejected} label="filtered out"
                  color={off ? "var(--text-muted)" : undefined} />
          {run.throttled != null && run.throttled > 0 && (
            <Metric value={run.throttled} label="throttled" color="var(--orange)" />
          )}
          {off && (
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 340, lineHeight: 1.5 }}>
              The run log counted {name} and moved on without searching. With scraping off, zeroes
              here are the correct result, not a failure.
            </span>
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
            {off
              ? `Zero drafts is the expected state for ${name} — nothing drafts for a client whose ` +
                `scraping is off. This is a real count of the outbound table, not a missing value.`
              : "Nothing is queued for you to review. That is a real count of the outbound table, " +
                "not a missing value."}
          </span>
        )}
        {/* The run log and the outbound table disagreeing is a real fault that
            neither number reveals on its own, so it is called out by name. */}
        {!off && run != null && (run.kept ?? 0) > 0 && watch.draftsWaiting === 0 && (
          <span style={{
            fontSize: 11.5, color: "var(--orange)", maxWidth: 420, lineHeight: 1.5,
            borderLeft: "2px solid var(--orange)", paddingLeft: 8,
          }}>
            These two numbers disagree: the last run reports {run.kept} kept as drafts, but the
            outbound table holds 0 drafts for {name}. Either those drafts were written under a
            different client name or they were never written at all.
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
