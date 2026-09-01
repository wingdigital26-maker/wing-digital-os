"use client";
import { useCallback, useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// StormBoard — the Storm Response surface. DEMO-ONLY BUILD.
//
// A timeline of hail events near DFW (from scripts/storm_watch.py reading
// SPC's public reports), each with the drafts Wing WOULD run: a Facebook
// post, a geo-targeted ad plan, a Nextdoor post.
//
// HARD RULE, visible in the UI: nothing here posts or spends. Every draft
// carries a DRAFT chip and says so. The only actions are copy-to-clipboard
// and dismiss. There is no publish button anywhere in this build.
// ───────────────────────────────────────────────────────────────────────────

type Draft = {
  id: string;
  event_id: string;
  kind: string; // fb_post | ad_spec | nextdoor
  client_slug: string | null;
  content: any;
  status: string;
  created_at: string;
};

type StormEvent = {
  id: string;
  event_time: string;
  lat: number;
  lon: number;
  size_in: number | null;
  location: string | null;
  county: string | null;
  state: string | null;
  affected: { zip?: string; city?: string; distance_mi?: number }[] | null;
  storm_drafts: Draft[];
};

type Payload = {
  available: boolean;
  tableMissing: boolean;
  events: StormEvent[];
  reason?: string | null;
  message?: string;
  detail?: string | null;
};

const NOTHING_POSTED =
  "Nothing has been posted. Copy runs only when a human pastes it.";

function centralTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return (
    new Date(t).toLocaleString("en-US", {
      timeZone: "America/Chicago",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + " Central"
  );
}

function hailSize(size: number | null): string {
  if (size == null) return "Hail size not reported";
  return `${Number(size).toFixed(2).replace(/\.?0+$/, "")} inch hail`;
}

function Chip({ text, tone, solid }: { text: string; tone: string; solid?: boolean }) {
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        borderRadius: 6,
        padding: "1px 8px",
        color: solid ? "var(--bg-card)" : tone,
        background: solid ? tone : "transparent",
        border: `1px solid ${tone}`,
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </span>
  );
}

function Note({ text, tone = "var(--orange)" }: { text: string; tone?: string }) {
  return (
    <div
      style={{
        border: `1px solid ${tone}`,
        borderRadius: 10,
        padding: "9px 12px",
        background: "var(--bg-card)",
        fontSize: 12,
        lineHeight: 1.55,
        color: tone,
      }}
    >
      {text}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 10.5,
  textTransform: "uppercase",
  letterSpacing: ".06em",
  color: "var(--text-muted)",
  fontWeight: 700,
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          // Clipboard can be blocked; the honest fallback is to say so.
          alert("Could not access the clipboard. Select the text and copy it by hand.");
        }
      }}
      style={{
        padding: "4px 12px",
        borderRadius: 8,
        fontSize: 11.5,
        fontWeight: 600,
        cursor: "pointer",
        border: "1px solid var(--accent)",
        color: copied ? "var(--green)" : "var(--accent)",
        background: "transparent",
      }}
    >
      {copied ? "Copied" : "Copy text"}
    </button>
  );
}

const KIND_LABEL: Record<string, string> = {
  fb_post: "Facebook post",
  ad_spec: "Ad plan",
  nextdoor: "Nextdoor post",
};

/** Pull the post text out of a draft's content jsonb without guessing wrong. */
function draftText(content: any): string {
  if (typeof content === "string") return content;
  if (content && typeof content.text === "string") return content.text;
  if (content && typeof content.body === "string") return content.body;
  return JSON.stringify(content, null, 2);
}

function AdSpecView({ content }: { content: any }) {
  const c = content || {};
  const zips: string[] = Array.isArray(c.geo_zips)
    ? c.geo_zips
    : Array.isArray(c.audience_zips)
    ? c.audience_zips
    : Array.isArray(c.zips)
    ? c.zips
    : [];
  const rows: [string, string][] = [];
  rows.push([
    "Audience",
    zips.length
      ? `People in ZIP codes ${zips.join(", ")}${c.radius_mi ? ` (within ${c.radius_mi} miles of the hail)` : ""}`
      : "Not specified",
  ]);
  const budget = c.daily_budget_usd ?? c.budget_per_day ?? c.budget;
  rows.push(["Budget", budget != null ? `$${budget} per day` : "Not specified"]);
  rows.push([
    "Duration",
    c.duration_days != null ? `${c.duration_days} days` : c.duration ? String(c.duration) : "Not specified",
  ]);
  if (c.headline) rows.push(["Headline", String(c.headline)]);
  const adText = typeof c.primary_text === "string" ? c.primary_text : typeof c.text === "string" ? c.text : null;
  if (adText) rows.push(["Ad text", adText]);
  if (c.description) rows.push(["Description", String(c.description)]);
  if (c.cta) rows.push(["Button", String(c.cta)]);
  const landing = c.landing ?? c.landing_url ?? c.landing_link;
  if (landing) rows.push(["Landing page", String(landing)]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        This is a plan for an ad, written out in plain English. No ad exists, no
        money has been reserved, and this build has no way to launch it.
      </div>
      {rows.map(([k, v]) => (
        <div key={k}>
          <div style={labelStyle}>{k}</div>
          <div style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "pre-wrap", lineHeight: 1.55 }}>
            {v}
          </div>
        </div>
      ))}
      {c.status_note ? (
        <Note text={String(c.status_note)} tone="var(--orange)" />
      ) : null}
    </div>
  );
}

function DraftCard({
  draft,
  onDismiss,
  dismissing,
}: {
  draft: Draft;
  onDismiss: (id: string) => void;
  dismissing: boolean;
}) {
  const label = KIND_LABEL[draft.kind] || draft.kind;
  const dismissed = draft.status === "dismissed";
  const text = draftText(draft.content);
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 10,
        padding: "12px 14px",
        background: "var(--bg-card)",
        opacity: dismissed ? 0.55 : 1,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{label}</span>
        <Chip text="DRAFT" tone="var(--orange)" solid />
        {draft.client_slug ? <Chip text={draft.client_slug} tone="var(--text-muted)" /> : null}
        {dismissed ? <Chip text="dismissed" tone="var(--text-muted)" /> : null}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
        {NOTHING_POSTED}
      </div>
      {draft.kind === "ad_spec" ? (
        <AdSpecView content={draft.content} />
      ) : (
        <div
          style={{
            fontSize: 13,
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            lineHeight: 1.6,
            borderLeft: "3px solid var(--border)",
            paddingLeft: 12,
          }}
        >
          {text}
        </div>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        {draft.kind !== "ad_spec" ? <CopyButton text={text} /> : null}
        {!dismissed ? (
          <button
            onClick={() => onDismiss(draft.id)}
            disabled={dismissing}
            style={{
              padding: "4px 12px",
              borderRadius: 8,
              fontSize: 11.5,
              fontWeight: 600,
              cursor: dismissing ? "default" : "pointer",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              background: "transparent",
            }}
          >
            {dismissing ? "Dismissing..." : "Dismiss"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function EventCard({
  ev,
  onDismiss,
  dismissingId,
}: {
  ev: StormEvent;
  onDismiss: (id: string) => void;
  dismissingId: string | null;
}) {
  const affected = Array.isArray(ev.affected) ? ev.affected : [];
  const drafts = [...(ev.storm_drafts || [])].sort((a, b) =>
    (KIND_LABEL[a.kind] || a.kind).localeCompare(KIND_LABEL[b.kind] || b.kind)
  );
  // Collapsed by default: the draft cards are long, and nesting three of them
  // inside every event made the whole board one awkward scroll. The header
  // always shows the headline, hail size, and ZIP count; expanding shows the
  // full draft cards. Remembered per event so a reload keeps your place.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`storm-open-${ev.id}`) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(`storm-open-${ev.id}`, v ? "0" : "1");
      } catch {}
      return !v;
    });
  };
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: "16px 18px",
        background: "var(--bg-card)",
        display: "flex",
        flexDirection: "column",
        gap: open ? 12 : 0,
      }}
    >
      <button
        onClick={toggle}
        aria-expanded={open}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: 8,
          background: "none",
          border: "none",
          padding: 0,
          cursor: "pointer",
          textAlign: "left",
          width: "100%",
          color: "inherit",
          font: "inherit",
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "var(--text-primary)" }}>
            {hailSize(ev.size_in)}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 2 }}>
            {[ev.location, ev.county ? `${ev.county} County` : null, ev.state]
              .filter(Boolean)
              .join(", ") || "Location not reported"}
          </div>
          {!open ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
              {affected.length
                ? `${affected.length} ZIP code${affected.length === 1 ? "" : "s"} affected`
                : "No ZIP codes mapped"}
              {" · "}
              {drafts.length
                ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"} ready`
                : "no drafts yet"}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{centralTime(ev.event_time)}</span>
          <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, whiteSpace: "nowrap" }}>
            {open ? "Hide drafts ▲" : "Show drafts ▼"}
          </span>
        </div>
      </button>

      {!open ? null : (
        <>
      {affected.length ? (
        <div>
          <div style={{ ...labelStyle, marginBottom: 6 }}>Affected areas</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {affected.map((a, i) => (
              <Chip
                key={`${a.zip}-${i}`}
                text={[a.zip, a.city].filter(Boolean).join(" ") || "unknown"}
                tone="var(--accent)"
              />
            ))}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No affected ZIP codes mapped for this event yet.
        </div>
      )}

      {drafts.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              onDismiss={onDismiss}
              dismissing={dismissingId === d.id}
            />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No drafts written for this event yet. The watcher writes them when it processes the event.
        </div>
      )}
        </>
      )}
    </div>
  );
}

export default function StormBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissingId, setDismissingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/storms", { cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok) {
        setError(j?.message || `The storm feed request failed (${r.status}).`);
        setData(null);
      } else {
        setData(j);
      }
    } catch (e) {
      setError("Could not reach the server. " + String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dismiss = useCallback(
    async (draftId: string) => {
      setDismissingId(draftId);
      try {
        const r = await fetch("/api/storms", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "dismiss", draftId }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          alert(j?.message || "Could not dismiss the draft.");
        } else {
          await load();
        }
      } finally {
        setDismissingId(null);
      }
    },
    [load]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 18, fontWeight: 800, color: "var(--text-primary)" }}>
          Storm Response
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.55 }}>
          Hail reports near DFW and the posts Wing would run for them. Everything
          on this board is a draft. This build cannot post to Facebook or
          Nextdoor and cannot spend money. The only actions are copy and dismiss.
        </div>
      </div>

      {loading && !data ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading storm events...</div>
      ) : null}

      {error ? <Note text={error} tone="var(--red)" /> : null}

      {data && data.tableMissing ? (
        <Note
          text={data.reason || "The storm tables are missing. Apply migration 0020_storm_response.sql."}
          tone="var(--orange)"
        />
      ) : null}

      {data && data.available && data.events.length === 0 ? (
        <Note
          text={
            "No hail events tracked yet. The watcher fills this when hail hits DFW, or run scripts/storm_watch.py --backfill"
          }
          tone="var(--text-muted)"
        />
      ) : null}

      {data?.events?.map((ev) => (
        <EventCard key={ev.id} ev={ev} onDismiss={dismiss} dismissingId={dismissingId} />
      ))}
    </div>
  );
}
