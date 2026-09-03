# Wing Digital OS — Deployment Guide (Vercel via GitHub)

This app is **deploy-ready**. Nothing is deployed yet (no accounts). Follow the steps
below once you create GitHub + Vercel accounts and it goes live at a free URL you can
open on your phone.

- **Framework:** Next.js 16 (App Router). Vercel auto-detects it — no `vercel.json` needed.
- **Build command:** `next build` (already in `package.json`).
- **Node:** 20.x (pinned via `engines` in `package.json`; Vercel default is fine).
- **Auth gate:** `middleware.ts` protects the whole OS. It accepts either a Supabase
  email/password session (signed with `AUTH_SESSION_SECRET`) or the legacy shared
  `OS_PASSWORD`. The gate now FAILS CLOSED outside development: if `OS_PASSWORD` is
  unset in a deployed environment, requests are refused (API routes get 503, pages
  redirect to /login). Only local development runs ungated.

---

## (a) Environment variables

Set these in **Vercel → Project → Settings → Environment Variables** (Production +
Preview). **Names only below — never commit the actual values.** The values currently
live in `C:\Users\wjack\ghl-cli\.env` and `wing-digital-os\.env.local` on the laptop.

| Vercel env var name | Maps to (.env name) | What it's for |
|---|---|---|
| `OS_PASSWORD` | `.env.local` → `OS_PASSWORD` | Legacy shared login password. Required in production: if unset, the gate fails closed and the deployed OS refuses requests (it does not go public). |
| `AUTH_SESSION_SECRET` | `.env.local` → `AUTH_SESSION_SECRET` | REQUIRED on Vercel for Supabase email/password logins. Signs the `wingos_session` JWT cookie. Without it, Supabase logins return a 500 "auth misconfigured" error. |
| `OS_SUPABASE_URL` | `.env.local` → `OS_SUPABASE_URL` | Supabase project URL for OS auth and portal data. |
| `OS_SUPABASE_ANON_KEY` | `.env.local` → `OS_SUPABASE_ANON_KEY` | Supabase anon key (email/password sign-in). |
| `OS_SUPABASE_SERVICE_KEY` | `.env.local` → `OS_SUPABASE_SERVICE_KEY` | Supabase service key (server-side role and portal-slug lookups). |
| `GHL_API_KEY` | `.env.local` → `GHL_API_KEY` | Wing's main GHL API key (contacts/opportunities routes). |
| `GHL_LOCATION_ID` | `.env.local` → `GHL_LOCATION_ID` | Wing's GHL sub-account location id. |
| `ANTHROPIC_API_KEY` | `.env.local` → `ANTHROPIC_API_KEY` | Claude chat routes (`/api/chat/claude`). |
| `OPENROUTER_API_KEY` | `.env.local` → `OPENROUTER_API_KEY` | Router / worker-model calls. |
| `GROQ_API_KEY` | `.env.local` → `GROQ_API_KEY` | Hermes/Groq chat route (`/api/chat/hermes`). |
| `BRAVE_SEARCH_API_KEY` | `.env.local` → `BRAVE_SEARCH_API_KEY` | Web search in agent/research routes. |
| `NEXT_PUBLIC_BASE_URL` | (optional) | Absolute base URL if any client code needs it. Set to your Vercel URL. |

Per-client GHL dashboards (`/api/clients/ghl?slug=...`) read a token named
`GHL_<SLUG>_PIT` (e.g. `heros-junk` → `GHL_HEROS_JUNK_PIT`). Add one Vercel
env var per client you want live in the cloud. (GoHighLevel was retired 2026-08-22,
so this path is historical.)

> Not needed on Vercel: `CLAUDE_CLI_PATH` (local Claude CLI), `USERPROFILE` (Windows).

---

## (b) Click-by-click: go live

1. **Create a GitHub repo** (github.com → New repository → e.g. `wing-digital-os`,
   Private). Do **not** initialize with a README (the folder already has commits).
2. **Add the remote and push** (run in `C:\Users\wjack\wing-digital-os`):
   ```bash
   git remote add origin https://github.com/<you>/wing-digital-os.git
   git push -u origin main
   ```
3. **Create a Vercel account** at vercel.com → sign in with GitHub.
4. **Import the project:** Vercel dashboard → **Add New → Project** → pick the
   `wing-digital-os` repo → **Import**. Framework preset auto-detects **Next.js**.
   Leave build/output settings at defaults.
5. **Paste env vars:** before the first deploy, open **Environment Variables** and add
   every name from section (a) with its value from the laptop `.env` files. (You can
   also add them after and hit Redeploy.)
6. **Deploy.** Vercel builds and gives you a free URL like
   `https://wing-digital-os.vercel.app`.
7. **Open on your phone.** Log in with `OS_PASSWORD`. Client dashboards live at
   `/dashboards/live.html?c=<slug>` (public by design, no login).

To ship future changes: `git push` → Vercel auto-redeploys.

---

## (c) Known limitation — local-DB panels (Phase 2)

Some routes read a **local SQLite file** (`C:\Users\wjack\ghl-cli\prospects.db`) and
other files on the laptop via Python. Vercel is serverless and cannot see the laptop's
filesystem, so those panels return a clean placeholder with `source:"local-db-unavailable"`
(empty data, no crash) instead of failing the build.

**Affected (show empty in the cloud until Phase 2):**
`/api/prospects`, `/api/sales-metrics`, `/api/campaign`, `/api/jarvis`,
`/api/agents/*`, `/api/agent-activity`, `/api/audit`, `/api/search`,
`/api/vault/*`, `/api/clients` — anything reading `prospects.db`, `ghl-cli` files, or
the Obsidian vault on disk.

**Phase 2 fix:** migrate `prospects.db` to a cloud database (Vercel Postgres or Turso/
libSQL) and point those routes at it via an env var connection string. Vault/agent
routes would need the vault + agent logs hosted somewhere the cloud can reach. Until
then, run the OS locally for those panels; the cloud deploy is for the always-on,
phone-viewable dashboards.

---

## (d) Client dashboards

Client dashboards are served from `public/dashboards/live.html?c=<slug>` and read
`/api/dashboard/<slug>`, which is built only from public sources (the client's own
site, repo and sitemap). No secret passes through them, so they are safe to hand to
a client as an always-on, phone-viewable link. One client = one entry in
`app/api/dashboard/clients.ts`.
