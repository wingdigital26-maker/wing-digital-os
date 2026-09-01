# Sequences Contract

How an external sender consumes the OS sequence engine. Companion to
`SENDING-CONTRACT.md` — same principle: **the OS never sends email.** It
stores sequences (ordered email steps with waits), tracks who is enrolled and
which step is due, and renders the merge tags. Your sender does the actual
sending and reports back per send so the OS can advance the person to the
next step.

## Auth

Same key and same shape as `/api/outbound/export`:
`Authorization: Bearer <OUTBOUND_EXPORT_KEY>` (preferred) or `?k=<key>`.
Fail-closed: if the env var is unset, or the key is wrong, every request gets
`401 { "error": "unauthorized" }`. Ask Jack for the key; it is not committed.

## GET /api/sequences/due

Returns every enrollment whose next email is due right now. A row appears
only when ALL of these hold:

- the enrollment's `status` is `active`
- its `next_send_at` is `<=` now
- the parent sequence's `status` is `active` (paused or draft sequences
  export nothing, no matter how overdue their people are)

Response:

```json
{
  "count": 1,
  "generated_at": "2026-09-01T15:00:00.000Z",
  "items": [
    {
      "enrollment_id": "uuid",
      "sequence_id": "uuid",
      "sequence": "Wing B2B Cold Outreach",
      "client_slug": null,
      "step_order": 2,
      "channel": "email",
      "to": "owner@example.com",
      "name": "Jane Doe",
      "company": "Acme Logistics",
      "subject": "a couple things on Acme Logistics",
      "body": "Hi Jane,\n\n...",
      "due_at": "2026-09-01T14:00:00.000Z",
      "unresolved_tags": []
    }
  ],
  "anomalies": []
}
```

`subject` and `body` arrive fully rendered: `{{first_name}}` (falls back to
"there"), `{{company}}`, `{{city}}`. **If `unresolved_tags` is non-empty, do
NOT send that row** — a tag had no data for this person (there is currently no
city field on enrollments, so any template using `{{city}}` will always land
here). Hold it and flag it to Jack.

`anomalies` lists enrollments that are due but have no matching step (steps
were deleted after enrollment). They carry no message and must not be mailed.

Ordered oldest-due first, max 200 per call. Empty queue is
`{ "count": 0, "items": [] }` with status 200. Poll every few minutes at
most. All of `smtp_sender.py`'s house rules still apply (send window, caps,
warmup, suppression, plain text, unsubscribe) — this feed grants none of that.
Suppression is NOT checked by this endpoint; your sender must check it.

## POST /api/sequences/due — report a send

After each successful send, POST (same auth):

```json
{ "enrollment_id": "uuid", "sent_at": "2026-09-01T15:02:11Z" }
```

`sent_at` is optional (defaults to now). The OS then:

1. increments `current_step` (the step you just sent is now completed),
2. if a next step exists, sets `next_send_at = sent_at + next step's wait_days`,
3. otherwise marks the enrollment `completed` and clears `next_send_at`.

Response echoes the new state:

```json
{ "enrollment_id": "uuid", "current_step": 2, "status": "active", "next_send_at": "2026-09-03T15:02:11Z", "done": false }
```

Rules:

- POST once per send, only after the mail actually left. If you did not send,
  do not POST — the row simply stays due and comes back on the next GET.
- A non-`active` enrollment (someone paused it between your GET and your
  POST) returns 400 and is not advanced. Respect that: the pause won the race.
- POSTing an anomaly's `enrollment_id` (due with no step) marks it
  `completed`, which is the sanctioned way to retire those rows.

## Worked example (3 steps, waits 0 / 2 / 4)

- Enroll Jane → `current_step=0`, `next_send_at=now` (step 1 waits 0 days).
- GET returns step 1. You send, POST → `current_step=1`,
  `next_send_at=sent+2d`.
- Two days later GET returns step 2. Send, POST → `current_step=2`,
  `next_send_at=sent+4d`.
- Four days later GET returns step 3. Send, POST → `current_step=3`,
  `status=completed`, `next_send_at=null`. She never appears in the feed again.
