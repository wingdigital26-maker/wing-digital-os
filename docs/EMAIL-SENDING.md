# Email + SMS sending from the OS

As of 2026-09-05 the OS can send directly. Three routes, all fail closed, all
log to the unified `messages` ledger BEFORE touching a provider, none of them
fire automatically — every send is a deliberate call (staff session or the
`x-heartbeat-key` machine key).

> Note: `docs/SENDING-CONTRACT.md` says "the OS never sends email." That is
> still true of `/api/outbound/export` specifically (a read-only queue). The
> routes below are a separate, deliberate sending surface.

## Lanes

| Route | Transport | Timing | Use for |
|-------|-----------|--------|---------|
| `POST /api/sms/send` | Twilio | immediate | any text |
| `POST /api/email/send` | SMTP (nodemailer, Wing Gmail mailbox) | immediate | 1:1 replies, confirmations, follow-ups |
| `POST /api/email/campaign` | Instantly | on Instantly's schedule (enqueue only) | cold outreach sequences |

Instantly has no "send now" primitive — `/api/email/campaign` adds a lead to a
campaign and Instantly sends on its own warmed schedule. Ledger status is
`enqueued`, deliberately distinct from `sent`.

## Env vars (Vercel + local .env; never in code or vault)

**SMS (Twilio):** `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`,
`TWILIO_API_KEY_SECRET`, `TWILIO_FROM_NUMBER`, `TWILIO_WEBHOOK_KEY`.
Requires A2P 10DLC registration for US business texting to actually deliver.

**Direct email (SMTP):** `OUTREACH_SMTP_1_USER`, `OUTREACH_SMTP_1_PASS`
(Gmail App Password, 16 chars), `OUTREACH_SMTP_1_NAME`, and optionally
`OUTREACH_SMTP_HOST` (default smtp.gmail.com) / `OUTREACH_SMTP_PORT` (587).
Reuses the exact mailbox scheme `ghl-cli/smtp_sender.py` uses.

**Cold email (Instantly):** `INSTANTLY_API_KEY`, plus a campaign id per call
or `INSTANTLY_DEFAULT_CAMPAIGN`.

## Copy guard

`/api/email/send` and the personalization on `/api/email/campaign` reject em/en
dashes and unrendered `{tokens}` before sending (Wing house rules). `text` is
sent plain-text only.
