import { NextResponse } from "next/server";
import {
  instantlyKey,
  instantlyCampaignId,
  fetchCampaign,
  fetchAnalytics,
  fetchSentEmails,
  fetchLeads,
  describeSchedule,
  htmlToText,
  type InstantlyCampaign,
} from "@/lib/instantly";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/outreach/instantly -- read-only view of Jack's real Instantly.ai
// cold-email campaign.
//
// The sends themselves happen inside Instantly's own engine, so they never
// touch the local ledger. This route is the only place the OS can show what
// is actually going out: it proxies the Instantly V2 API server-side (the
// API key never reaches the browser) and reshapes the response into one
// honest payload.
//
// HONESTY RULES:
//  * READ ONLY. This route never posts a lead, never fires a send, never
//    mutates campaign state -- it only calls Instantly GET/list endpoints.
//  * Fails closed: missing env or an unreachable campaign returns
//    available:false with a plain-English reason, HTTP 200, so the UI can
//    render an honest "not connected" state instead of an error boundary.
//  * Individual sub-fetches (analytics, sent emails, leads) degrade on
//    their own -- one failing does not take down the whole payload, only
//    that section comes back empty.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Payload = {
  available: boolean;
  reason: string | null;
  campaign: { id: string; name: string; status: number; schedule: string | null } | null;
  stats: {
    leads: number;
    contacted: number;
    sent: number;
    opens: number;
    replies: number;
    clicks: number;
    bounced: number;
    unsubscribed: number;
  } | null;
  sequence: Array<{ step: number; delayDays: number; subject: string; body: string }>;
  sent: Array<{ to: string; from: string; at: string; subject: string; body: string }>;
  leads: Array<{ email: string; name: string; company: string; contacted: boolean }>;
};

function empty(reason: string): Payload {
  return { available: false, reason, campaign: null, stats: null, sequence: [], sent: [], leads: [] };
}

// Cheap in-memory cache so repeated UI loads inside the same server process
// don't hammer Instantly. Module-level, so it survives across requests but
// not across cold starts/deploys -- fine for a 30s window.
let cache: { at: number; payload: Payload } | null = null;
const CACHE_MS = 30_000;

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
  if (cache && Date.now() - cache.at < CACHE_MS) {
    return NextResponse.json(cache.payload);
  }

  const key = instantlyKey();
  const campaignId = instantlyCampaignId();

  if (!key) {
    return NextResponse.json(empty("INSTANTLY_API_KEY not set"));
  }
  if (!campaignId) {
    return NextResponse.json(empty("INSTANTLY_DEFAULT_CAMPAIGN not set"));
  }

  const campaignR = await fetchCampaign(campaignId);
  if (!campaignR.ok) {
    return NextResponse.json(empty(campaignR.reason));
  }
  const campaign = campaignR.data;

  const payload: Payload = {
    available: true,
    reason: null,
    campaign: {
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      schedule: describeSchedule(campaign),
    },
    stats: null,
    sequence: sequenceFromCampaign(campaign),
    sent: [],
    leads: [],
  };

  // ── Analytics (degrade alone on failure) ──────────────────────────────
  const analyticsR = await fetchAnalytics(campaignId);
  if (analyticsR.ok) {
    const row = analyticsR.data?.[0];
    if (row) {
      payload.stats = {
        leads: row.leads_count ?? 0,
        contacted: row.contacted_count ?? 0,
        sent: row.emails_sent_count ?? 0,
        opens: row.open_count ?? 0,
        replies: row.reply_count ?? 0,
        clicks: row.link_click_count ?? 0,
        bounced: row.bounced_count ?? 0,
        unsubscribed: row.unsubscribed_count ?? 0,
      };
    }
  }

  // ── Actual sent messages (degrade alone on failure) ─────────────────────
  const sentR = await fetchSentEmails(campaignId, 25);
  if (sentR.ok) {
    const items = sentR.data.items ?? [];
    payload.sent = items
      .map((e) => ({
        to: e.to_address_email_list ?? "",
        from: e.from_address_email ?? "",
        at: e.timestamp_created ?? "",
        subject: e.subject ?? "",
        body: htmlToText(e.body?.html ?? e.body?.text ?? ""),
      }))
      .sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  }

  // ── Leads loaded into the campaign (degrade alone on failure) ───────────
  const leadsR = await fetchLeads(campaignId, 50);
  if (leadsR.ok) {
    const items = leadsR.data.items ?? [];
    payload.leads = items.map((l) => ({
      email: l.email ?? "",
      name: [l.first_name, l.last_name].filter(Boolean).join(" ").trim(),
      company: l.company_name ?? "",
      contacted: l.status === 1,
    }));
  }

  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
