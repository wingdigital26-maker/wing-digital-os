import { NextResponse } from "next/server";
import { twilioCreds } from "@/lib/sms";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/sms/health — "what is going on with Twilio", honestly.
//
// Session-gated by middleware like every other /api/* route (this path is NOT
// on the middleware exempt list). Reports:
//  * which TWILIO_* env vars are present (booleans + the from-number ONLY —
//    the SID and auth token values are never returned, logged, or hinted at)
//  * if configured, a live ping of the Twilio REST API: account status, and
//    whether the from-number's inbound webhook points at /api/sms/inbound
//  * if not configured, nothing is pinged and the client shows setup steps.
//
// Read-only. Nothing here sends, and a Twilio outage renders as an honest
// error string, never as "healthy".
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Check =
  | { ok: true; detail: string }
  | { ok: false; detail: string };

async function twilioGet(sid: string, token: string, path: string): Promise<
  { ok: true; json: Record<string, unknown> } | { ok: false; error: string }
> {
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
      headers: { Authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") },
      cache: "no-store",
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg = typeof j.message === "string" ? j.message : `HTTP ${r.status}`;
      return { ok: false, error: msg };
    }
    return { ok: true, json: j };
  } catch (e) {
    return { ok: false, error: `Could not reach Twilio: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function GET() {
  const env = {
    TWILIO_ACCOUNT_SID: Boolean(process.env.TWILIO_ACCOUNT_SID),
    TWILIO_AUTH_TOKEN: Boolean(process.env.TWILIO_AUTH_TOKEN),
    TWILIO_FROM_NUMBER: Boolean(process.env.TWILIO_FROM_NUMBER),
  };
  const creds = twilioCreds();

  if (!creds) {
    return NextResponse.json({
      configured: false,
      env,
      fromNumber: process.env.TWILIO_FROM_NUMBER ?? null,
      account: null,
      webhook: null,
      note:
        "Twilio is not configured on this deployment, so the SMS pipe can neither send nor receive. " +
        "No Twilio API call was made.",
    });
  }

  // Live checks — both may fail independently and each failure is reported as
  // itself, never folded into the other.
  const [acct, nums] = await Promise.all([
    twilioGet(creds.sid, creds.token, ".json"),
    twilioGet(
      creds.sid,
      creds.token,
      `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(creds.from)}`
    ),
  ]);

  let account: Check;
  if (acct.ok) {
    const status = String(acct.json.status ?? "unknown");
    const type = String(acct.json.type ?? "unknown");
    account = {
      ok: status === "active",
      detail: `Twilio account status: ${status} (${type === "Trial" ? "TRIAL account — trial accounts can only text verified numbers" : `type ${type}`}).`,
    };
  } else {
    account = { ok: false, detail: `Account check failed: ${acct.error}` };
  }

  let webhook: Check;
  if (nums.ok) {
    const list = Array.isArray(nums.json.incoming_phone_numbers)
      ? (nums.json.incoming_phone_numbers as Record<string, unknown>[])
      : [];
    if (!list.length) {
      webhook = {
        ok: false,
        detail: `Twilio does not list ${creds.from} as a number owned by this account. Replies to it cannot reach the OS.`,
      };
    } else {
      const smsUrl = String(list[0].sms_url ?? "");
      const pointsHere = smsUrl.includes("/api/sms/inbound");
      webhook = pointsHere
        ? { ok: true, detail: `${creds.from} inbound webhook points at ${smsUrl} — replies will land in the ledger.` }
        : {
            ok: false,
            detail: smsUrl
              ? `${creds.from} inbound webhook points at ${smsUrl}, NOT at this app's /api/sms/inbound — replies are going somewhere else.`
              : `${creds.from} has NO inbound SMS webhook set — replies are being dropped by Twilio.`,
          };
    }
  } else {
    webhook = { ok: false, detail: `Number check failed: ${nums.error}` };
  }

  return NextResponse.json({
    configured: true,
    env,
    fromNumber: creds.from,
    account,
    webhook,
    note: "Env vars are set. The account and webhook results above are live from the Twilio API, checked just now.",
  });
}
