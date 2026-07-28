"use client";
// ── Wing Digital OS chart primitives ─────────────────────────────────────────
// Dependency-free inline SVG/CSS charts tuned for the dark command-center theme.
// Used by the Command Center + Sales Overview. No external chart libs.

import React from "react";
import { motion } from "motion/react";

const GROTESK = "'Space Grotesk', sans-serif";

// ── Sparkline ────────────────────────────────────────────────────────────────
export function Sparkline({
  data,
  color = "#22d3ee",
  width = 110,
  height = 34,
}: {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const pad = 3;
  const pts = data.map((v, i) => [
    pad + (i * (width - pad * 2)) / (data.length - 1),
    height - pad - ((v - min) / range) * (height - pad * 2),
  ]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const gid = `spark-${color.replace(/[^a-zA-Z0-9]/g, "")}`;
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8}
        strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.6} fill={color}
        style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
    </svg>
  );
}

// ── Delta badge (▲ / ▼ vs previous period) ──────────────────────────────────
export function Delta({ value, label }: { value: number | null; label?: string }) {
  if (value === null || !Number.isFinite(value)) return null;
  const up = value > 0;
  const flat = value === 0;
  const c = flat ? "#6b7280" : up ? "#34d399" : "#fb7185";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10.5, fontWeight: 700, color: c,
      background: `${c}14`, border: `1px solid ${c}33`,
      padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap",
    }}>
      {flat ? "—" : up ? "▲" : "▼"} {flat ? "0" : Math.abs(value).toLocaleString()}
      {label && <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{label}</span>}
    </span>
  );
}

// ── KPI metric card: big number + delta + sparkline ─────────────────────────
export function KpiCard({
  label,
  value,
  color = "#22d3ee",
  delta = null,
  deltaLabel,
  spark,
  sub,
}: {
  label: string;
  value: string | number;
  color?: string;
  delta?: number | null;
  deltaLabel?: string;
  spark?: number[];
  sub?: string;
}) {
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 26 } } }}
      initial="hidden" animate="show"
      style={{
      background: `radial-gradient(ellipse 90% 70% at 50% -20%, ${color}14, transparent 60%), linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))`,
      border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "16px 18px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
      display: "flex", flexDirection: "column", gap: 10, minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 8px ${color}`, flexShrink: 0 }} />
        <p style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</p>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <p style={{ fontSize: 28, fontWeight: 800, color, fontFamily: GROTESK, lineHeight: 1, textShadow: `0 0 20px ${color}44` }}>{value}</p>
        <Delta value={delta} label={deltaLabel} />
      </div>
      {spark && spark.length > 1 && (
        <Sparkline data={spark} color={color} width={130} height={30} />
      )}
      {sub && <p style={{ fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.4 }}>{sub}</p>}
    </motion.div>
  );
}

// ── Bar chart (daily series) ────────────────────────────────────────────────
export function BarChart({
  data,
  color = "#22d3ee",
  height = 130,
  showEvery = 1,
}: {
  data: { label: string; value: number; hint?: string }[];
  color?: string;
  height?: number;
  showEvery?: number;
}) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map(d => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: height + 32, minWidth: 0 }}>
      {data.map((d, i) => {
        const h = Math.round((d.value / max) * height);
        const isPeak = d.value === max && d.value > 0;
        return (
          <div key={i} title={`${d.hint ?? d.label}: ${d.value}`}
            style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0, cursor: "default" }}>
            <span style={{
              fontSize: 9, fontWeight: 700, fontFamily: GROTESK,
              color: isPeak ? color : "var(--text-muted)",
              opacity: d.value > 0 ? 1 : 0, lineHeight: 1, height: 10,
            }}>{d.value}</span>
            <div style={{
              width: "100%", maxWidth: 26, height: Math.max(h, 3), borderRadius: "5px 5px 2px 2px",
              background: d.value > 0
                ? `linear-gradient(180deg, ${color}, ${color}55)`
                : "rgba(255,255,255,0.05)",
              boxShadow: isPeak ? `0 0 12px ${color}55` : "none",
              transition: "height 0.4s ease",
            }} />
            <span style={{
              fontSize: 8.5, color: "var(--text-muted)", lineHeight: 1, whiteSpace: "nowrap",
              visibility: i % showEvery === 0 ? "visible" : "hidden",
            }}>{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Funnel: horizontal centered bars with stage-to-stage conversion ─────────
export function FunnelChart({
  stages,
}: {
  stages: { label: string; value: number; color: string }[];
}) {
  if (!stages || stages.length === 0) return null;
  const max = Math.max(...stages.map(s => s.value), 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {stages.map((s, i) => {
        const pct = Math.max(s.value / max, 0);
        const conv = i > 0 && stages[i - 1].value > 0
          ? Math.round((s.value / stages[i - 1].value) * 100)
          : null;
        return (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", width: 92, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
            <div style={{ flex: 1, display: "flex", justifyContent: "center", minWidth: 0 }}>
              <div style={{
                width: `${Math.max(pct * 100, 2)}%`, height: 22, borderRadius: 6,
                background: `linear-gradient(90deg, ${s.color}cc, ${s.color}66)`,
                boxShadow: `0 0 14px ${s.color}33`,
                display: "flex", alignItems: "center", justifyContent: "center",
                transition: "width 0.5s ease", minWidth: 34,
              }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#07080f", fontFamily: GROTESK }}>{s.value.toLocaleString()}</span>
              </div>
            </div>
            <span style={{ fontSize: 9.5, fontWeight: 700, color: conv === null ? "transparent" : "var(--text-muted)", width: 40, flexShrink: 0, fontFamily: GROTESK }}>
              {conv === null ? "·" : `${conv}%`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Donut with legend ───────────────────────────────────────────────────────
export function DonutChart({
  segments,
  size = 118,
  thickness = 15,
  centerLabel,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
}) {
  const visible = (segments ?? []).filter(s => s.value > 0);
  const total = visible.reduce((a, s) => a + s.value, 0);
  if (total === 0) return null;
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flexShrink: 0 }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={thickness} />
        {visible.map(s => {
          const frac = s.value / total;
          const dash = `${Math.max(frac * C - 2, 0.5)} ${C}`;
          const off = -acc * C;
          acc += frac;
          return (
            <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={s.color} strokeWidth={thickness} strokeLinecap="round"
              strokeDasharray={dash} strokeDashoffset={off}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} />
          );
        })}
        <text x="50%" y="47%" textAnchor="middle" fill="var(--text-primary)"
          style={{ fontSize: 22, fontWeight: 800, fontFamily: GROTESK }}>{total.toLocaleString()}</text>
        {centerLabel && (
          <text x="50%" y="62%" textAnchor="middle" fill="var(--text-muted)" style={{ fontSize: 8.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>{centerLabel}</text>
        )}
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 120 }}>
        {visible.map(s => (
          <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 8, height: 8, borderRadius: 3, background: s.color, boxShadow: `0 0 6px ${s.color}66`, flexShrink: 0 }} />
            <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1 }}>{s.label}</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--text-primary)", fontFamily: GROTESK }}>{s.value.toLocaleString()}</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)", width: 34, textAlign: "right", fontFamily: GROTESK }}>{Math.round((s.value / total) * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Card shell for chart panels ─────────────────────────────────────────────
export function ChartCard({
  title,
  badge,
  badgeColor = "#22d3ee",
  children,
}: {
  title: string;
  badge?: string;
  badgeColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: "linear-gradient(180deg, var(--bg-card), rgba(12,15,26,0.85))",
      border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: "16px 20px 14px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.04)",
      minWidth: 0,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, gap: 8, flexWrap: "wrap" }}>
        <p style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{title}</p>
        {badge && (
          <span style={{ fontSize: 10, fontWeight: 700, color: badgeColor, background: `${badgeColor}14`, border: `1px solid ${badgeColor}33`, padding: "2px 10px", borderRadius: 999, whiteSpace: "nowrap" }}>{badge}</span>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Helper: build a contiguous daily series from a {YYYY-MM-DD: n} map ──────
export function buildDailySeries(
  byDay: Record<string, number> | undefined | null,
  days = 14
): { date: string; label: string; value: number }[] {
  const out: { date: string; label: string; value: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toLocaleDateString("en-CA"); // local YYYY-MM-DD
    out.push({
      date: key,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      value: byDay?.[key] ?? 0,
    });
  }
  return out;
}
