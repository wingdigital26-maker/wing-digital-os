// Live-truth + provenance layer.
//
// The dashboard's core honesty rule: every number is either LIVE (queried from
// the real source right now) or clearly carries the real age of the snapshot it
// came from, so a stale value can NEVER masquerade as current.
//
// The TRUE source of outreach truth is C:\Users\wjack\ghl-cli\prospects.db
// (sqlite). It is LOCAL (Jack's PC) only. In cloud mode it is unreachable, so
// callers fall back to the vault snapshot BUT must compute staleness from the
// snapshot's real asOf and degrade honestly (see sendsTodayHonest).
//
// This module reads the DB read-only via the Node builtin `node:sqlite`
// (dynamic import so it is never bundled and never breaks the build). It never
// writes anything and never reads or logs secrets.

import fs from "fs";
import { isGithubVault } from "./vaultSource";

export type MetricSource = "live-db" | "live-ghl" | "snapshot";

// Staleness thresholds (hours) per metric family, per the honesty design.
export const STALE_HOURS = {
  outreach: 2, // sends / armed pool
  pipeline: 6, // pipeline / untouched counts
  clients: 48, // MRR / active clients
} as const;

// Armed = intent_score at or above this, not yet emailed. Mirrors the outreach
// engine's activation gate closely enough to report an honest "ready" pool.
const ARMED_MIN = 3;

const DB_PATH =
  process.env.PROSPECTS_DB || "C:\\Users\\wjack\\ghl-cli\\prospects.db";

export interface LiveOutreach {
  asOf: string; // ISO timestamp — these values were true just now
  sendsToday: number;
  pipeline: number;
  emailed: number;
  untouched: number; // status in (new, enriching)
  armed: number; // intent_score >= ARMED_MIN, not yet emailed
  statuses: Record<string, number>;
  recentToday: { name: string; city: string; when: string }[];
}

// True only when the real prospects.db is reachable on this host (local PC).
export function prospectsDbAvailable(): boolean {
  if (isGithubVault()) return false;
  try {
    return fs.existsSync(DB_PATH);
  } catch {
    return false;
  }
}

// Read the live outreach truth straight from prospects.db. Returns null when
// the DB is unreachable (cloud) or node:sqlite is unavailable — callers then
// degrade to the snapshot with honest staleness.
export async function readProspectsLive(): Promise<LiveOutreach | null> {
  if (!prospectsDbAvailable()) return null;
  let DatabaseSync: unknown;
  try {
    // node:sqlite is a Node 22+ builtin, not typed in @types/node ^20.
    // @ts-expect-error - builtin module without bundled type declarations
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return null; // builtin not present on this runtime
  }
  if (typeof DatabaseSync !== "function") return null;
  let db: { prepare: (s: string) => { get: (...a: unknown[]) => any; all: (...a: unknown[]) => any[] }; close: () => void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new (DatabaseSync as any)(DB_PATH, { readOnly: true });
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const one = (sql: string, ...p: unknown[]): number => {
      try {
        return Number(db!.prepare(sql).get(...p)?.c ?? 0) || 0;
      } catch {
        return 0;
      }
    };
    const pipeline = one("SELECT COUNT(*) c FROM prospects");
    const emailed = one("SELECT COUNT(*) c FROM prospects WHERE emailed_at IS NOT NULL AND emailed_at <> ''");
    const sendsToday = one("SELECT COUNT(*) c FROM prospects WHERE emailed_at LIKE ?", today + "%");
    const untouched = one("SELECT COUNT(*) c FROM prospects WHERE status IN ('new','enriching')");
    const armed = one("SELECT COUNT(*) c FROM prospects WHERE intent_score >= ? AND (emailed_at IS NULL OR emailed_at = '')", ARMED_MIN);
    const statuses: Record<string, number> = {};
    try {
      for (const r of db!.prepare("SELECT status, COUNT(*) c FROM prospects GROUP BY status").all())
        statuses[String(r.status ?? "unknown")] = Number(r.c) || 0;
    } catch { /* ignore */ }
    let recentToday: { name: string; city: string; when: string }[] = [];
    try {
      recentToday = db!
        .prepare("SELECT name, city, emailed_at FROM prospects WHERE emailed_at LIKE ? ORDER BY emailed_at DESC LIMIT 40")
        .all(today + "%")
        .map((r) => ({ name: String(r.name ?? ""), city: String(r.city ?? ""), when: String(r.emailed_at ?? "") }));
    } catch { /* ignore */ }
    return { asOf: now.toISOString(), sendsToday, pipeline, emailed, untouched, armed, statuses, recentToday };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch { /* ignore */ }
  }
}

// ── Snapshot provenance helpers ────────────────────────────────────────────

// Pull the snapshot's real asOf out of "_Last updated: 2026-08-10 13:43_" or the
// frontmatter "updated:" field.
export function parseSnapshotAsOf(raw: string | null): string | null {
  if (!raw) return null;
  const m =
    raw.match(/_Last updated:\s*([^_]+)_/) ||
    raw.match(/^updated:\s*["']?([^"'\r\n]+)["']?\s*$/m);
  return m ? m[1].trim() : null;
}

export function asOfToDate(asOf: string | null): Date | null {
  if (!asOf) return null;
  const iso = new Date(asOf);
  if (!isNaN(iso.getTime())) return iso;
  const m = asOf.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? "12"), Number(m[5] ?? "0"));
}

// A snapshot value is stale when older than its family threshold, or when its
// asOf can't be parsed at all (unknown age is treated as stale, never as fresh).
export function isStale(asOf: string | null, thresholdHours: number): boolean {
  const d = asOfToDate(asOf);
  if (!d) return true;
  return Date.now() - d.getTime() > thresholdHours * 3600_000;
}

// True when the snapshot is from a PRIOR calendar day — the exact case where a
// "sent today" count would be yesterday's number masquerading as today's.
export function isPriorDay(asOf: string | null): boolean {
  const d = asOfToDate(asOf);
  if (!d) return true;
  return d.toDateString() !== new Date().toDateString() && d.getTime() < Date.now();
}

function shortWhen(asOf: string | null): string {
  const d = asOfToDate(asOf);
  if (!d) return "unknown";
  return d.toLocaleString("en-US", { month: "short", day: "numeric" });
}

export interface Provenance {
  source: MetricSource;
  asOf: string | null;
  stale: boolean;
}

export interface SendsToday extends Provenance {
  value: number | null; // null = unknown, never a stale prior-day number
  display: string; // e.g. "0 today", "3 today", "unknown - needs PC"
  note: string | null;
}

// The single honest answer for sends-today, used everywhere (tiles, volume
// pills, Da Boss vitals). Live DB is the truth. With only a snapshot: a
// prior-day snapshot renders 0/unknown, NEVER yesterday's confident count.
export function sendsTodayHonest(
  live: LiveOutreach | null,
  outreachRaw: string | null,
  outAsOf: string | null,
): SendsToday {
  if (live) {
    return {
      value: live.sendsToday,
      display: `${live.sendsToday} today`,
      source: "live-db",
      asOf: live.asOf,
      stale: false,
      note: null,
    };
  }
  const snap = outreachRaw?.match(/\*\*Sent today:\*\*\s*([\d,]+)/i)?.[1];
  const snapNum = snap != null ? Number(snap.replace(/,/g, "")) : null;
  if (isPriorDay(outAsOf)) {
    // The bug we are killing: a prior-day count shown as today. Force 0/synced.
    return {
      value: 0,
      display: `0 today (last synced ${shortWhen(outAsOf)})`,
      source: "snapshot",
      asOf: outAsOf,
      stale: true,
      note: "Sender truth lives in prospects.db on Jack's PC. The snapshot is from a prior day, so today's real count is unknown here — connect the PC or run state-sync.",
    };
  }
  // Same-day snapshot: usable but still label its age; stale past the 2h line.
  const stale = isStale(outAsOf, STALE_HOURS.outreach);
  return {
    value: snapNum,
    display: snapNum == null ? "unknown - needs PC" : `${snapNum} today`,
    source: "snapshot",
    asOf: outAsOf,
    stale,
    note: stale ? "From snapshot, older than 2h — may be stale, needs PC to confirm live." : null,
  };
}

// Human "as of" line for a source+asOf pair, e.g.
//   "Live from prospects.db, just now"
//   "From snapshot, 20h old - run state-sync or connect PC"
export function provenanceLine(p: Provenance, subject = "snapshot"): string {
  if (p.source === "live-db") return "Live from prospects.db, just now";
  if (p.source === "live-ghl") return "Live from the GHL API, just now";
  const d = asOfToDate(p.asOf);
  if (!d) return "From snapshot, age unknown - needs PC or state-sync";
  const min = Math.max(0, Math.floor((Date.now() - d.getTime()) / 60000));
  const age = min < 60 ? `${min}m old` : min < 2880 ? `${Math.floor(min / 60)}h old` : `${Math.floor(min / 1440)}d old`;
  return `From ${subject}, ${age}${p.stale ? " - run state-sync or connect PC" : ""}`;
}
