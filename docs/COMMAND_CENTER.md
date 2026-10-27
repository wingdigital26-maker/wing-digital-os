# Wing Command Center

The team dashboard at `/command`: Jack, Grant and Dylan run Wing from it, on a phone or a laptop.
It lives inside the Wing OS (same deployment, same look), but Grant and Dylan can only open
`/command`, never the rest of the OS.

## Screens

| Screen | Path | What it does |
|---|---|---|
| Home | `/command` | Today at a glance: open problems, overdue roofer check-ins, calls due today, client health counts, at-risk clients, new or changed SEO pages this week, today and this week on the calendar. |
| Clients | `/command/clients` | One card per active client (vault roster plus Roof Command roofers plus clients that went Live in the pipeline): health, last check, plan, MRR, next action, billing, CRM link, SEO posts. |
| Client detail | `/command/clients/<slug>` | Latest automated check, team notes (plan, MRR, CRM link, next action, roofer contact), billing (paid, due, late), report a problem, full history (daily checks, check-ins, problems), vault notes. |
| Daily checks | `/command/checks` | Latest sentinel health page per client, "last checked", missing or more than 36h stale flagged. |
| Cold calls | `/command/calls` | Dylan's list: tap to call, five outcome buttons, notes, next call date (auto-filled per outcome). Meeting booked drops the business into the pipeline. CSV upload. |
| Roofer check-ins | `/command/roofers` | One touch per signed roofer per week: call or text, mood, problems raised. Overdue (7 days) is red. A problem raised becomes a Problem and texts the team. |
| Problems | `/command/problems` | Anyone reports one (client, urgency, text, optional screenshot). Saving texts Jack, Grant and Dylan. Open, Working, Fixed, owner, comments. Morning digest preview and send. |
| Calendar | `/command/calendar` | The shared Wing Team Google Calendar: embed, list of the next two weeks, Add event (direct with the API, otherwise a pre-filled Google Calendar link). |
| Pipeline | `/command/pipeline` | Lead, Meeting, Proposal, Signed, Onboarding, Live. Signed starts the day 0 to 14 onboarding checklist; Live makes the deal a client card. |
| SEO | `/command/seo` | Per client: live pages from the site's sitemap, new or changed this week and this month, links to the pages, each content agent's last run and status. |
| Websites | `/command/websites` | Pansh's board: client, brief link, status, due date, delivered link, paid, price, late flag, money owed. |
| Handoff standard | `/command/websites/standard` | What every site must do before it reaches a client (tap to call everywhere, SEO basics, speed, blog post standard, handback steps), from the vault's website rules. |
| Team | `/command/team` | Who does what, plus this week's numbers per person. Grant types his Instantly and Twilio numbers in. |
| Setup | `/command/setup` | Jack only. What is wired on this deployment and what is not, and a live keyed check of the OS Supabase project. |

At-risk rule: a roofer with no check-in for 14 days, an unhappy last check-in, a problem open more than
7 days, or a late payment.

## What Jack has to set up

Everything is off until its env var is set, and each screen says so instead of showing fake data.
Add these in Vercel, Project, Settings, Environment Variables (Production and Preview), then redeploy.

### 1. Storage (required)

The OS Supabase project (`ikgnhieorzjaxtjoneye`) has answered REST calls with HTTP 402 since
2026-09-21, and the vault says it was later deleted and restored into a new project. The Command
Center does not depend on it: it stores everything in plain Postgres through one connection string.

Create ONE of these (both free):

- **A new Supabase project in its own new org** (an org-wide 402 cannot lock it). Project, Connect,
  "Transaction pooler" URI (port 6543). Paste it with the real password.
- **Vercel Postgres (Neon)**: Vercel, Storage, Create Database, Neon, connect it to this project. Copy
  its `POSTGRES_URL` value.

| Env var | Value |
|---|---|
| `COMMAND_DB_URL` | the connection string above |

The tables are created on first use. `supabase/migrations/0034_command_center.sql` is the same SQL if
you would rather run it by hand.

### 2. Sign-in (required)

| Env var | Value |
|---|---|
| `AUTH_SESSION_SECRET` | already set for the OS; keep it |
| `COMMAND_CODE_JACK` | Jack's code, 6 characters or more |
| `COMMAND_CODE_GRANT` | Grant's code |
| `COMMAND_CODE_DYLAN` | Dylan's code |

Each person opens `/command`, taps their name and types their code. Jack's existing OS login also
works on `/command`. A person with no code set cannot sign in. Sessions last 7 days.

### 3. Texts (Twilio primary, free backups)

Nothing is bought or registered by this code. To turn texts on:

1. Twilio console: buy one local number with SMS (about $1.15 a month), or a toll-free number.
2. Register it, or carriers block the texts:
   - Local number: **A2P 10DLC**. Register a Brand (Wing Digital, sole proprietor or LLC with EIN), then
     a Campaign, use case "Low volume mixed" or "Account notifications": "Internal alerts to our own
     three employees about client problems and a daily summary." Sample message: "New problem:
     Jackson Roofing. Dylan: leads page is blank." Opt-in: "Employees give their numbers to the
     owner and agree to receive operational alerts." Approval takes a few days to two weeks.
   - Toll-free number: submit **Toll-free verification** with the same description instead.
3. Set:

| Env var | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | from the Twilio console |
| `TWILIO_AUTH_TOKEN` | from the Twilio console |
| `TWILIO_FROM` | the Twilio number, `+1XXXXXXXXXX` (the OS's `TWILIO_FROM_NUMBER` also works) |
| `COMMAND_PHONE_JACK` | `+1XXXXXXXXXX` |
| `COMMAND_PHONE_GRANT` | `+1XXXXXXXXXX` |
| `COMMAND_PHONE_DYLAN` | `+1XXXXXXXXXX` |

Free backup, used whenever texting is off or a text fails:

| Env var | Value |
|---|---|
| `COMMAND_NTFY_TOPIC` | a long random topic name, e.g. `wing-team-7f3k9q2x`. Each person installs the free ntfy app and subscribes to it. |
| `COMMAND_EMAIL_JACK` / `_GRANT` / `_DYLAN` | email addresses; sent through the OS SMTP mailbox (`OUTREACH_SMTP_1_*`) when that is set |

Every alert attempt is logged in `cc_notifications`, including "texts are off, nobody was told".

### 4. Shared calendar

1. Sign in to Google as the **wingdigital26** account (never wjackwing1). Calendar, Other calendars, +,
   Create new calendar, name it "Wing Team".
2. Settings for that calendar: Share with specific people: add Grant, Dylan and Jack's own address
   with "Make changes to events".
3. Integrate calendar: copy the Calendar ID.
4. For Add event to write directly (optional): Google Cloud console on the wingdigital26 account,
   create a project, enable the Google Calendar API, create a service account, add a JSON key. Share
   the Wing Team calendar with the service account's email ("Make changes to events").

| Env var | Value |
|---|---|
| `COMMAND_CALENDAR_ID` | the Calendar ID (`...@group.calendar.google.com`) |
| `GOOGLE_SA_EMAIL` | the service account email (optional) |
| `GOOGLE_SA_PRIVATE_KEY` | the `private_key` from the JSON key, with its `\n` escapes (optional) |

Without the service account, Add event gives a pre-filled Google Calendar link and Home asks for the
service account to list events.

### 5. Machine key (daily routine, laptop sync, content agents)

| Env var | Value |
|---|---|
| `COMMAND_MACHINE_KEY` | a random string, 16 characters or more (e.g. `openssl rand -hex 24`) |

Also used (already set for the OS): `VAULT_SOURCE=github` and `GH_VAULT_TOKEN` (vault reads),
`ROOF_SUPABASE_URL` and `ROOF_SUPABASE_SERVICE_KEY` (Roof Command roofers, read-only).

## The daily routine

Two machine endpoints, both `POST` with `Authorization: Bearer <COMMAND_MACHINE_KEY>`:

- `POST /api/command/check` records today's check snapshot per client (history) and, when any client is
  red, missing a check or stale over 36h, texts the team one summary. Add `?quiet=1` to record only.
- `POST /api/command/digest` texts the morning digest: open problems, overdue roofer check-ins,
  at-risk clients. `GET` on the same URL only previews it.

Create it in Claude Code with `/schedule` (a cloud routine), weekdays at 7:41am Central:

1. Put `COMMAND_URL` (the production URL) and `COMMAND_MACHINE_KEY` in that routine's cloud
   environment variables, never in the prompt.
2. Prompt:

```
Run the Wing Command Center morning routine. The sentinel agent writes client health pages first, so
run after it. Use the env vars COMMAND_URL and COMMAND_MACHINE_KEY; never print the key.
1. curl -sS -X POST "$COMMAND_URL/api/command/check" -H "Authorization: Bearer $COMMAND_MACHINE_KEY"
2. curl -sS -X POST "$COMMAND_URL/api/command/digest" -H "Authorization: Bearer $COMMAND_MACHINE_KEY"
Report the "flagged" list from step 1 and whether the digest was sent. If either call fails, say which
and the HTTP status. Do nothing else.
```

The routine needs network access to the deployment's host (environment network setting).

## Laptop prospect sync

Prospects stay on Jack's laptop in `C:\Users\wjack\ghl-cli\prospects.db`. The script opens it
read-only and pushes the dialable rows up; outcomes are stored only in the cloud.

1. Add to `C:\Users\wjack\ghl-cli\.env`: `COMMAND_URL=https://<production url>` and
   `COMMAND_MACHINE_KEY=<same value as Vercel>`.
2. From `C:\Users\wjack\wing-digital-os`:

```
python scripts\command_center\sync_prospects.py                           # dry run
python scripts\command_center\sync_prospects.py --commit                  # push everything dialable
python scripts\command_center\sync_prospects.py --commit --vertical roofing
```

Re-running is safe: rows upsert on the prospects.db id, and call outcomes, notes and next call dates are
never overwritten. Rows with an `excluded_reason` never go up. To run it daily, add a Windows Task
Scheduler task with the `--commit` command.

## Content agents reporting runs

Each content engine can report a run so the SEO screen shows a real last-run time:

```
curl -X POST "$COMMAND_URL/api/command/agent-run" -H "Authorization: Bearer $COMMAND_MACHINE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agent":"jackson-content-weekly","client":"jackson-roofing","status":"ok","published":2}'
```

Until they do, the SEO screen falls back to the "last ran" notes sentinel and the watchdog write in the
vault.

## Where things live

- Screens: `app/command/(app)/*`, sign-in at `app/command/login`, shared UI in `app/command/_ui`.
- Nav: the Team group and the Command Center screen list are in `app/lib/nav.ts` only.
- Server logic: `lib/command/*` (db adapter, auth, notify, vault reader, clients, checks, seo, calendar).
- API: `app/api/command/*`. Member-role gating: `proxy.ts`.
