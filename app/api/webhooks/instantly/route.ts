import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { recordInstantlyEvent } from "@/lib/instantlyEvents";
import { REPLY_EVENT_TYPES } from "@/lib/instantlyReplies";
import { invalidateInstantly } from "@/lib/instantly";
import { pushToAll } from "@/lib/push";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/webhooks/instantly — Instantly calls this the moment something
// happens in a campaign (above all: reply_received). It is the fast path for
// replies; the OS also polls Instantly's inbox, so nothing depends on it.
//
// AUTH (fails closed). Instantly does not sign webhooks. Instead, when the
// webhook is registered it is given a custom header carrying a shared secret:
//     X-Wing-Webhook-Secret: <INSTANTLY_WEBHOOK_SECRET>
// For Instantly's UI, which may only take a URL, `?secret=<same value>` is
// also accepted. Compared in constant time. If INSTANTLY_WEBHOOK_SECRET is not
// set on the deployment, every call gets 503 and nothing is stored.
//
// WHAT IT DOES: stores the event (lib/instantlyEvents.ts), expires the cached
// inbox read so the next look at the OS refetches, and for a real reply sends
// Jack a phone push ("Reply from ..."). It never replies to anyone, never
// touches a campaign, never calls Instantly back.
//
// Public in proxy.ts (Instantly has no OS login); this secret check is the gate.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 256 * 1024;

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function presentedSecret(req: NextRequest): string | null {
  const h = req.headers.get("x-wing-webhook-secret");
  if (h) return h.trim();
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.nextUrl.searchParams.get("secret");
}

export async function POST(req: NextRequest) {
  const secret = process.env.INSTANTLY_WEBHOOK_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return NextResponse.json({ ok: false, error: "Instantly webhook is not configured on this deployment (INSTANTLY_WEBHOOK_SECRET unset). Nothing was stored." }, { status: 503 });
  }
  const given = presentedSecret(req);
  if (!given || !safeEqual(given, secret)) {
    return NextResponse.json({ ok: false, error: "Bad or missing webhook secret." }, { status: 401 });
  }

  const raw = await req.text();
  if (raw.length > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large." }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "Body is not a JSON object." }, { status: 400 });
  }

  const eventType = typeof body.event_type === "string" ? body.event_type.slice(0, 80) : "";
  if (!eventType) {
    return NextResponse.json({ ok: false, error: "Missing event_type." }, { status: 400 });
  }
  const leadEmail = typeof body.lead_email === "string" ? body.lead_email.slice(0, 320) : null;
  const campaignId = typeof body.campaign_id === "string" ? body.campaign_id.slice(0, 80) : null;

  const { persisted } = await recordInstantlyEvent({
    receivedAt: new Date().toISOString(),
    eventType,
    leadEmail,
    campaignId,
    payload: body,
  });

  if (REPLY_EVENT_TYPES.includes(eventType)) {
    // Next read of the inbox / totals refetches instead of serving the cache.
    invalidateInstantly("GET /emails");
    invalidateInstantly("GET /campaigns/analytics");
  }

  if (eventType === "reply_received" || eventType === "lead_interested" || eventType === "lead_meeting_booked") {
    const who = leadEmail ?? "a lead";
    const snippet = typeof body.reply_text_snippet === "string" ? body.reply_text_snippet : "";
    const title =
      eventType === "reply_received" ? `Reply from ${who}` :
      eventType === "lead_interested" ? `Interested: ${who}` : `Meeting booked: ${who}`;
    // Best effort; a push failure must never make Instantly retry the event.
    // Capped at 3s: Instantly should get its 200 fast whatever the push layer does.
    await Promise.race([
      pushToAll({ title, body: snippet.slice(0, 140), url: "/activity#replies", tag: `instantly-${who}` }).catch(() => null),
      new Promise((r) => setTimeout(r, 3_000)),
    ]);
  }

  return NextResponse.json({ ok: true, stored: true, persisted });
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "POST only. This endpoint receives Instantly webhooks." }, { status: 405 });
}
