import { NextRequest, NextResponse } from "next/server";
import { dbSelect, dbInsert } from "@/lib/restOrPooler";
import { verifyUnsubToken } from "@/lib/email";

// ───────────────────────────────────────────────────────────────────────────
// /api/email/unsubscribe — the PUBLIC opt-out endpoint. Recipients reach it
// two ways:
//   * GET  — a person clicks the unsubscribe link in an email. Renders a tiny
//            confirmation page and records the opt-out.
//   * POST — RFC 8058 one-click, fired by the mail client itself when the
//            message carries List-Unsubscribe-Post: List-Unsubscribe=One-Click.
//
// No auth: recipients are not logged in. Trust comes from the signed token
// (HMAC-SHA256 over the lowercased address, keyed by UNSUB_SECRET/HEARTBEAT_KEY)
// which proves Wing generated this link for this exact address. An invalid or
// missing token records nothing and returns 400.
//
// The opt-out is a REVOKED consent row (channel 'email', revoked_at now),
// exactly the shape isEmailSuppressed() reads. Written idempotently: if a live
// revocation already exists for the address we do not add a duplicate.
//
// Privacy: the response never reveals whether the address is known to us. A
// valid token always yields the same "you have been unsubscribed" outcome.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(title: string, message: string, status: number): NextResponse {
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="max-width:480px;margin:64px auto;padding:32px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
<h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;">${esc(title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#3f3f46;">${esc(message)}</p>
</div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/** Write the REVOKED email-consent row, idempotently. Returns null on success
 *  or a reason string. REST first, direct pooler on a 402 (lib/restOrPooler),
 *  so an opt-out is still recorded while the REST layer is restricted. */
async function recordOptOut(email: string, token: string): Promise<string | null> {
  // Idempotency: skip if a live revocation already exists for this address.
  try {
    const rows = await dbSelect<{ id: number }>(
      "consent",
      `select=id&channel=eq.email&revoked_at=not.is.null&address=ilike.${encodeURIComponent(
        email.replace(/([\\%_])/g, "\\$1")
      )}&limit=1`
    );
    if (rows.length > 0) return null; // already opted out
  } catch {
    // fall through to attempt the insert
  }
  try {
    await dbInsert("consent", {
      address: email,
      channel: "email",
      revoked_at: new Date().toISOString(),
      method: "email-unsubscribe",
      proof: token,
    });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function readParams(req: NextRequest): { email: string; token: string } {
  const sp = new URL(req.url).searchParams;
  return {
    email: (sp.get("email") ?? "").trim().toLowerCase(),
    token: (sp.get("token") ?? "").trim(),
  };
}

export async function GET(req: NextRequest) {
  const { email, token } = readParams(req);
  if (!email || !verifyUnsubToken(email, token)) {
    return page(
      "Link not valid",
      "This unsubscribe link is missing or invalid. If you keep receiving mail you did not ask for, reply to the message and we will remove you.",
      400
    );
  }
  const err = await recordOptOut(email, token);
  if (err) {
    return page(
      "Something went wrong",
      "We could not record your request just now. Please reply to the email you received and we will remove you.",
      500
    );
  }
  return page(
    "You have been unsubscribed",
    "You will not receive any more of these emails. It can take a short time for the change to take effect.",
    200
  );
}

// RFC 8058 one-click. The mail client POSTs automatically; respond 200 on
// success with no body. Invalid token => 400, nothing recorded.
export async function POST(req: NextRequest) {
  const { email, token } = readParams(req);
  if (!email || !verifyUnsubToken(email, token)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const err = await recordOptOut(email, token);
  if (err) {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 200 });
}
