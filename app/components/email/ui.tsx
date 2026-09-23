"use client";
import type { CSSProperties, ReactNode } from "react";

// ───────────────────────────────────────────────────────────────────────────
// Shared vocabulary for the email surfaces.
//
// The email feed and the reply inbox are two halves of one product, so they
// have to look like it: the same list-pane-plus-reading-pane shell, the same
// chips, the same relative clock, the same honest note. Everything here draws
// only from the OS tokens in app/globals.css — no new colors, no new design
// language, light and dark both work without a branch.
// ───────────────────────────────────────────────────────────────────────────

export function when(iso: string | null | undefined): string {
  if (!iso) return "no date";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fullWhen(iso: string | null | undefined): string {
  if (!iso) return "no date recorded";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
}

/** First letter of the best name we actually have. Never a made-up avatar. */
export function initial(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const s = (c ?? "").trim();
    if (s) return s[0].toUpperCase();
  }
  return "?";
}

export const label: CSSProperties = {
  fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em",
  color: "var(--text-muted)", fontWeight: 700,
};

export function Chip({ text, tone, solid, title }: {
  text: string; tone: string; solid?: boolean; title?: string;
}) {
  return (
    <span title={title} style={{
      fontSize: 10.5, fontWeight: 700, borderRadius: 6, padding: "1px 8px",
      color: solid ? "var(--bg-card)" : tone,
      background: solid ? tone : "transparent",
      border: `1px solid ${tone}`, whiteSpace: "nowrap",
    }}>
      {text}
    </span>
  );
}

export function Note({ text, tone = "var(--orange)" }: { text: string; tone?: string }) {
  return (
    <div style={{
      border: `1px solid ${tone}`, borderRadius: 10, padding: "9px 12px",
      background: "var(--bg-card)", fontSize: 12, lineHeight: 1.55, color: tone,
    }}>
      {text}
    </div>
  );
}

/** A filter button that carries its own count, so the toolbar answers
 *  "42 queued, 310 sent, 3 failed" without opening anything. A count of null
 *  means unknown and renders as nothing, never as a zero. */
export function FilterPill({ text, count, active, tone, onClick, title }: {
  text: string; count?: number | null; active: boolean; tone?: string;
  onClick: () => void; title?: string;
}) {
  const accent = tone ?? "var(--accent)";
  return (
    <button
      type="button" onClick={onClick} title={title}
      style={{
        display: "inline-flex", alignItems: "baseline", gap: 6,
        padding: "4px 12px", borderRadius: 999, fontSize: 11.5, fontWeight: 600,
        cursor: "pointer", fontFamily: "inherit",
        border: `1px solid ${active ? accent : "var(--border)"}`,
        color: active ? accent : "var(--text-secondary)",
        background: active ? "var(--accent-glow)" : "transparent",
        transition: "border-color .12s, color .12s, background .12s",
      }}
    >
      <span>{text}</span>
      {count != null && (
        <span style={{
          fontSize: 10.5, fontWeight: 700, fontVariantNumeric: "tabular-nums",
          color: active ? accent : "var(--text-muted)",
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

export const inputStyle: CSSProperties = {
  borderRadius: 999, border: "1px solid var(--border)",
  background: "var(--bg-card)", color: "var(--text-primary)",
  fontSize: 12.5, padding: "6px 14px", fontFamily: "inherit",
  minWidth: 0, boxSizing: "border-box",
};

export const selectStyle: CSSProperties = {
  ...inputStyle, padding: "6px 10px", cursor: "pointer",
};

/** The two-pane shell every email surface shares: a scannable list on the
 *  left, the thing you are reading on the right. Flex rather than a fixed
 *  grid so a phone stacks them instead of squeezing both. */
export function MailPanes({ list, reader, listWidth = 380 }: {
  list: ReactNode; reader: ReactNode; listWidth?: number;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start", minWidth: 0 }}>
      <div style={{ flex: `1 1 ${listWidth}px`, maxWidth: "100%", minWidth: 0 }}>{list}</div>
      <div style={{
        flex: "2 1 460px", maxWidth: "100%", minWidth: 0,
        border: "1px solid var(--border)", borderRadius: 14,
        background: "var(--bg-secondary)", padding: "16px 18px",
        position: "sticky", top: 12,
      }}>
        {reader}
      </div>
    </div>
  );
}

/** Scrollable list body with the OS card chrome around it. */
export function ListShell({ children, height = "min(64vh, 620px)" }: {
  children: ReactNode; height?: string;
}) {
  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 14, background: "var(--bg-card)",
      overflow: "hidden", display: "grid",
    }}>
      <div style={{ maxHeight: height, overflowY: "auto", overscrollBehavior: "contain" }}>
        {children}
      </div>
    </div>
  );
}

/** One header line in the reading pane: "To  someone@example.com". */
export function HeaderLine({ name, value, mono }: { name: string; value: ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline", minWidth: 0 }}>
      <span style={{ ...label, width: 56, flexShrink: 0 }}>{name}</span>
      <span style={{
        fontSize: 12.5, color: "var(--text-secondary)", wordBreak: "break-word", minWidth: 0,
        fontFamily: mono ? "var(--font-mono, ui-monospace, monospace)" : "inherit",
      }}>
        {value}
      </span>
    </div>
  );
}

/** The circle with a letter in it. A letter we actually know, or a question
 *  mark — never a generated face and never a fake identity. */
export function Avatar({ seedA, seedB, size = 30 }: {
  seedA?: string | null; seedB?: string | null; size?: number;
}) {
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: "50%", flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        background: "var(--accent-glow)", border: "1px solid var(--border)",
        color: "var(--accent)", fontSize: size * 0.42, fontWeight: 700,
      }}
    >
      {initial(seedA, seedB)}
    </span>
  );
}
