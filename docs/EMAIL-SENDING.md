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

## Reading Instantly (campaigns, sends, replies)

Everything the OS shows about Instantly is read-only and goes through
`lib/instantly.ts` `iRequest()`, which refuses any call that is not a read
(GET, or POST `/leads/list`). Instantly API v2 only.

| Route | What | Freshness |
|---|---|---|
| `GET /api/outreach/instantly` | every campaign + totals, focus campaign's sends, leads, sequence | cached 30-60s per server instance |
| `GET /api/outreach/instantly/replies` | who replied, what they said (quoted thread stripped), interest label | cached 20s; `?force=1` skips it |
| `POST /api/webhooks/instantly` | Instantly pushes events here (reply_received etc.) | instant |

Shown on `/activity` (Instantly section, replies first; the board re-checks
every 30s while open) and in the Email hub's cold lane.

Limits: Instantly allows 20 `GET /emails` calls a minute per workspace. The
client spends at most 14 a minute per server instance and serves the last good
answer (labelled with its age) past that, so open tabs cannot get us blocked.

Honest states: no key, key rejected, Instantly down/timeout and rate limited
each come back as a sentence; a number that could not be read shows
"unknown", never 0.

### Webhook (fast path for replies)

Env: `INSTANTLY_WEBHOOK_SECRET` (any random string, 16+ chars). Without it the
route answers 503 and stores nothing. Register in Instantly (Settings >
Integrations > Webhooks, or `POST /api/v2/webhooks`):

- URL: `https://<os-domain>/api/webhooks/instantly`
- Header: `X-Wing-Webhook-Secret: <INSTANTLY_WEBHOOK_SECRET>` (if the UI cannot
  add headers, append `?secret=<INSTANTLY_WEBHOOK_SECRET>` to the URL instead)
- Events: `reply_received` (plus `lead_interested`, `lead_meeting_booked`,
  `auto_reply_received` if wanted)

Events are stored in `instantly_webhook_events` (created on first use over
`OS_DB_URL`) and trigger a phone push. If the webhook is never registered the
OS still shows replies from polling within about 30-50 seconds.
