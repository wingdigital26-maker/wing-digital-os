"use client";

import { useCallback, useEffect, useState } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Deliverability Board — email-sending health in plain English.
//
// One card per section from /api/deliverability, each with a big traffic-light
// dot, a one-line summary a non-coder can act on, and an expandable list of
// individual checks. Every red/yellow item explains what it means and what to
// do, with a link to the broken thing where one exists. Gray means "nothing to
// check yet", which the API reports honestly (e.g. no sending domain bought).
// ───────────────────────────────────────────────────────────────────────────

type Light = "green" | "yellow" | "red" | "gray";

type Check = {
  name: string;
  status: Light;
  summary: string;
  meaning: string | null;
  action: string | null;
  link: string | null;
  detail: string | null;
};

type Section = {
  id: string;
  label: string;
  configured: boolean;
  status: Light;
  summary: string;
  missing: string | null;
  error: string | null;
  checks: Check[];
  extra?: unknown;
};

type Payload = {
  sections: Section[];
  overall: Light;
  fetchedAt: string;
};

const LIGHT_COLOR: Record<Light, string> = {
  green: "var(--green)",
  yellow: "var(--orange)",
  red: "var(--red)",
  gray: "var(--text-muted)",
};

const LIGHT_WORD: Record<Light, string> = {
  green: "Healthy",
  yellow: "Needs a look",
  red: "Broken",
  gray: "Nothing to check yet",
};

function Dot({ status, size = 14 }: { status: Light; size?: number }) {
  return (
    <span
      aria-label={LIGHT_WORD[status]}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: LIGHT_COLOR[status],
        flexShrink: 0,
        boxShadow: status === "gray" ? "none" : `0 0 8px ${LIGHT_COLOR[status]}`,
      }}
    />
  );
}

function CheckRow({ check }: { check: Check }) {
  const [open, setOpen] = useState(false);
  const hasMore = Boolean(check.meaning || check.action || check.detail);
  return (
    <div
      style={{
        padding: "10px 12px",
        borderTop: "1px solid var(--border)",
      }}
    >
      <div
        onClick={() => hasMore && setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          cursor: hasMore ? "pointer" : "default",
        }}
      >
        <span style={{ marginTop: 3 }}>
          <Dot status={check.status} size={10} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ color: "var(--text-primary)", fontSize: 13, fontWeight: 600 }}>
            {check.name}
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 2 }}>
            {check.summary}
          </div>
        </div>
        {hasMore && (
          <span style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 3 }}>
            {open ? "hide" : "details"}
          </span>
        )}
      </div>
      {open && (
        <div style={{ marginLeft: 20, marginTop: 8, display: "grid", gap: 6 }}>
          {check.meaning && (
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>What this means: </span>
              {check.meaning}
            </div>
          )}
          {check.action && (
            <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>What to do: </span>
              {check.action}
            </div>
          )}
          {check.link && (
            <a
              href={check.link}
              target={check.link.startsWith("http") ? "_blank" : undefined}
              rel="noreferrer"
              style={{ fontSize: 12.5, color: "var(--accent)", textDecoration: "none" }}
            >
              Open the thing to fix →
            </a>
          )}
          {check.detail && (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-muted)",
                fontFamily: "ui-monospace, monospace",
                background: "var(--bg-card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 8px",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {check.detail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionCard({ section }: { section: Section }) {
  const [open, setOpen] = useState(section.status === "red" || section.status === "yellow");
  return (
    <div
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <div
        onClick={() => section.checks.length > 0 && setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: "14px 16px",
          cursor: section.checks.length ? "pointer" : "default",
        }}
      >
        <span style={{ marginTop: 3 }}>
          <Dot status={section.status} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "var(--text-primary)", fontWeight: 700, fontSize: 15 }}>
              {section.label}
            </span>
            <span style={{ color: LIGHT_COLOR[section.status], fontSize: 12, fontWeight: 600 }}>
              {LIGHT_WORD[section.status]}
            </span>
          </div>
          <div style={{ color: "var(--text-secondary)", fontSize: 13.5, marginTop: 4 }}>
            {section.summary}
          </div>
          {!section.configured && section.missing && (
            <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
              To connect this, set the environment variable{" "}
              <code style={{ fontFamily: "ui-monospace, monospace" }}>{section.missing}</code> on the
              deployment.
            </div>
          )}
          {section.error && (
            <div style={{ color: "var(--orange)", fontSize: 12, marginTop: 6 }}>
              {section.error}
            </div>
          )}
        </div>
        {section.checks.length > 0 && (
          <span style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 4 }}>
            {open ? "hide" : `${section.checks.length} item${section.checks.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>
      {open && section.checks.map((c, i) => <CheckRow key={`${section.id}:${i}`} check={c} />)}
    </div>
  );
}

export default function DeliverabilityBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/deliverability", { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message || `The health check failed (HTTP ${res.status}).`);
      }
      setData((await res.json()) as Payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div style={{ display: "grid", gap: 14, maxWidth: 860 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ color: "var(--text-primary)", fontSize: 18, fontWeight: 700, margin: 0 }}>
          Email Health
        </h2>
        {data && <Dot status={data.overall} />}
        {data && (
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
            Checked {new Date(data.fetchedAt).toLocaleTimeString()}
          </span>
        )}
        <button
          onClick={load}
          disabled={loading}
          style={{
            marginLeft: "auto",
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 8,
            color: "var(--text-secondary)",
            fontSize: 12.5,
            padding: "6px 12px",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Checking..." : "Re-check"}
        </button>
      </div>

      {/* One-line verdict, above everything: can a non-technical reader tell in
          five seconds whether anything needs action? Computed from the same
          section statuses the cards below show, so it can never disagree. */}
      {data && (() => {
        const broken = data.sections.filter((s) => s.status === "red");
        const worry = data.sections.filter((s) => s.status === "yellow");
        const n = broken.length + worry.length;
        const tone = broken.length ? "var(--red)" : worry.length ? "var(--orange)" : "var(--green)";
        return (
          <div style={{
            border: `1px solid ${tone}`, borderRadius: 12, padding: "12px 16px",
            background: "var(--bg-card)", display: "grid", gap: 3,
          }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: tone }}>
              {n === 0
                ? "Everything checked is healthy. Nothing needs you."
                : `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention.`}
            </div>
            {n > 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.55 }}>
                {[...broken, ...worry].map((s) => s.label).join(", ")}. The cards below say what
                each one means and what to do.
              </div>
            )}
          </div>
        );
      })()}

      <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
        Whether Wing's outbound email can actually reach inboxes: domain records, warmup pacing, the
        do-not-contact list, and what happened in the last week. Gray means there is honestly nothing
        to check yet, not that something is hidden.
      </div>

      {error && (
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--red)",
            borderRadius: 12,
            padding: "12px 16px",
            color: "var(--text-primary)",
            fontSize: 13.5,
          }}
        >
          The board could not load its data: {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Running the health checks...</div>
      )}

      {data?.sections.map((s) => (
        <SectionCard key={s.id} section={s} />
      ))}
    </div>
  );
}
