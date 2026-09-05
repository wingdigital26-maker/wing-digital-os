// Email plumbing for the OS — two independent lanes, both fail closed.
//
//   1) Direct SMTP (nodemailer) — the INSTANT 1:1 lane. Sends one email right
//      now through a Wing-owned mailbox (the same OUTREACH_SMTP_* Gmail app
//      -password mailboxes smtp_sender.py uses). For CRM replies, appointment
//      confirmations, missed-call follow-ups — anything that must leave the
//      building immediately. Mirrors lib/sms.ts's posture exactly.
//
//   2) Instantly — the COLD-OUTREACH lane. Instantly's API has no "send now"
//      primitive; you add a lead to a campaign and Instantly sends on its own
//      warmed schedule. So this lane ENQUEUES into a campaign, it does not
//      "send". Base URL https://api.instantly.ai/api/v2, Bearer auth.
//
// Env var names (values live in Vercel/local env only, never in code or vault):
//   Direct SMTP:  OUTREACH_SMTP_HOST (default smtp.gmail.com),
//                 OUTREACH_SMTP_PORT (default 587),
//                 OUTREACH_SMTP_1_USER, OUTREACH_SMTP_1_PASS (Gmail App
//                 Password, 16 chars), OUTREACH_SMTP_1_NAME (display name).
//   Instantly:    INSTANTLY_API_KEY, and a campaign id per call (or the
//                 INSTANTLY_DEFAULT_CAMPAIGN fallback).
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { sbUrl, sbService } from "./osSupabase";

// ── House-rule copy guard (Wing rules, ported from SENDING-CONTRACT.md) ──────
// Not a deliverability check — a brand-voice gate. Returns a reason string if
// the copy would violate a hard rule, else null.
export function copyViolation(subject: string, body: string): string | null {
  const both = `${subject}\n${body}`;
  if (/[—–]/.test(both)) return "Contains an em/en dash — Wing copy never uses them.";
  if (/\{[a-z_]+\}/i.test(both)) return "Contains an unrendered {merge_token}.";
  return null;
}

// ── Lane 1: direct SMTP via nodemailer ──────────────────────────────────────

export type SmtpCreds = {
  host: string;
  port: number;
  user: string;
  pass: string;
  name: string;
};

/** null when the mailbox env vars are missing — the caller must say so. Reads
 *  mailbox slot `idx` (default 1), matching smtp_sender.py's numbering. */
export function smtpCreds(idx = 1): SmtpCreds | null {
  const user = (process.env[`OUTREACH_SMTP_${idx}_USER`] || "").trim();
  const pass = (process.env[`OUTREACH_SMTP_${idx}_PASS`] || "").trim();
  if (!user || !pass) return null;
  return {
    host: process.env.OUTREACH_SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.OUTREACH_SMTP_PORT || "587"),
    user,
    pass,
    name: (process.env[`OUTREACH_SMTP_${idx}_NAME`] || "").trim() || user,
  };
}

export const SMTP_NOT_CONFIGURED =
  "SMTP not configured: OUTREACH_SMTP_1_USER and OUTREACH_SMTP_1_PASS (a Gmail " +
  "App Password) must be set on this deployment. Nothing was sent.";

export type SmtpSendResult =
  | { ok: true; messageId: string; from: string }
  | { ok: false; error: string };

/** Send ONE plain-text email now. Never throws. Adds a List-Unsubscribe
 *  header when `unsubscribeMailto` is given (recommended for any commercial
 *  mail; harmless for transactional). */
export async function smtpSend(
  creds: SmtpCreds,
  to: string,
  subject: string,
  body: string,
  opts?: { unsubscribeMailto?: string; unsubscribeUrl?: string; replyTo?: string }
): Promise<SmtpSendResult> {
  const from = `${creds.name} <${creds.user}>`;
  try {
    const transporter = nodemailer.createTransport({
      host: creds.host,
      port: creds.port,
      secure: creds.port === 465, // 465 = implicit TLS, 587 = STARTTLS
      auth: { user: creds.user, pass: creds.pass },
    });
    const headers: Record<string, string> = {};
    // RFC 8058: prefer an https one-click endpoint; include the mailto as a
    // secondary when both are given. List-Unsubscribe-Post signals one-click.
    const parts: string[] = [];
    if (opts?.unsubscribeUrl) parts.push(`<${opts.unsubscribeUrl}>`);
    if (opts?.unsubscribeMailto) parts.push(`<mailto:${opts.unsubscribeMailto}>`);
    if (parts.length) {
      headers["List-Unsubscribe"] = parts.join(", ");
      if (opts?.unsubscribeUrl) {
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
      }
    }
    const info = await transporter.sendMail({
      from,
      to,
      subject,
      text: body, // plain text only — Wing house rule
      replyTo: opts?.replyTo,
      headers,
    });
    return { ok: true, messageId: String(info.messageId || ""), from };
  } catch (e) {
    return {
      ok: false,
      error: `SMTP send failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Lane 2: Instantly campaign enqueue ──────────────────────────────────────

const INSTANTLY_BASE = "https://api.instantly.ai/api/v2";

export function instantlyKey(): string | null {
  return process.env.INSTANTLY_API_KEY || null;
}

export const INSTANTLY_NOT_CONFIGURED =
  "Instantly not configured: INSTANTLY_API_KEY must be set on this deployment. " +
  "Nothing was enqueued.";

export type InstantlyLead = {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  personalization?: string;
  custom_variables?: Record<string, string>;
};

export type InstantlyResult =
  | { ok: true; leadId: string; campaign: string }
  | { ok: false; error: string };

/** Add ONE lead to an Instantly campaign. Instantly then sends on its own
 *  schedule — this is an enqueue, not an immediate send. Never throws. */
export async function instantlyAddLead(
  apiKey: string,
  campaign: string,
  lead: InstantlyLead
): Promise<InstantlyResult> {
  try {
    const r = await fetch(`${INSTANTLY_BASE}/leads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ campaign, ...lead }),
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) {
      const msg =
        (typeof j.message === "string" && j.message) ||
        (typeof j.error === "string" && j.error) ||
        `HTTP ${r.status}`;
      return { ok: false, error: `Instantly rejected the lead: ${msg}` };
    }
    return { ok: true, leadId: String(j.id ?? ""), campaign };
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach Instantly: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Suppression + unsubscribe (opt-out) ─────────────────────────────────────
// The suppression source of truth already exists (migration 0014 + 0004):
//   * public.consent — a REVOKED email consent row (channel='email',
//     revoked_at set) for an address is a hard opt-out.
//   * public.crm_contacts.do_not_contact = true — a manual "never email".
// This module never invents tables; it reads those through the service key.
// FAIL CLOSED: if Supabase is unreachable or the service key is missing we
// cannot prove the address is clear, so we treat it as suppressed.

/** Lowercase + trim an address for stable comparison and HMAC keying. */
function normAddr(addr: string): string {
  return (addr || "").trim().toLowerCase();
}

export type SuppressionResult = { suppressed: boolean; reason: string | null };

/** True if the address must not be emailed: a revoked email-consent row exists
 *  OR a crm_contacts row with that email has do_not_contact=true. Never throws.
 *  Fails closed (suppressed=true) when the backend cannot be reached. */
export async function isEmailSuppressed(addr: string): Promise<SuppressionResult> {
  const email = normAddr(addr);
  if (!email) return { suppressed: true, reason: "empty address" };

  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    return {
      suppressed: true,
      reason: "suppression list unreachable (OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY not set)",
    };
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  // 1) Revoked email consent row for this address (case-insensitive match).
  try {
    const q =
      `select=id&channel=eq.email&revoked_at=not.is.null` +
      `&address=ilike.${encodeURIComponent(email)}&limit=1`;
    const r = await fetch(`${url}/rest/v1/consent?${q}`, { headers, cache: "no-store" });
    if (!r.ok) {
      return { suppressed: true, reason: `suppression check failed (consent HTTP ${r.status})` };
    }
    const rows = (await r.json()) as unknown[];
    if (Array.isArray(rows) && rows.length > 0) {
      return { suppressed: true, reason: "recipient opted out (revoked email consent)" };
    }
  } catch (e) {
    return {
      suppressed: true,
      reason: `suppression check errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // 2) crm_contacts.do_not_contact = true for this email.
  try {
    const q =
      `select=id&do_not_contact=is.true` +
      `&email=ilike.${encodeURIComponent(email)}&limit=1`;
    const r = await fetch(`${url}/rest/v1/crm_contacts?${q}`, { headers, cache: "no-store" });
    if (!r.ok) {
      return { suppressed: true, reason: `suppression check failed (crm_contacts HTTP ${r.status})` };
    }
    const rows = (await r.json()) as unknown[];
    if (Array.isArray(rows) && rows.length > 0) {
      return { suppressed: true, reason: "recipient is marked do_not_contact" };
    }
  } catch (e) {
    return {
      suppressed: true,
      reason: `suppression check errored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { suppressed: false, reason: null };
}

/** The secret keying the unsubscribe HMAC. UNSUB_SECRET, falling back to
 *  HEARTBEAT_KEY. null when neither is set — tokens cannot be made (fail
 *  closed) but isEmailSuppressed still works. */
function unsubSecret(): string | null {
  return process.env.UNSUB_SECRET || process.env.HEARTBEAT_KEY || null;
}

/** HMAC-SHA256 over the lowercased address, hex. null when no secret is set. */
export function makeUnsubToken(addr: string): string | null {
  const secret = unsubSecret();
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(normAddr(addr)).digest("hex");
}

/** Constant-time verify of an unsubscribe token for an address. False on any
 *  missing piece (no secret, empty token) — fail closed. */
export function verifyUnsubToken(addr: string, token: string): boolean {
  const expected = makeUnsubToken(addr);
  if (!expected || !token) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
