# Sending Contract

What the Wing Digital OS guarantees about a row before it reaches you, and
what your sender is expected to do with it. This is the only interface
between Jack's CRM (approval) and your sender (transport). The OS never
sends email and never will from this endpoint — it only exports.

## Endpoint

```
GET https://<os-host>/api/outbound/export
```

Query params:

- `limit` — max rows to return. Default `200`, max `1000`.
- `format` — `jsonl` (default) or `json`.

Auth: `Authorization: Bearer <OUTBOUND_EXPORT_KEY>` header. (`?k=<key>` also
works, matching the OS's existing dashboard-link pattern, but the header is
preferred — it does not end up in logs or browser history.) No key, or the
wrong key, always returns `401 { "error": "unauthorized" }`. There is no
partial or degraded response for a bad key.

## Response shape

### `format=jsonl` (default)

`Content-Type: application/x-ndjson`. One JSON object per line, newest rows
last (ordered oldest-approved-first, `created_at asc`, so a sender working
top-to-bottom naturally clears the oldest backlog first). Empty queue returns
a zero-byte body with status 200, not an error. Row count is also echoed in
the `X-Row-Count` response header.

### `format=json`

`{ "count": <int>, "items": [ <row>, ... ] }`

### Row schema

Every field, every type. `null` means genuinely unknown or not applicable —
never `0`, never `""`. Do not default a `null` to a placeholder value.

| field         | type              | notes |
|---------------|-------------------|-------|
| `id`          | integer           | the `outbound` row id. Stable, not reused. |
| `to`          | string            | recipient email address. Already regex-validated (`^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$`) and non-empty — this is a format check only, not a deliverability guarantee. |
| `subject`     | string            | never empty (rows with an empty subject or body are excluded before export). |
| `body`        | string            | plain text. May contain the prospect's own quoted words; do not add tracking pixels, link wrappers, or HTML — see "House rules" below. |
| `pid`         | integer           | identical to `id`. Present under this name specifically because `ghl-cli/smtp_sender.py`'s batch queue format expects a `pid` field and treats any field besides `to`/`subject`/`body` as pass-through metadata it logs and echoes back. Send this back unchanged in your result report (see below). |
| `client`      | string \| null    | which Wing client this outbound is for. Null has not been observed in practice but is not schema-guaranteed against. |
| `channel`     | string            | always `"email"` in this export — rows for other channels (social replies, etc.) are filtered out before you ever see them. |
| `tier`        | string \| null    | internal priority tag (`hire`, `event`, `signal`, `A`, `B`, `C`, ...). Informational only; do not branch sending logic on it unless Jack asks you to. |
| `created_at`  | ISO 8601 string   | when the draft was created. |
| `reviewed_at` | ISO 8601 string \| null | when a human approved it. Should never be null for a row you receive (the export only includes `status='approved'` rows), but treat null defensively rather than crashing on it. |

## What the OS guarantees

- **A human approved every row.** Every row you receive has `status='approved'`
  in the `outbound` table, set only by a person clicking Approve on the CRM
  board (`app/api/crm/route.ts`, `POST { action: "approve" }`). Nothing
  auto-approves.
- **Address format is already checked.** `to` matches a standard email regex
  and is non-empty. This is NOT a mailbox-existence or deliverability check —
  your sender's own bounce handling still matters.
- **Body and subject are non-empty.** A row with a missing body or subject is
  filtered out before export; you will never receive one.
- **Channel is always email.** Non-email drafts (social replies, etc.) never
  appear in this feed.
- **This endpoint never sends and never mutates.** It is a pure `SELECT`
  against a Postgres view (`outbound_sendable`, see
  `supabase/migrations/0005_outbound_sendable.sql`). Reading it twice returns
  the same rows (until a new one is approved or the state changes elsewhere).

## Open gap: suppression is NOT enforced by this feed

This is the one guarantee this document deliberately does NOT make, and it
matters. Read this before wiring anything to production.

The OS's CRM has a `crm_contacts.do_not_contact` flag, but `crm_contacts`
lives in a **different Supabase project** than `outbound` — Postgres cannot
join across projects, so the export view has no way to filter by it. The
Supabase project `outbound` actually lives in (the "Sonar" project) has **no
suppression table or column at all** for this pipeline — this was searched
for directly and confirmed absent, not assumed.

The only real suppression check today lives client-side, inside
`ghl-cli/smtp_sender.py`'s `SmtpPool.send()` (`is_suppressed()`), reading a
local file (`ghl-cli/outreach_logs/suppression.txt`). That check is real and
already enforced — **if your sender is `smtp_sender.py` itself, or calls
into it, you already have this for free.** If you are building a new sender
that does NOT go through `smtp_sender.py`, you must implement your own
suppression check before sending anything from this feed, or ask Jack for
that file / an equivalent list. Do not treat a row's presence in this export
as proof it is safe to contact — it is proof a human approved the copy, not
proof the recipient hasn't opted out.

Closing this gap properly would mean either replicating suppression into the
Sonar database so the view can filter on it, or having this export cross-check
against `smtp_sender.py`'s suppression file server-side before returning rows.
Neither exists yet. Flag it to Jack if you want it built.

## What your sender must do

1. **Never send outside the copy and pacing rules `smtp_sender.py` already
   enforces**, whether or not you use that module directly: no em dashes, no
   phone numbers in the body, no unrendered merge tokens, business-hours
   send window, warmup ramp per domain, randomized spacing between sends,
   plain text only, `List-Unsubscribe` header, an unsubscribe instruction in
   the body. These are Wing house rules, not suggestions — see
   `ghl-cli/smtp_sender.py`'s module docstring for the exact numbers.
2. **Check suppression yourself** if you are not routing through
   `smtp_sender.py` (see the gap above).
3. **Report back what happened to each row.** There is currently no write-back
   endpoint — the OS cannot mark a row `sent` on your behalf yet, so until one
   exists, tell Jack directly (or write to `smtp_sender.py`'s own send log,
   `ghl-cli/outreach_logs/smtp_sends.jsonl`, which already records this).
   The proposed shape for a future write-back endpoint, for you to build
   against once it exists:

   ```json
   {
     "id": 123,
     "pid": 123,
     "result": "sent",
     "sent_at": "2026-08-27T14:03:00Z",
     "mailbox": "jack@trywingdigital.com",
     "error": null
   }
   ```

   where `result` is one of `sent`, `held`, `failed`, mirroring
   `smtp_sender.py`'s own `SendResult`. This is a proposal only — **no such
   endpoint is implemented**, and none of `outbound`'s columns are written by
   anything in this repo today. Do not build against it as if it exists.

## Rate and cap expectations

- Poll this endpoint at a reasonable interval (every few minutes is plenty —
  approvals happen in human time, not in real time). There is no rate limit
  enforced server-side today, but hammering it is unnecessary and will be
  treated as a bug if it happens.
- Respect `smtp_sender.py`'s own caps regardless of how many rows this feed
  returns: a warming domain sends 10/day, ramping to 15/25/35 over 21 days,
  then up to `OUTREACH_MAX_PER_MAILBOX` (default 40) at steady state, per
  mailbox, not per feed request. A `limit=1000` export is not permission to
  send 1000 emails in one run.
- Send window is business hours, weekdays only (`OUTREACH_SEND_START` /
  `OUTREACH_SEND_END`, default 8-17 local). Outside that window, hold what
  you fetched and try again later — do not queue it for immediate send the
  moment the window opens either; keep the randomized spacing.

## What this document does not cover

- How you get `OUTBOUND_EXPORT_KEY` — ask Jack directly, it is not committed
  anywhere.
- Mailbox credentials (`OUTREACH_SMTP_*_USER/PASS`) — same, ask Jack, never
  committed.
- Anything about the CRM UI or how rows get approved in the first place —
  that is entirely on the OS side and not your concern.
