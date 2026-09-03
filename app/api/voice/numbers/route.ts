// GET    /api/voice/numbers            staff: tracked numbers + the last 20 calls
// POST   /api/voice/numbers            staff: upsert {number, client_slug?, forward_to?, greeting?, ring_seconds?}
// DELETE /api/voice/numbers?number=    staff: stop tracking a number
//
// A voice_numbers row is what makes /api/voice/inbound answer a Twilio number
// instead of saying "not set up yet". Numbers are E.164 in and E.164 stored.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbDelete,
  errorResponse,
  badRequest,
  nullableText,
  SbError,
} from "../../pipeline/_lib";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { normalizePhone, isE164 } from "@/lib/phone";
import type { VoiceNumberRow } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const numbers = await sbGet<VoiceNumberRow>(
      "voice_numbers",
      "number,client_slug,forward_to,greeting,ring_seconds,created_at",
      "order=created_at.desc&limit=200"
    );
    const calls = await sbGet(
      "phone_calls",
      "id,provider_sid,contact_id,client_slug,direction,from_number,to_number,status,duration_sec,started_at,ended_at,crm_contacts(id,business_name)",
      "order=started_at.desc&limit=20"
    );
    return NextResponse.json({ ok: true, numbers, calls });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON.");
  }

  const number = normalizePhone(body.number).e164;
  if (!number) return badRequest("number must be a phone number in E.164 form, like +12145550100.");

  let forwardTo: string | null = null;
  if (body.forward_to !== undefined && nullableText(body.forward_to) !== null) {
    forwardTo = normalizePhone(body.forward_to).e164;
    if (!forwardTo) return badRequest("forward_to must be a phone number in E.164 form, or empty.");
  }

  const clientSlug = nullableText(body.client_slug);
  if (clientSlug && !/^[a-z0-9-]{1,60}$/.test(clientSlug)) {
    return badRequest("client_slug must be lowercase letters, digits, and dashes.");
  }

  let ring = 20;
  if (body.ring_seconds !== undefined && body.ring_seconds !== null && body.ring_seconds !== "") {
    const n = Number(body.ring_seconds);
    if (!Number.isInteger(n) || n < 5 || n > 60) return badRequest("ring_seconds must be a whole number from 5 to 60.");
    ring = n;
  }

  const row = {
    number,
    client_slug: clientSlug,
    forward_to: forwardTo,
    greeting: nullableText(body.greeting)?.slice(0, 500) ?? null,
    ring_seconds: ring,
  };

  // Upsert on the primary key: PostgREST merge-duplicates. Done with a direct
  // fetch because the shared sbPost helper has no place for the Prefer header.
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return errorResponse(new SbError("CRM database is not configured on this deployment.", 503));
  }
  try {
    const r = await fetch(`${url}/rest/v1/voice_numbers?on_conflict=number`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
      cache: "no-store",
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return errorResponse(new SbError(`Saving the number failed (${r.status}).`, 502, detail.slice(0, 500) || null));
    }
    const rows = (await r.json()) as VoiceNumberRow[];
    return NextResponse.json({ ok: true, number: rows[0] ?? row });
  } catch (e) {
    return errorResponse(new SbError("Could not reach the CRM database.", 502, String(e)));
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const number = new URL(req.url).searchParams.get("number") ?? "";
  if (!isE164(number)) return badRequest("number must be in E.164 form, like +12145550100.");
  try {
    const rows = await sbDelete<{ number: string }>("voice_numbers", `number=eq.${encodeURIComponent(number)}`);
    if (!rows.length) {
      return NextResponse.json({ error: "not_found", message: "That number is not tracked." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, deleted: rows[0].number });
  } catch (e) {
    return errorResponse(e);
  }
}
