import { NextRequest, NextResponse } from "next/server";
import { logMessage } from "@/lib/sms";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/messages/log — machine ingest for the unified message ledger.
//
// The existing email senders (Apollo lane, the Wing SMTP pipe) POST what they
// sent here so email and SMS live in ONE table and one board. This route only
// RECORDS; it never sends, and adding it changed nothing about how any sender
// behaves — wiring them up is a one-line curl after they send.
//
// Public path in middleware; auth is x-heartbeat-key = HEARTBEAT_KEY, same
// fail-closed contract as /api/heartbeat and /api/notify.
//
// Body: { channel: 'email'|'sms', direction?: 'outbound'|'inbound',
//         to?, from?, body?, status?, client_slug?, contact_id?, provider_sid?, error? }
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const expected = process.env.HEARTBEAT_KEY;
  if (!expected || req.headers.get("x-heartbeat-key") !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "JSON body required" }, { status: 400 });

  const channel = b.channel === "sms" ? "sms" : b.channel === "email" ? "email" : null;
  if (!channel) {
    return NextResponse.json({ error: "channel must be 'sms' or 'email'" }, { status: 400 });
  }
  const direction = b.direction === "inbound" ? "inbound" : "outbound";
  const str = (v: unknown, max = 4000): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

  const { id, error } = await logMessage({
    contact_id: typeof b.contact_id === "number" ? b.contact_id : null,
    client_slug: str(b.client_slug, 80),
    channel,
    direction,
    to_addr: str(b.to, 320),
    from_addr: str(b.from, 320),
    body: str(b.body, 20000),
    status: str(b.status, 40) ?? (direction === "inbound" ? "received" : "sent"),
    provider_sid: str(b.provider_sid, 80),
    error: str(b.error, 1000),
  });
  if (id == null) {
    return NextResponse.json({ ok: false, error }, { status: 502 });
  }
  return NextResponse.json({ ok: true, id });
}
