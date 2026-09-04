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
  ("timed out") by the cron. Runs in `waiting` are never touched by this.

## Waits (time-delayed steps)

Schema: `supabase/migrations/0022_workflow_waits.sql` adds `resume_at`,
`next_step` and `context` to `workflow_runs`, plus a partial index on
`resume_at where status = 'waiting'`.

Two action types pause a run instead of doing something:

| action | config | what happens |
| --- | --- | --- |
| `wait` | `{hours}` (number, > 0, at most 1440 = 60 days) | pauses for that long, then continues with the next step |
| `wait_until` | `{field, offset_hours}` (`field` matches `/^[a-z_]{1,40}$/`, `offset_hours` any number, negative = before, positive = after) | pauses until `payload[field] + offset_hours`. If the event payload has no such field, the value is not a time, or the computed instant is already past, the run continues right away and the log says so |

Example: `booking.created` carries `starts_at`; `wait_until {field: "starts_at", offset_hours: -24}`
pauses until a day before the call.

### The `waiting` status

`workflow_runs.status` is free text. The full vocabulary is now
`running | done | failed | skipped | waiting`. When a wait step is reached the
engine patches the run to:

- `status = 'waiting'`
- `resume_at` = when to continue
- `next_step` = the `step_order` of the step AFTER the wait (the wait itself never re-runs)
- `context` = `{ payload: <event payload as it was>, contact_id }`

and stops. The log gets an entry for the wait step ("paused for 24h; continues at ...").
`resume_at` and `next_step` are NULL on every run that is not waiting.

### The resume path

Nothing continues a waiting run except `resumeWaitingRuns()` in
`lib/automations/engine.ts`, which `GET /api/cron/automations` calls right
after `processEvents`. So the cron MUST run on a schedule for delayed steps
to ever happen; the inline path only ever starts them. Its summary comes back
under `resumed` in the cron JSON: `{scanned, resumed, done, failed, skipped, waiting, errors}`.

For each run with `status = 'waiting'` and `resume_at <= now()`:

1. Claim it: `PATCH workflow_runs?id=eq.<id>&status=eq.waiting` with
   `{status: 'running', resume_at: null}`. PostgREST returns the rows it
   updated; zero rows back means another engine claimed it first, so this
   one skips it. That filter is the whole double-resume guard.
2. Re-load the workflow. If it no longer exists the run fails. If it is no
   longer `active` the run is marked `skipped` with the note "workflow paused
   before this step ran", UNLESS the event is a `manual.trigger` (a run you
   started by hand on a draft is allowed to finish, matching how manual runs
   start).
3. Re-load the event and the contact. The payload snapshot in `context`
   replaces the event's payload, so a later edit to the event cannot change
   what the remaining steps see. A contact that has since been deleted is
   noted and the remaining steps run without one.
4. Continue from the first action whose `step_order >= next_step`, with the
   same per-step logging, and end `done` / `failed`. Another wait pauses it
   again (`waiting` counts in the summary). A wait that was the last step
   ends `done`.

A step that fails after a resume fails the run exactly like a step that fails
on the first pass; the send gate is checked again at send time, so a workflow
paused between the wait and the text produces a draft, not a send.

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
| `GET /api/cron/automations` | Bearer `CRON_SECRET` or `x-heartbeat-key` | fails stuck runs, processes up to 50 unprocessed events, resumes up to 50 waiting runs whose wait is over |
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
That interval is also the resolution of a wait: a step due at 09:00 runs on
the first tick after 09:00.
