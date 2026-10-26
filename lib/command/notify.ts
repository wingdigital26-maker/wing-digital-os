// Team texts for the Command Center. Server-only.
//
// Primary: Twilio SMS to Jack, Grant and Dylan.
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (or the OS's existing
//   TWILIO_FROM_NUMBER), plus COMMAND_PHONE_JACK / _GRANT / _DYLAN (E.164).
// Free fallback (used when Twilio is not set, or a text fails):
//   COMMAND_NTFY_TOPIC  push via ntfy.sh (each person subscribes in the free
//                       ntfy app). Optional COMMAND_NTFY_SERVER, default https://ntfy.sh.
//   COMMAND_EMAIL_JACK / _GRANT / _DYLAN  email through the OS's SMTP pipe
//                       (SMTP_* env, lib/email.ts) when that is configured.
//
// OFF until the env is set: with nothing configured, notify() sends nothing,
// says so, and logs the attempt in cc_notifications so nothing is silently lost.
// It never buys or registers anything.
import { smtpCreds, smtpSend } from "../email";
import { withStore } from "./db";
import { USERS, type UserId } from "./team";

type Channel = "sms" | "ntfy" | "email";
export type NotifyOutcome = { channel: Channel; to: string; ok: boolean; detail: string };
export type NotifyResult = { sent: boolean; outcomes: NotifyOutcome[]; off: string | null };

function twilio(): { sid: string; token: string; from: string } | null {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM || process.env.TWILIO_FROM_NUMBER;
  return sid && token && from ? { sid, token, from } : null;
}

export function phoneFor(id: UserId): string | null {
  const v = (process.env[`COMMAND_PHONE_${id.toUpperCase()}`] || "").trim();
  return /^\+\d{10,15}$/.test(v) ? v : null;
}

function emailFor(id: UserId): string | null {
  const v = (process.env[`COMMAND_EMAIL_${id.toUpperCase()}`] || "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
}

/** What is wired, for the Setup screen. Booleans only, never values. */
export function notifyStatus() {
  return {
    twilio: Boolean(twilio()),
    phones: Object.fromEntries(USERS.map((u) => [u, Boolean(phoneFor(u))])) as Record<UserId, boolean>,
    ntfy: Boolean(process.env.COMMAND_NTFY_TOPIC),
    email: Boolean(smtpCreds()) && USERS.some((u) => emailFor(u)),
  };
}

async function sendSms(to: string, body: string): Promise<NotifyOutcome> {
  const t = twilio()!;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${t.sid}:${t.token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ To: to, From: t.from, Body: body }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const j = (await r.json().catch(() => ({}))) as { message?: string; sid?: string };
    return r.ok
      ? { channel: "sms", to, ok: true, detail: `queued ${j.sid ?? ""}`.trim() }
      : { channel: "sms", to, ok: false, detail: `Twilio said: ${j.message ?? `HTTP ${r.status}`}` };
  } catch (e) {
    return { channel: "sms", to, ok: false, detail: `Could not reach Twilio: ${e instanceof Error ? e.message : e}` };
  }
}

async function sendNtfy(title: string, body: string, urgent: boolean): Promise<NotifyOutcome> {
  const topic = process.env.COMMAND_NTFY_TOPIC as string;
  const server = (process.env.COMMAND_NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  try {
    const r = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: "POST",
      // Header values must be Latin-1; a curly quote in a client name would throw.
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ""), Priority: urgent ? "high" : "default", Tags: "wing" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    return { channel: "ntfy", to: "team topic", ok: r.ok, detail: r.ok ? "pushed" : `ntfy HTTP ${r.status}` };
  } catch (e) {
    return { channel: "ntfy", to: "team topic", ok: false, detail: `Could not reach ntfy: ${e instanceof Error ? e.message : e}` };
  }
}

/**
 * Tell the team. Texts every teammate with a number set; falls back to ntfy
 * push and email when texting is off or a text fails. Logged either way.
 */
export async function notifyTeam(
  kind: string,
  title: string,
  body: string,
  opts: { urgent?: boolean; only?: UserId[] } = {}
): Promise<NotifyResult> {
  const who = opts.only ?? USERS;
  const text = `${title}\n${body}`.slice(0, 600);
  const outcomes: NotifyOutcome[] = [];

  if (twilio()) {
    for (const u of who) {
      const to = phoneFor(u);
      if (to) outcomes.push(await sendSms(to, text));
    }
  }
  const smsDelivered = outcomes.some((o) => o.ok);
  const smsFailedOrOff = !twilio() || outcomes.length === 0 || outcomes.some((o) => !o.ok);

  if (smsFailedOrOff && process.env.COMMAND_NTFY_TOPIC) {
    outcomes.push(await sendNtfy(title, body, Boolean(opts.urgent)));
  }
  if (smsFailedOrOff) {
    const smtp = smtpCreds();
    if (smtp) {
      for (const u of who) {
        const addr = emailFor(u);
        if (!addr) continue;
        const r = await smtpSend(smtp, addr, `[Wing] ${title}`, body);
        outcomes.push({ channel: "email", to: addr, ok: r.ok, detail: r.ok ? "sent" : r.error });
      }
    }
  }

  const sent = smsDelivered || outcomes.some((o) => o.ok);
  const off =
    outcomes.length === 0
      ? "Texts are off: no Twilio number, ntfy topic or email is set up yet, so nobody was told. See /command/setup."
      : null;
  await withStore((sql) =>
    sql`insert into cc_notifications (kind, body, result)
        values (${kind}, ${text}, ${sql.json({ sent, off, outcomes: outcomes.map((o) => ({ ...o, to: mask(o.to) })) })})`
  );
  return { sent, outcomes, off };
}

function mask(to: string): string {
  return to.startsWith("+") ? `${to.slice(0, 2)}...${to.slice(-4)}` : to.replace(/^(.).*@/, "$1...@");
}
