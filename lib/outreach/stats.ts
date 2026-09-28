// Pure roll-ups for the /outreach tracking, mailbox health, re-touch pool and
// suppression views. No I/O and type-only imports, so node --test runs it
// straight from source (see lib/outreach/types.ts).
//
// Honesty rules baked in here, not left to the UI:
//   * a rate is null (not 0) when its denominator is 0;
//   * replies are PEOPLE, not messages, and automatic replies never count;
//   * a reply is credited to the last step that person was sent before it.
import type { LeadRow, MailboxState, OutreachEventRow, StopReason } from "./types";

export type DayStat = { date: string; sent: number; replies: number; bounces: number; replyRate: number | null };
export type StepStat = { step: number; sent: number; replies: number; bounces: number; replyRate: number | null };
export type MailboxStat = { mailbox: string; sent: number; replies: number; bounces: number; replyRate: number | null };

export type Tracking = {
  days: DayStat[];
  steps: StepStat[];
  mailboxes: MailboxStat[];
  totals: { sent: number; replies: number; bounces: number; unsubscribes: number; replyRate: number | null; bounceRate: number | null };
  windowDays: number;
};

const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);
const dayKey = (iso: string, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
};

type SentIndex = Map<string, { at: number; step: number | null; mailbox: string | null }[]>;

function indexSends(events: OutreachEventRow[]): SentIndex {
  const idx: SentIndex = new Map();
  for (const e of events) {
    if (e.eventType !== "sent" || !e.contactEmail) continue;
    const list = idx.get(e.contactEmail) ?? [];
    list.push({ at: Date.parse(e.occurredAt), step: e.step, mailbox: e.mailbox });
    idx.set(e.contactEmail, list);
  }
  for (const list of idx.values()) list.sort((a, b) => a.at - b.at);
  return idx;
}

/** The send a reply or bounce answers: the last one to that person at or before `at`. */
function lastSendBefore(idx: SentIndex, email: string | null, at: number) {
  if (!email) return null;
  const list = idx.get(email);
  if (!list) return null;
  let hit: (typeof list)[number] | null = null;
  for (const s of list) {
    if (s.at <= at + 60_000) hit = s;
    else break;
  }
  return hit;
}

export function buildTracking(
  events: OutreachEventRow[],
  opts: { now?: number; windowDays?: number; timeZone?: string } = {}
): Tracking {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 30;
  const tz = opts.timeZone ?? "America/Chicago";
  const since = now - windowDays * 24 * 3600 * 1000;
  // Index every send we hold (not just the window) so a reply today is credited
  // to a step sent before the window opened.
  const idx = indexSends(events);
  const inWindow = events.filter((e) => Date.parse(e.occurredAt) >= since && Date.parse(e.occurredAt) <= now + 60_000);

  const days = new Map<string, { sent: number; repliers: Set<string>; bounces: number }>();
  const steps = new Map<number, { sent: number; repliers: Set<string>; bounces: number }>();
  const boxes = new Map<string, { sent: number; repliers: Set<string>; bounces: number }>();
  const get = <K,>(m: Map<K, { sent: number; repliers: Set<string>; bounces: number }>, k: K) => {
    let v = m.get(k);
    if (!v) { v = { sent: 0, repliers: new Set(), bounces: 0 }; m.set(k, v); }
    return v;
  };

  let unsubscribes = 0;
  const allRepliers = new Set<string>();
  let sent = 0;
  let bounces = 0;

  for (const e of inWindow) {
    const d = dayKey(e.occurredAt, tz);
    const at = Date.parse(e.occurredAt);
    if (e.eventType === "sent") {
      sent++;
      get(days, d).sent++;
      if (e.step != null) get(steps, e.step).sent++;
      if (e.mailbox) get(boxes, e.mailbox).sent++;
    } else if (e.eventType === "replied" && e.contactEmail) {
      const who = e.contactEmail;
      allRepliers.add(who);
      get(days, d).repliers.add(who);
      const src = lastSendBefore(idx, who, at);
      const step = e.step ?? src?.step ?? null;
      if (step != null) get(steps, step).repliers.add(who);
      const box = src?.mailbox ?? e.mailbox;
      if (box) get(boxes, box).repliers.add(who);
    } else if (e.eventType === "bounced") {
      bounces++;
      get(days, d).bounces++;
      const src = lastSendBefore(idx, e.contactEmail, at);
      const step = e.step ?? src?.step ?? null;
      if (step != null) get(steps, step).bounces++;
      const box = e.mailbox ?? src?.mailbox;
      if (box) get(boxes, box).bounces++;
    } else if (e.eventType === "unsubscribed") {
      unsubscribes++;
    }
  }

  return {
    days: [...days.entries()]
      .map(([date, v]) => ({ date, sent: v.sent, replies: v.repliers.size, bounces: v.bounces, replyRate: rate(v.repliers.size, v.sent) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
    steps: [...steps.entries()]
      .map(([step, v]) => ({ step, sent: v.sent, replies: v.repliers.size, bounces: v.bounces, replyRate: rate(v.repliers.size, v.sent) }))
      .sort((a, b) => a.step - b.step),
    mailboxes: [...boxes.entries()]
      .map(([mailbox, v]) => ({ mailbox, sent: v.sent, replies: v.repliers.size, bounces: v.bounces, replyRate: rate(v.repliers.size, v.sent) }))
      .sort((a, b) => b.sent - a.sent),
    totals: { sent, replies: allRepliers.size, bounces, unsubscribes, replyRate: rate(allRepliers.size, sent), bounceRate: rate(bounces, sent) },
    windowDays,
  };
}

// ── mailbox health ──────────────────────────────────────────────────────────

export type MailboxHealth = {
  mailbox: string;
  sent7: number;
  bounces7: number;
  /** null when nothing was sent in 7 days: no rate to report. */
  bounceRate7: number | null;
  complaints7: number;
  paused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  /** ok under 2%, watch 2-3%, high over 3% (the usual cold-email ceiling). */
  level: "ok" | "watch" | "high" | "quiet";
};

export function buildMailboxHealth(
  events: OutreachEventRow[],
  states: MailboxState[],
  opts: { now?: number; mailboxes?: string[] } = {}
): MailboxHealth[] {
  const now = opts.now ?? Date.now();
  const since = now - 7 * 24 * 3600 * 1000;
  const idx = indexSends(events);
  const rows = new Map<string, { sent: number; bounces: number; complaints: number }>();
  const row = (m: string) => {
    let r = rows.get(m);
    if (!r) { r = { sent: 0, bounces: 0, complaints: 0 }; rows.set(m, r); }
    return r;
  };
  for (const m of opts.mailboxes ?? []) row(m.toLowerCase());
  for (const s of states) row(s.mailbox.toLowerCase());
  for (const e of events) {
    const at = Date.parse(e.occurredAt);
    if (at < since) continue;
    if (e.eventType === "sent" && e.mailbox) row(e.mailbox).sent++;
    if (e.eventType === "bounced" || e.eventType === "complaint") {
      const box = e.mailbox ?? lastSendBefore(idx, e.contactEmail, at)?.mailbox ?? null;
      if (!box) continue;
      if (e.eventType === "bounced") row(box).bounces++;
      else row(box).complaints++;
    }
  }
  const stateBy = new Map(states.map((s) => [s.mailbox.toLowerCase(), s]));
  return [...rows.entries()]
    .map(([mailbox, r]) => {
      const st = stateBy.get(mailbox);
      const br = rate(r.bounces, r.sent);
      const level: MailboxHealth["level"] =
        r.sent === 0 ? "quiet" : (br ?? 0) > 0.03 || r.complaints > 0 ? "high" : (br ?? 0) >= 0.02 ? "watch" : "ok";
      return {
        mailbox,
        sent7: r.sent,
        bounces7: r.bounces,
        bounceRate7: br,
        complaints7: r.complaints,
        paused: Boolean(st?.paused),
        pausedReason: st?.pausedReason ?? null,
        pausedAt: st?.pausedAt ?? null,
        level,
      };
    })
    .sort((a, b) => a.mailbox.localeCompare(b.mailbox));
}

// ── re-touch pool ───────────────────────────────────────────────────────────

export type RetouchRow = {
  tenant: string;
  email: string;
  company: string | null;
  contactName: string | null;
  /** Round the lead is on now; the next one is round + 1. */
  round: number;
  lastSentAt: string;
  dueAt: string;
  sentThisYear: number;
  /** Emails still allowed in the rolling 365 days. */
  remaining: number;
  state: "due" | "upcoming" | "capped";
};

export type RetouchRules = {
  intervalDays: number; // ~75
  yearlyCap: number; // 8
  stepsPerRound: number; // emails one round sends
};

export const DEFAULT_RETOUCH: RetouchRules = { intervalDays: 75, yearlyCap: 8, stepsPerRound: 3 };

/**
 * Who is due their next custom round, and when. A stopped lead (any stop,
 * handoff included) is never in the pool. A lead whose next round would push
 * it past the yearly cap is listed as capped, with the date the cap frees up
 * enough room, so the pool never pretends a capped lead is ready.
 */
export function buildRetouchPool(
  leads: LeadRow[],
  sends: Map<string, number[]>,
  opts: { now?: number; rules?: Partial<RetouchRules>; horizonDays?: number } = {}
): RetouchRow[] {
  const now = opts.now ?? Date.now();
  const rules = { ...DEFAULT_RETOUCH, ...(opts.rules ?? {}) };
  const horizon = now + (opts.horizonDays ?? 30) * 24 * 3600 * 1000;
  const yearAgo = (t: number) => t - 365 * 24 * 3600 * 1000;
  const out: RetouchRow[] = [];
  for (const l of leads) {
    if (l.stopReason) continue;
    const times = (sends.get(l.email) ?? []).slice().sort((a, b) => a - b);
    const last = l.lastSentAt ? Date.parse(l.lastSentAt) : times.length ? times[times.length - 1] : NaN;
    if (!Number.isFinite(last)) continue; // never emailed: not a re-touch
    let due = l.nextRoundDue ? Date.parse(l.nextRoundDue) : last + rules.intervalDays * 24 * 3600 * 1000;
    if (!Number.isFinite(due)) due = last + rules.intervalDays * 24 * 3600 * 1000;
    const inYearAt = (t: number) => times.filter((x) => x > yearAgo(t) && x <= t).length;
    const sentThisYear = inYearAt(now);
    let state: RetouchRow["state"] = due <= now ? "due" : "upcoming";
    // If the round would break the cap on its due date, push the date to when
    // enough old sends have aged out, and say it is capped.
    if (inYearAt(Math.max(due, now)) + rules.stepsPerRound > rules.yearlyCap) {
      state = "capped";
      const need = inYearAt(Math.max(due, now)) + rules.stepsPerRound - rules.yearlyCap;
      const inWindow = times.filter((x) => x > yearAgo(Math.max(due, now)));
      const freeing = inWindow[need - 1];
      if (freeing != null) due = Math.max(due, freeing + 365 * 24 * 3600 * 1000 + 1);
    }
    if (state !== "capped" && due > horizon) continue;
    out.push({
      tenant: l.tenant,
      email: l.email,
      company: l.company,
      contactName: l.contactName,
      round: l.currentRound,
      lastSentAt: new Date(last).toISOString(),
      dueAt: new Date(due).toISOString(),
      sentThisYear,
      remaining: Math.max(0, rules.yearlyCap - sentThisYear),
      state,
    });
  }
  const order = { due: 0, upcoming: 1, capped: 2 } as const;
  return out.sort((a, b) => order[a.state] - order[b.state] || Date.parse(a.dueAt) - Date.parse(b.dueAt));
}

// ── suppression ─────────────────────────────────────────────────────────────

export type SuppressionRow = {
  tenant: string;
  email: string;
  company: string | null;
  reason: StopReason;
  at: string | null;
  source: string | null;
  detail: string | null;
};

const PERMANENT = new Set<StopReason>(["unsubscribed", "negative_reply", "spam_complaint", "hard_bounce"]);

export function buildSuppression(leads: LeadRow[]): SuppressionRow[] {
  return leads
    .filter((l) => l.stopReason && PERMANENT.has(l.stopReason))
    .map((l) => ({
      tenant: l.tenant,
      email: l.email,
      company: l.company,
      reason: l.stopReason as StopReason,
      at: l.stoppedAt,
      source: l.stopSource,
      detail: l.stopDetail,
    }))
    .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
}

export function buildHandoffs(leads: LeadRow[]): SuppressionRow[] {
  return leads
    .filter((l) => l.stopReason === "handoff")
    .map((l) => ({ tenant: l.tenant, email: l.email, company: l.company, reason: "handoff" as StopReason, at: l.stoppedAt, source: l.stopSource, detail: l.stopDetail }))
    .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0));
}
