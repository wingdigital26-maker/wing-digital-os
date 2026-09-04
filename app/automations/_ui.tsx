"use client";
// Shared look and helpers for every screen under /automations. Copies the
// /sequences visual language: inline style objects, colors only through
// var(--token), plain English on screen.
import { useEffect, useSyncExternalStore } from "react";
import { ACTION_DEFS, type ActionType, type WorkflowRunRow } from "@/lib/automations/types";

// Kick off a screen's first load. Deferred one tick so the effect body itself
// never sets state (react-hooks/set-state-in-effect); cancelled on unmount so
// a strict-mode double mount does not fire twice.
export function useLoad(load: () => Promise<void>) {
  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      if (alive) void load();
    }, 0);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [load]);
}

// The address this OS is served from, for embed snippets and webhook URLs.
// Server render and first client paint agree on the fallback, then the real
// origin replaces it without a hydration mismatch.
export const FALLBACK_ORIGIN = "https://wing-digital-os.vercel.app";
const noSubscribe = () => () => {};
export function useOrigin(): string {
  return useSyncExternalStore(
    noSubscribe,
    () => window.location.origin || FALLBACK_ORIGIN,
    () => FALLBACK_ORIGIN
  );
}

export const card: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
};
export const btn: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-hover)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};
export const btnPrimary: React.CSSProperties = {
  ...btn,
  background: "var(--accent)",
  border: "1px solid var(--accent)",
  color: "#fff",
};
export const btnSmall: React.CSSProperties = { ...btn, padding: "5px 10px", fontSize: 12 };
export const input: React.CSSProperties = {
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-primary)",
  fontSize: 13.5,
  boxSizing: "border-box",
  maxWidth: "100%",
};
export const label: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-secondary)",
  marginBottom: 4,
};
export const h1: React.CSSProperties = {
  fontFamily: "'Space Grotesk',sans-serif",
  fontSize: 24,
  fontWeight: 700,
  margin: 0,
};
export const muted: React.CSSProperties = { fontSize: 13, color: "var(--text-muted)" };

// The confirm text behind every Activate button. Says exactly what is real
// and what is only drafted, so nobody activates something they misread.
export const ACTIVATE_WARNING =
  "Activate this automation?\n\n" +
  "Texts and emails from this automation are only DRAFTED unless sending is switched on for this deployment (AUTOMATION_SEND_ENABLED). " +
  "Everything else (deals, tags, tasks, phone alerts) happens for real.\n\n" +
  "You can pause it any time.";

// One fetch wrapper so every screen surfaces the server's own message
// instead of a bare status code, and never treats an HTML error page as data.
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error(d?.message || d?.error || `The server said no (HTTP ${r.status}).`);
  return d as T;
}

export function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "no time recorded";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60000);
  if (mins >= 0 && mins < 1) return "just now";
  if (mins > 0 && mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs > 0 && hrs < 24) return `${hrs} hr ago`;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function pillColor(status: string): string {
  switch (status) {
    case "active":
    case "done":
    case "answered":
      return "var(--green)";
    case "paused":
    case "running":
    case "waiting":
    case "skipped":
      return "var(--orange)";
    case "failed":
    case "missed":
      return "var(--red)";
    default:
      return "var(--text-muted)";
  }
}

const PILL_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  running: "Running",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

export function StatusPill({ status, text }: { status: string; text?: string }) {
  const color = pillColor(status);
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        borderRadius: 999,
        padding: "3px 10px",
        whiteSpace: "nowrap",
      }}
    >
      {text ?? PILL_LABELS[status] ?? status}
    </span>
  );
}

export function Notice({ kind, children }: { kind: "ok" | "warn" | "error"; children: React.ReactNode }) {
  const color = kind === "ok" ? "var(--green)" : kind === "warn" ? "var(--orange)" : "var(--red)";
  return (
    <div role="status" style={{ ...card, borderColor: color, color, fontWeight: 600, marginBottom: 14, fontSize: 13 }}>
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ ...card, textAlign: "center", padding: 34, color: "var(--text-secondary)", fontSize: 14 }}>
      {children}
    </div>
  );
}

export function ErrorBox({ what, error }: { what: string; error: string }) {
  return (
    <div style={{ ...card, borderColor: "var(--red)", marginBottom: 14, fontSize: 13 }}>
      Could not load {what}: {error}
    </div>
  );
}

// A run's log, one plain-English line per action the engine attempted.
export function RunLog({ run }: { run: Pick<WorkflowRunRow, "log" | "error"> }) {
  const entries = Array.isArray(run.log) ? run.log : [];
  return (
    <div style={{ marginTop: 10, fontSize: 13 }}>
      {run.error && <div style={{ color: "var(--red)", marginBottom: 6 }}>Stopped because: {run.error}</div>}
      {entries.length === 0 && !run.error && <div style={muted}>Nothing was written to the log for this run.</div>}
      <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 4 }}>
        {entries.map((l, i) => {
          const def = ACTION_DEFS[l.action_type as ActionType];
          return (
            <li key={i} style={{ color: l.ok ? "var(--text-secondary)" : "var(--red)", overflowWrap: "anywhere" }}>
              <strong>{def?.label ?? l.action_type}</strong>
              {l.ok ? "" : " (failed)"}
              {l.note ? `: ${l.note}` : ""}
              {l.at && <span style={{ ...muted, marginLeft: 6 }}>{fmtWhen(l.at)}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Pull a list out of a response no matter which key the route chose, so a
// small naming difference between agents does not blank a screen.
export function pickList<T>(d: unknown, ...keys: string[]): T[] {
  if (Array.isArray(d)) return d as T[];
  if (d && typeof d === "object") {
    const o = d as Record<string, unknown>;
    for (const k of keys) if (Array.isArray(o[k])) return o[k] as T[];
  }
  return [];
}
