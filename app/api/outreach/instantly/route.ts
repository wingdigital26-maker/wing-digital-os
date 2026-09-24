import { NextResponse } from "next/server";
import {
  instantlyKey,
  instantlyCampaignId,
  fetchCampaigns,
  fetchCampaign,
  fetchAnalytics,
  fetchSentEmails,
  fetchLeads,
  describeSchedule,
  htmlToText,
  type InstantlyAnalytics,
  type InstantlyCampaign,
  type InstantlyErrorKind,
} from "@/lib/instantly";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/outreach/instantly -- read-only view of Wing's real Instantly.ai
// cold email: every campaign with its totals, plus the detail (schedule,
// sequence, latest sends, leads queued) for the focus campaign.
//
// The sends happen inside Instantly, so they never touch the local ledger.
// This route proxies the Instantly V2 API server-side (the key never reaches
// the browser). Replies have their own faster route: ./replies.
//
// HONESTY RULES:
//  * READ ONLY. Every call goes through lib/instantly.ts iRequest(), which
//    refuses anything that is not a read.
//  * Always HTTP 200 with `status`:
//      ok            read fine
//      no_campaigns  key works, the workspace has no campaigns
//      no_key        INSTANTLY_API_KEY unset
//      error         Instantly rejected the key / is down / timed out (reason says which)
//    A number we could not read is null, never 0.
//  * Sub-reads (sent mail, leads) degrade on their own and say so in `notes`.
//  * If Instantly fails but we hold an answer from the last 15 minutes, that
//    answer is served with stale:true and the time it was read.
//
// Focus campaign: INSTANTLY_DEFAULT_CAMPAIGN if set and present, else the
// first active campaign, else the first campaign.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Stats = {
  leads: number | null;
  contacted: number | null;
  sent: number | null;
  opens: number | null;
  replies: number | null;
  autoReplies: number | null;
  clicks: number | null;
  bounced: number | null;
  unsubscribed: number | null;
  opportunities: number | null;
};

type CampaignRow = {
  id: string;
  name: string;
  status: number;
  state: string;
  schedule: string | null;
  /** Instantly's own open-tracking switch. Null when the record did not say. */
  openTracking: boolean | null;
  stats: Stats | null;
};

type Payload = {
  status: "ok" | "no_campaigns" | "no_key" | "error";
  available: boolean;
  errorKind: InstantlyErrorKind | null;
  reason: string | null;
  stale: boolean;
  staleReason: string | null;
  checkedAt: string | null;
  campaigns: CampaignRow[];
  totals: Stats | null;
  campaign: { id: string; name: string; status: number; state: string; schedule: string | null } | null;
  stats: Stats | null;
  sequence: Array<{ step: number; delayDays: number; subject: string; body: string }>;
  sent: Array<{ to: string; from: string; at: string; subject: string; body: string }>;
  leads: Array<{ email: string; name: string; company: string; contacted: boolean; replied: boolean }>;
  notes: string[];
};

function empty(status: Payload["status"], reason: string, errorKind: InstantlyErrorKind | null = null): Payload {
  return {
    status, available: false, errorKind, reason, stale: false, staleReason: null, checkedAt: null,
    campaigns: [], totals: null, campaign: null, stats: null, sequence: [], sent: [], leads: [], notes: [],
  };
}

/** Instantly campaign status codes, in words. */
function stateOf(code: number | null | undefined): string {
  switch (code) {
    case 0: return "draft";
    case 1: return "active";
    case 2: return "paused";
    case 3: return "completed";
    case 4: return "running subsequences";
    case -99: return "account suspended";
    case -1: return "accounts unhealthy";
    case -2: return "bounce protect";
    default: return code == null ? "unknown" : `status ${code}`;
  }
}

function statsOf(a: InstantlyAnalytics | undefined): Stats | null {
  if (!a) return null;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const auto = n(a.reply_count_automatic);
  const replies = n(a.reply_count);
  return {
    leads: n(a.leads_count),
    // new_leads_contacted_count is people; contacted_count counts per-step touches.
    contacted: n((a as { new_leads_contacted_count?: number }).new_leads_contacted_count) ?? n(a.contacted_count),
    sent: n(a.emails_sent_count),
    opens: n(a.open_count_unique) ?? n(a.open_count),
    // Human replies: Instantly's reply_count, minus the auto-replies it counted.
    replies: replies == null ? null : Math.max(0, replies - (auto ?? 0)),
    autoReplies: auto,
    clicks: n(a.link_click_count),
    bounced: n(a.bounced_count),
    unsubscribed: n(a.unsubscribed_count),
    opportunities: n(a.total_opportunities),
  };
}

function zeroStats(): Stats {
  return { leads: 0, contacted: 0, sent: 0, opens: 0, replies: 0, autoReplies: 0, clicks: 0, bounced: 0, unsubscribed: 0, opportunities: 0 };
}

function sumStats(rows: (Stats | null)[]): Stats | null {
  const real = rows.filter((r): r is Stats => r != null);
  if (real.length === 0) return null;
  const keys = Object.keys(real[0]) as (keyof Stats)[];
  const out = {} as Stats;
  for (const k of keys) {
    const vals = real.map((r) => r[k]);
    out[k] = vals.some((v) => v == null) ? null : vals.reduce<number>((s, v) => s + (v as number), 0);
  }
  return out;
}

function sequenceFromCampaign(campaign: InstantlyCampaign): Payload["sequence"] {
  const steps = campaign.sequences?.[0]?.steps ?? [];
  return steps.map((step, i) => {
    const variant = step.variants?.[0];
    return {
      step: i + 1,
      delayDays: step.delay ?? 0,
      subject: variant?.subject ?? "",
      body: htmlToText(variant?.body ?? ""),
    };
  });
}

export async function GET() {
  if (!instantlyKey()) {
    return NextResponse.json(empty("no_key", "INSTANTLY_API_KEY is not set on this deployment, so Instantly cannot be read."));
  }

  const [listR, analyticsR] = await Promise.all([fetchCampaigns(), fetchAnalytics()]);
  if (!listR.ok) {
    return NextResponse.json(empty("error", listR.reason, listR.kind));
  }
  const notes: string[] = [];
  const list = listR.data;
  if (list.length === 0) {
    const p = empty("no_campaigns", "Instantly is connected, but this workspace has no campaigns yet.");
    p.available = true;
    p.checkedAt = new Date(listR.at).toISOString();
    return NextResponse.json(p);
  }

  const byId = new Map<string, InstantlyAnalytics>();
  if (analyticsR.ok) {
    for (const a of analyticsR.data ?? []) if (a.campaign_id) byId.set(a.campaign_id, a);
  } else {
    notes.push(`Campaign totals could not be read: ${analyticsR.reason}`);
  }

  const campaigns: CampaignRow[] = list.map((c) => {
    const a = byId.get(c.id);
    // Instantly leaves a campaign out of analytics until it has leads/sends.
    // With analytics readable, that absence is a real zero, not an unknown.
    const stats = a ? statsOf(a) : analyticsR.ok ? zeroStats() : null;
    return {
      id: c.id, name: c.name, status: c.status, state: stateOf(c.status), schedule: describeSchedule(c),
      openTracking: typeof c.open_tracking === "boolean" ? c.open_tracking : null, stats,
    };
  });
  // Active first, then by most sent.
  campaigns.sort((x, y) => (Number(y.status === 1) - Number(x.status === 1)) || ((y.stats?.sent ?? -1) - (x.stats?.sent ?? -1)));

  const wanted = instantlyCampaignId();
  const focus =
    (wanted && list.find((c) => c.id === wanted)) ||
    list.find((c) => c.status === 1) ||
    list[0];
  if (wanted && !list.some((c) => c.id === wanted)) {
    notes.push("INSTANTLY_DEFAULT_CAMPAIGN points at a campaign this key cannot see; showing the first active campaign instead.");
  }

  // Detail for the focus campaign. The list payload already carries the
  // schedule and sequence, but fetch the single record for the full sequence.
  const [detailR, sentR, leadsR] = await Promise.all([
    fetchCampaign(focus.id),
    fetchSentEmails(focus.id, 25),
    fetchLeads(focus.id),
  ]);
  const detail = detailR.ok ? detailR.data : focus;

  const payload: Payload = {
    status: "ok",
    available: true,
    errorKind: null,
    reason: null,
    stale: listR.stale || (analyticsR.ok && analyticsR.stale),
    staleReason: listR.stale ? listR.staleReason ?? null : analyticsR.ok && analyticsR.stale ? analyticsR.staleReason ?? null : null,
    checkedAt: new Date(Math.min(listR.at, analyticsR.ok ? analyticsR.at : listR.at)).toISOString(),
    campaigns,
    totals: sumStats(campaigns.map((c) => c.stats)),
    campaign: { id: focus.id, name: focus.name, status: focus.status, state: stateOf(focus.status), schedule: describeSchedule(detail) },
    stats: campaigns.find((c) => c.id === focus.id)?.stats ?? null,
    sequence: sequenceFromCampaign(detail),
    sent: [],
    leads: [],
    notes,
  };

  if (sentR.ok) {
    payload.sent = (sentR.data.items ?? [])
      .map((e) => ({
        to: e.to_address_email_list ?? "",
        from: e.from_address_email ?? "",
        at: e.timestamp_email ?? e.timestamp_created ?? "",
        subject: e.subject ?? "",
        body: htmlToText(e.body?.html ?? e.body?.text ?? ""),
      }))
      .sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  } else {
    notes.push(`Latest sent emails could not be read: ${sentR.reason}`);
  }

  if (leadsR.ok) {
    payload.leads = leadsR.data.map((l) => ({
      email: l.email ?? "",
      name: [l.first_name, l.last_name].filter(Boolean).join(" ").trim(),
      company: l.company_name ?? "",
      contacted: Boolean(l.timestamp_last_contact),
      replied: (l.email_reply_count ?? 0) > 0,
    }));
  } else {
    notes.push(`Leads in this campaign could not be read: ${leadsR.reason}`);
  }

  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
