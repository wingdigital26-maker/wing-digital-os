# Automations: the trigger-to-action contract

The automation layer is three things: a table of facts (`events`), a table of
rules (`workflows` + `workflow_actions`), and an engine that turns one into
the other (`lib/automations/engine.ts`). Schema: `supabase/migrations/0021_automations.sql`.
Shared vocabulary: `lib/automations/types.ts`. Import from it; never redefine.

## Event vocabulary

| type | emitted when | payload keys the engine understands |
| --- | --- | --- |
| `form.submitted` | a public form posts | `form_slug`, `email`, `phone`, `name`, `first_name`, `last_name`, `business_name`, `company`, `city`, any other field |
| `contact.created` | a crm_contacts row is created | `email`, `phone`, `business_name` |
| `booking.created` | the public booking page books a call | `email`, `phone`, `name` |
| `sms.received` | an inbound text that is not STOP or HELP | `phone`, `body` |
| `call.missed` | a tracked number rang out | `phone` |
| `call.logged` | a caller marks an outcome in the Call Room | `outcome` |
| `deal.stage_changed` | a deal moves | `stage_key`, `deal_id` |
| `task.completed` | a task is marked done via `/api/automations/tasks` | `task_id`, `title` |
| `manual.trigger` | staff press Run | `workflow_id` (runs only that workflow) |

`client_slug` on an event says which client the fact belongs to. `null` means Wing itself.

## Emitting

```ts
import { emitEvent, emitEventAsync } from "@/lib/automations/emit";

const r = await emitEvent({
  type: "form.submitted",
  client_slug: form.client_slug,
  payload: { form_slug: form.slug, ...submission },
});
// r = { id: 123, error: null, processed: { scanned, matched_runs, done, failed, skipped, errors } }
```

`emitEvent` inserts the row, then runs the engine on that one event inline in
the same request, so a Vercel function handles its own consequences. An engine
failure never breaks the emitting route: `id` is still returned, `error`
explains, and the cron catches the event up later.

`emitEventAsync` is for routes that must answer fast (Twilio TwiML). It awaits
the insert, gives the engine 4 s, then returns regardless. Nothing is recorded
on timeout; the cron finishes the job.

Never emit an event before the fact it describes has been stored. Never emit
from inside an engine action (loops).

## Contact resolution

If the event has `contact_id`, that contact is used. Otherwise the engine
looks in the payload for `email` (case-insensitive) then `phone` (normalized
to E.164) and searches `crm_contacts`. If nothing matches and the payload has
at least one of email, phone, or business_name, a contact is CREATED with
`source = event.type` and `source_ref = "<type>:<event id>"`. The event row is
patched with the resolved id. With no identity at all, the contact stays null
and any action that needs one is logged as skipped, not failed.

## Matching

A workflow fires when all of these hold:

1. `status = 'active'` (except manual triggers naming it by id, which run
   whatever the status, so drafts can be tested).
2. `trigger_type = event.type`.
3. Client scope matches exactly: a workflow with `client_slug` set fires only
   for events with that same slug. A workflow with `client_slug = null` fires
   only for events with `client_slug = null`. There is no wildcard; one
   client's automation can never touch another client's leads.
4. Every key in `trigger_filter` matches `payload[key]` as a case-insensitive
   string compare, except `contains`, which is a substring test on `payload.body`.

## Idempotency

- `workflow_runs` has `UNIQUE (workflow_id, event_id)`. The run row is inserted
  with status `running` BEFORE any action executes. A conflict on that insert
  means the event already fired the workflow; the engine skips it. Inline
  processing and the cron can overlap safely.
- Events are marked `processed_at` after every matching workflow has been
  evaluated, even when zero matched. A crash before that leaves the event
  unprocessed and the cron retries it; already-created runs are skipped.
- Actions stop on the first failure. The run is marked `failed` with the
  error, and `log` shows every step that ran and what it did.
- `add_tag` and `enroll_sequence` treat duplicates as skipped, not failed.
- Runs stuck in `running` for more than 10 minutes are marked `failed`
  ("timed out") by the cron.

## The send gate

`send_sms` actually sends only when ALL of these hold:

1. `AUTOMATION_SEND_ENABLED=1` on the deployment
2. the workflow is `active`
3. a contact exists and `do_not_contact` is false
4. no `consent` row with `channel = 'sms'` and `revoked_at` set exists for
   that phone (or that contact)
5. `twilioCreds()` is non-null (Twilio env vars present)
6. the destination (`contact.phone`, else `payload.phone`) is E.164

Otherwise the message is written to `messages` with `status = 'draft'` and the
reason in `error`: "sending is switched off on this deployment", "workflow is
not active", "no contact", "contact opted out", "no phone number", "Twilio not
configured". The run log says which.

When it does send, the ledger row is written first (status `queued`), then
Twilio is called, then the row is patched with the SID and status or the
failure. Status callbacks go to `PUBLIC_BASE_URL` (or
`NEXT_PUBLIC_BASE_URL`) + `/api/sms/status?k=TWILIO_WEBHOOK_KEY`.

`send_email` is ALWAYS a draft (no sending domain exists yet). `enroll_sequence`
writes an enrollment row and sends nothing; the sequence sender decides.

## Merge tags

`{{first_name}}` `{{company}}` `{{business}}` `{{phone}}` `{{email}}` `{{city}}`

`first_name` comes from the contact name's first token, else `payload.first_name`,
else "there". Every other tag has no fallback: an unresolved tag is left in
place and named in the run log. The engine never invents a company or a city.

## Endpoints

| route | who | does |
| --- | --- | --- |
| `GET /api/cron/automations` | Bearer `CRON_SECRET` or `x-heartbeat-key` | fails stuck runs, processes up to 50 unprocessed events |
| `POST /api/automations/run` | staff | `{workflow_id, contact_id}` manual run; `{event_id}` re-process |
| `GET /api/automations/runs` | staff | last 100 runs with workflow + event embedded, `?workflow_id=`, plus `unprocessed_events` |
| `GET/POST/PATCH /api/automations/tasks` | staff | open tasks; create; `{id, done}` (done emits `task.completed`) |
| `GET/POST/DELETE /api/automations/tags` | staff | tags on a contact |

## Cron

Add to the GitHub Actions cloud watchdog workflow (runs PC-off):

```yaml
      - name: Automations catch-up
        run: |
          curl -fsS -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}" \
            "https://<your-vercel-domain>/api/cron/automations"
```

Every 5 to 15 minutes is plenty; the inline path handles the normal case.
