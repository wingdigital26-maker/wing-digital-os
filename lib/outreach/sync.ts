// Instantly -> outreach_events. READ-ONLY against Instantly.
//
// Every call goes through the shared client in lib/instantly.ts, which refuses
// anything that is not a read (GET, plus POST /leads/list which is Instantly's
// "list leads"). Nothing here adds a lead, changes a campaign, or touches a
// setting.
//
// One run pulls three things:
//   1. Campaign sends   GET /emails?email_type=sent, newest first, paged until
//                        it reaches what the last run already saw (2h overlap).
//   2. Replies          GET /emails?email_type=received, same paging.
//   3. Lead outcomes    POST /leads/list per campaign: bounced (-1),
//                        unsubscribed (-2), interest labels, opened/clicked.
// All of it is mapped by lib/outreach/mappers.ts and written with a dedupe key,
// so running twice, or the webhook and the poll both seeing one event, never
// double counts.
//
// Budget: GET /emails is capped by Instantly at 20 a minute per workspace; the
// shared client spends at most 10 a minute per server instance. A run uses at
// most SENT_PAGES + REPLY_PAGES of those.
import { fetchCampaigns, iListLeads, iRequest, instantlyKey, type InstantlyEmail } from "@/lib/instantly";
import { mapInstantlyEmail, mapInstantlyLead } from "./mappers";
import type { OutreachStore } from "./store";
import type { OutreachEventInput } from "./types";

const SENT_PAGES = 5;
const REPLY_PAGES = 3;
const OVERLAP_MS = 2 * 3600 * 1000;

export type SyncSummary = {
  ok: boolean;
  at: string;
  campaigns: { id: string; name: string }[];
  pulled: { sent: number; replies: number; leadOutcomes: number };
  written: { inserted: number; skipped: number; stopsApplied: number };
  errors: string[];
  /** A stream stopped at its page cap before reaching the last run's cursor. */
  truncated: string[];
  durationMs: number;
};

export const LAST_SYNC_KEY = "last_sync";

function allowedCampaigns(): Set<string> | null {
  const raw = process.env.OUTREACH_SYNC_CAMPAIGNS?.trim();
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function pullEmails(
  type: "sent" | "received",
  maxPages: number,
  cursorIso: string | null
): Promise<{ ok: true; items: InstantlyEmail[]; newest: string | null; truncated: boolean } | { ok: false; reason: string }> {
  const stopAt = cursorIso ? Date.parse(cursorIso) - OVERLAP_MS : null;
  const items: InstantlyEmail[] = [];
  let after: string | undefined;
  let newest: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const path = `/emails?email_type=${type}&sort_order=desc&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`;
    const r = await iRequest<{ items?: InstantlyEmail[]; next_starting_after?: string }>(path, { force: true, timeoutMs: 10_000 });
    if (!r.ok) {
      if (page === 0) return { ok: false, reason: r.reason };
      // Keep what we have; the cursor is not advanced past it (see caller).
      return { ok: true, items, newest, truncated: true };
    }
    const got = r.data.items ?? [];
    let reachedCursor = false;
    for (const e of got) {
      const t = Date.parse(e.timestamp_email ?? e.timestamp_created ?? "");
      if (Number.isFinite(t) && (!newest || t > Date.parse(newest))) newest = new Date(t).toISOString();
      if (stopAt != null && Number.isFinite(t) && t < stopAt) reachedCursor = true;
      items.push(e);
    }
    after = r.data.next_starting_after;
    if (reachedCursor || !after || got.length < 100) return { ok: true, items, newest, truncated: false };
  }
  return { ok: true, items, newest, truncated: true };
}

export async function runInstantlySync(store: OutreachStore): Promise<SyncSummary> {
  const started = Date.now();
  const at = new Date().toISOString();
  const errors: string[] = [];
  const truncated: string[] = [];
  const summary: SyncSummary = {
    ok: false, at, campaigns: [], pulled: { sent: 0, replies: 0, leadOutcomes: 0 },
    written: { inserted: 0, skipped: 0, stopsApplied: 0 }, errors, truncated, durationMs: 0,
  };

  if (!instantlyKey()) {
    errors.push("INSTANTLY_API_KEY is not set on this deployment, so there is nothing to sync from.");
    summary.durationMs = Date.now() - started;
    await store.setState(LAST_SYNC_KEY, summary).catch(() => null);
    return summary;
  }

  const allow = allowedCampaigns();
  const campaignsR = await fetchCampaigns();
  if (!campaignsR.ok) errors.push(`Campaign list: ${campaignsR.reason}`);
  const campaigns = campaignsR.ok ? campaignsR.data.filter((c) => c.id && (!allow || allow.has(c.id))) : [];
  summary.campaigns = campaigns.map((c) => ({ id: c.id, name: c.name }));
  const campaignIds = new Set(campaigns.map((c) => c.id));
  const inScope = (cid: string | null) => (allow ? Boolean(cid && allow.has(cid)) : true);

  const cursors = (await store.getState<{ sent?: string; received?: string }>("cursors")) ?? {};
  const events: OutreachEventInput[] = [];

  const [sentR, recvR] = [await pullEmails("sent", SENT_PAGES, cursors.sent ?? null), await pullEmails("received", REPLY_PAGES, cursors.received ?? null)];
  const nextCursors = { ...cursors };

  if (sentR.ok) {
    for (const e of sentR.items) {
      const ev = mapInstantlyEmail(e);
      if (ev && ev.eventType === "sent" && inScope(ev.campaignId)) { events.push(ev); summary.pulled.sent++; }
    }
    if (sentR.truncated) truncated.push("sent emails");
    // Only move the cursor when the run reached the old one; otherwise the next
    // run keeps paging back from the top and nothing in the gap is skipped.
    if (sentR.newest && !sentR.truncated) nextCursors.sent = sentR.newest;
  } else errors.push(`Sent emails: ${sentR.reason}`);

  if (recvR.ok) {
    for (const e of recvR.items) {
      const ev = mapInstantlyEmail(e);
      if (ev && (ev.eventType === "replied" || ev.eventType === "auto_replied") && inScope(ev.campaignId)) { events.push(ev); summary.pulled.replies++; }
    }
    if (recvR.truncated) truncated.push("replies");
    if (recvR.newest && !recvR.truncated) nextCursors.received = recvR.newest;
  } else errors.push(`Replies: ${recvR.reason}`);

  const nowIso = new Date().toISOString();
  for (const id of campaignIds) {
    const leads = await iListLeads(id, { force: true, maxPages: 10 });
    if (!leads.ok) { errors.push(`Leads in campaign ${id}: ${leads.reason}`); continue; }
    if ((leads as { truncated?: boolean }).truncated) truncated.push(`leads in campaign ${id}`);
    for (const l of leads.data) {
      const evs = mapInstantlyLead(l, id, nowIso);
      summary.pulled.leadOutcomes += evs.length;
      events.push(...evs);
    }
  }

  summary.written = await store.insertEvents(events);
  await store.setState("cursors", nextCursors);
  summary.ok = errors.length === 0;
  summary.durationMs = Date.now() - started;
  await store.setState(LAST_SYNC_KEY, summary);
  return summary;
}
