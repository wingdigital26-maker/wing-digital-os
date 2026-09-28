import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getOsSession, hasLegacyAuth } from "@/lib/osSupabase";
import { dbSelect, dbPatch } from "@/lib/restOrPooler";
import { makeUnsubToken, isEmailSuppressed } from "@/lib/email";
import { isPhoneSuppressed } from "@/lib/sms";
import { reviewMessage, paceFor, inSendWindow } from "@/lib/clientBrands";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/reviews/send: the delivery step for review requests. It turns
// QUEUED review rows (migration 0027) into actual texts/emails, one client
// customer at a time, in the CLIENT's name, ONLY when armed.
//
// GATES, in order. Any one of them closed means nothing is sent:
//   1. REVIEWS_SEND_ENABLED must be exactly "1" (unset in prod today). While
//      off, the route sends nothing and never calls a send route.
//   2. Send window: 10am to 7pm Central (noon on Sunday). Outside it, hold.
//   3. Per-client pace (lib/clientBrands paceFor): default 1 a day and 3 a
//      week per client, counted from reviews already requested. Google pauses a
//      whole profile on a review spike, so a backlog drips out over weeks.
//   4. Per-client config: no brand entry or no real review link = held.
//   5. The internal send routes' own gates: provider configured, suppression
//      (revoked consent or do_not_contact), ledger written before sending.
//
// Row outcomes:
//   requested  delivered by the send route
//   dismissed  can never be sent (no contact, contact belongs to another
//              client, do_not_contact, no usable phone/email, recipient opted
//              out). Dismissing stops a dead row blocking the queue forever.
//   queued     held: switch off, outside the window, client at its pace cap,
//              client config missing, or a provider problem. Retried next run.
//
// Body (all optional): { client_slug?, limit?, dry_run? }
//   dry_run: true renders exactly what each customer would receive and applies
//   every gate except the switch and the window, and sends and writes NOTHING.
// Auth: staff OS session OR x-heartbeat-key = HEARTBEAT_KEY. Not public in
// proxy.ts, so a scheduler needs a staff session or a proxy allowlist entry.
// Reads and writes go REST first, then the direct pooler on a 402.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAFF = new Set(["admin", "owner", "staff"]);
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

async function authorized(req: NextRequest): Promise<boolean> {
  const machineKey = process.env.HEARTBEAT_KEY;
  if (machineKey && req.headers.get("x-heartbeat-key") === machineKey) return true;
  const session = await getOsSession();
  if (session) return STAFF.has(session.role);
  return await hasLegacyAuth();
}

type ReviewRow = {
  id: number;
  client_slug: string;
  contact_id: number | null;
  channel: string;
  status: string;
  notes: string | null;
};

type ContactRow = {
  id: number;
  client_slug: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  do_not_contact: boolean | null;
};

// US E.164 or null. A value we cannot trust is never texted.
function toE164(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\+1\d{10}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function firstName(c: ContactRow): string {
  const n = (c.contact_name ?? "").trim().split(/\s+/)[0] ?? "";
  // A first name only if it looks like one; otherwise the neutral "there".
  return /^[A-Za-z][A-Za-z'.-]{0,29}$/.test(n) ? n.charAt(0).toUpperCase() + n.slice(1) : "there";
}

type Outcome = {
  review_id: number;
  client_slug: string;
  result: "sent" | "would_send" | "dismissed" | "held";
  channel?: "sms" | "email";
  reason?: string;
  preview?: { to: string; subject?: string; body: string; from_name?: string };
};

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    client_slug?: unknown;
    limit?: unknown;
    dry_run?: unknown;
  };
  const dryRun = body.dry_run === true;

  let clientFilter = "";
  if (body.client_slug !== undefined && body.client_slug !== null && body.client_slug !== "") {
    const slug = String(body.client_slug).toLowerCase();
    if (!SLUG_RE.test(slug)) {
      return NextResponse.json(
        { ok: false, error: "client_slug must be lowercase letters, digits, and dashes." },
        { status: 400 }
      );
    }
    clientFilter = `client_slug=eq.${encodeURIComponent(slug)}&`;
  }

  let limit = DEFAULT_LIMIT;
  if (body.limit !== undefined) {
    const n = Number(body.limit);
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), MAX_LIMIT);
  }

  let queued: ReviewRow[];
  try {
    queued = await dbSelect<ReviewRow>(
      "reviews",
      `select=id,client_slug,contact_id,channel,status,notes&${clientFilter}status=eq.queued&order=created_at.asc,id.asc&limit=${limit}`
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "Could not read queued review requests.", detail: String(e).slice(0, 300) },
      { status: 502 }
    );
  }

  // Gate 1: the dedicated arming switch. The send routes deliver the moment
  // provider creds exist (they do in production), so this is the real gate.
  if (!dryRun && process.env.REVIEWS_SEND_ENABLED !== "1") {
    return NextResponse.json({
      ok: true, sent: 0, held: queued.length, dismissed: 0,
      reason: "Review sending is turned off. Set REVIEWS_SEND_ENABLED=1 once SMS verification is approved to arm it.",
    });
  }
  // Gate 2: the send window.
  if (!dryRun && !inSendWindow()) {
    return NextResponse.json({
      ok: true, sent: 0, held: queued.length, dismissed: 0,
      reason: "Outside the send window (10am to 7pm Central, noon on Sunday). Nothing sent.",
    });
  }

  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const origin = `${proto}://${host}`;
  const heartbeatKey = process.env.HEARTBEAT_KEY ?? "";

  // Gate 3: how many asks each client already has out in the last day / week.
  const budget = new Map<string, { day: number; week: number }>();
  const weekAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
  async function remaining(slug: string): Promise<number> {
    if (!budget.has(slug)) {
      const rows = await dbSelect<{ requested_at: string }>(
        "reviews",
        `select=requested_at&client_slug=eq.${encodeURIComponent(slug)}` +
          `&status=in.(requested,received)&requested_at=gte.${encodeURIComponent(weekAgo)}&limit=500`
      );
      const dayAgo = Date.now() - DAY_MS;
      budget.set(slug, {
        week: rows.length,
        day: rows.filter((r) => Date.parse(r.requested_at) >= dayAgo).length,
      });
    }
    const used = budget.get(slug)!;
    const pace = paceFor(slug);
    return Math.max(0, Math.min(pace.perDay - used.day, pace.perWeek - used.week));
  }
  function spend(slug: string) {
    const used = budget.get(slug);
    if (used) {
      used.day++;
      used.week++;
    }
  }

  const outcomes: Outcome[] = [];
  const heldClients = new Map<string, string>(); // slug -> why the rest of its rows wait
  let stopReason: string | null = null;

  async function dismiss(r: ReviewRow, reason: string): Promise<void> {
    outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "dismissed", reason });
    if (dryRun) return;
    const stamp = `[${new Date().toISOString().slice(0, 10)}] Not sent: ${reason}`;
    await dbPatch("reviews", `id=eq.${r.id}&status=eq.queued`, {
      status: "dismissed",
      notes: [r.notes, stamp].filter(Boolean).join("\n").slice(-4000),
    }).catch(() => {});
  }

  for (const r of queued) {
    if (stopReason) {
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: stopReason });
      continue;
    }
    const clientHold = heldClients.get(r.client_slug);
    if (clientHold) {
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: clientHold });
      continue;
    }

    if (r.contact_id == null) {
      await dismiss(r, "no contact on the request");
      continue;
    }
    let contact: ContactRow | undefined;
    try {
      contact = (
        await dbSelect<ContactRow>(
          "crm_contacts",
          `select=id,client_slug,contact_name,email,phone,do_not_contact&id=eq.${r.contact_id}&limit=1`
        )
      )[0];
    } catch (e) {
      stopReason = `could not read contacts: ${String(e).slice(0, 160)}`;
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: stopReason });
      continue;
    }
    if (!contact) {
      await dismiss(r, "contact no longer exists");
      continue;
    }
    // Never send one client's ask to a contact filed under another client.
    if (contact.client_slug !== r.client_slug) {
      await dismiss(r, `contact belongs to "${contact.client_slug ?? "none"}", not "${r.client_slug}"`);
      continue;
    }
    if (contact.do_not_contact) {
      await dismiss(r, "contact is marked do_not_contact");
      continue;
    }

    // Channel: the one chosen at intake, falling back to the other if the
    // contact only has that one now.
    const phone = toE164(contact.phone);
    const email = (contact.email ?? "").trim().toLowerCase();
    const emailOk = EMAIL_RE.test(email);
    let channel: "sms" | "email" | null = r.channel === "email" ? (emailOk ? "email" : phone ? "sms" : null) : phone ? "sms" : emailOk ? "email" : null;
    if (!channel) {
      await dismiss(r, "no usable phone number or email");
      continue;
    }

    // Opt-outs, checked here too (the send routes check again), so an
    // unsubscribed person's row is dismissed and a dry run tells the truth.
    const supp = channel === "email" ? await isEmailSuppressed(email) : await isPhoneSuppressed(phone as string);
    if (supp.suppressed) {
      const why = supp.reason ?? "recipient is suppressed";
      if (/failed|errored|unreachable/.test(why)) {
        stopReason = `could not check opt-outs: ${why.slice(0, 160)}`;
        outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: stopReason });
      } else {
        await dismiss(r, why);
      }
      continue;
    }

    // Pace cap for this client. Checked after the row is known to be
    // sendable, so dead rows are dismissed even when the client is capped.
    let left: number;
    try {
      left = await remaining(r.client_slug);
    } catch (e) {
      stopReason = `could not read the pace counters: ${String(e).slice(0, 160)}`;
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: stopReason });
      continue;
    }
    if (left <= 0) {
      const p = paceFor(r.client_slug);
      const why = `pace cap reached (${p.perDay} a day, ${p.perWeek} a week)`;
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: why });
      continue;
    }

    const unsubToken = channel === "email" ? makeUnsubToken(email) : null;
    const unsubLink = unsubToken
      ? `${origin}/api/email/unsubscribe?email=${encodeURIComponent(email)}&token=${unsubToken}`
      : null;
    const msg = reviewMessage(r.client_slug, firstName(contact), unsubLink);
    if (!msg.ok) {
      heldClients.set(r.client_slug, msg.reason);
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: msg.reason });
      continue;
    }
    if (channel === "email" && !msg.emailBody) {
      if (phone) channel = "sms";
      else {
        const why = "no unsubscribe secret on this server, so email cannot go";
        outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: why });
        continue;
      }
    }

    const path = channel === "email" ? "/api/email/send" : "/api/sms/send";
    const payload: Record<string, unknown> =
      channel === "email"
        ? {
            to: email,
            subject: msg.emailSubject,
            body: msg.emailBody,
            fromName: msg.fromName,
            replyTo: msg.replyTo ?? undefined,
            client_slug: r.client_slug,
            contact_id: contact.id,
          }
        : { to: phone, body: msg.sms, client_slug: r.client_slug, contact_id: contact.id };
    const preview =
      channel === "email"
        ? { to: email, subject: msg.emailSubject, body: msg.emailBody, from_name: msg.fromName }
        : { to: phone as string, body: msg.sms };

    if (dryRun) {
      spend(r.client_slug);
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "would_send", channel, preview });
      continue;
    }

    let resStatus = 0;
    let resOk = false;
    let resError = "";
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-heartbeat-key": heartbeatKey },
        body: JSON.stringify(payload),
        cache: "no-store",
      });
      resStatus = res.status;
      const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      resOk = res.ok && j?.ok === true;
      resError = j?.error ?? "";
    } catch {
      stopReason = "send route unreachable";
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: stopReason });
      continue;
    }

    if (resOk) {
      spend(r.client_slug);
      outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "sent", channel });
      try {
        await dbPatch("reviews", `id=eq.${r.id}`, { status: "requested", requested_at: new Date().toISOString() });
      } catch {
        // It went out but could not be stamped: stop so a retry cannot double-send.
        stopReason = "sent, but the review row could not be stamped requested";
      }
      continue;
    }
    if (resStatus === 403) {
      await dismiss(r, `recipient suppressed (${resError.slice(0, 120)})`);
      continue;
    }
    if (resStatus === 400) {
      await dismiss(r, `send route refused the address or copy (${resError.slice(0, 120)})`);
      continue;
    }
    // 503/401 = provider not configured / gate shut; 502 = provider or ledger
    // problem. Hold everything and stop, so nothing is hammered.
    stopReason = `send route answered ${resStatus}: ${resError.slice(0, 160) || "not delivered"}`;
    outcomes.push({ review_id: r.id, client_slug: r.client_slug, result: "held", reason: stopReason });
  }

  const count = (k: Outcome["result"]) => outcomes.filter((o) => o.result === k).length;
  return NextResponse.json({
    ok: true,
    dry_run: dryRun,
    sent: count("sent"),
    would_send: dryRun ? count("would_send") : undefined,
    held: count("held"),
    dismissed: count("dismissed"),
    ...(stopReason ? { reason: stopReason } : {}),
    outcomes,
  });
}
