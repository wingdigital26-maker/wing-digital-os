// ── Referral-partner lead list, per client ───────────────────────────────────
// Serves the enriched referral-source leads (realtors, property managers,
// remodelers, estate liquidators, probate attorneys...) that Wing scraped for a
// client, for rendering at /dashboards/leads.html?c=<slug>&k=<key>.
//
// WHY THIS IS KEY-GATED, unlike /api/dashboard/<slug>:
// The dashboard endpoint serves a client's own published content -- material
// that is already public on their website, so a guessable URL costs nothing.
// This endpoint serves the opposite: thousands of enriched B2B contacts with
// direct email addresses, which is Wing's own work product and the deliverable
// the client is paying for. On an open URL a competitor could take the entire
// list by guessing one slug. So this fails closed: no key configured means no
// request is ever authorized.
//
// WHERE THE DATA LIVES, and why it is NOT in this repo:
// wing-digital-os is a PUBLIC GitHub repo. A lead file committed under
// public/ would be served straight off github.com to anyone, permanently, in
// history and in code search -- the API key gate would be guarding a door in a
// building with no walls. So the export goes to the PRIVATE `wing-os-vault`
// repo and is read here server-side through readVaultFile(), the same path the
// OS already uses for vault markdown: local disk on Jack's PC, GitHub REST with
// GH_VAULT_TOKEN in the cloud. Nothing sensitive enters this repo.
//
// SIZE: this lead list is already ~954 KB and only grows. The GitHub Contents
// API stops inlining content above 1 MB and returns 200 with an EMPTY body
// rather than an error, which would make this route answer "no lead list yet"
// with nothing looking broken anywhere. readVaultFile() now handles that
// internally by falling back to the Git Blobs API, so every vault reader gets
// the fix, not just this one. See the ceiling comment in lib/vaultSource.ts.

import { NextResponse } from "next/server";
import { readVaultFile } from "../../../../lib/vaultSource";
import { verifyClientKey } from "../../../lib/clientKeys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fail-closed key check. Accepts `Authorization: Bearer <key>` or `?k=<key>`,
 * matching the pattern already used by /api/outbound/export. Its own env var:
 * this guards a distinct surface and must not piggyback on a key issued for
 * something else.
 */
// The key the caller presented, from `Authorization: Bearer <key>` or `?k=<key>`.
// Returns "" when neither is present.
function extractKey(req: Request): string {
  const auth = req.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (new URL(req.url).searchParams.get("k") || "").trim();
}

function keyOk(req: Request): boolean {
  // Trim both sides. Piping a value into `vercel env add` stores the trailing
  // newline, which makes a correct password fail with an indistinguishable
  // 401 -- an afternoon of "the key is wrong" when the key was fine.
  const key = (process.env.LEADS_DASHBOARD_KEY || "").trim();
  if (!key) return false;
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (bearer && bearer === key) return true;
  const provided = (new URL(req.url).searchParams.get("k") || "").trim();
  return provided !== "" && provided === key;
}

// Slug must be a plain identifier -- it is used to build a file path.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
) {
  const { slug } = await ctx.params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "bad slug" }, { status: 400 });
  }

  // Two ways in, both fail-closed. The shared LEADS_DASHBOARD_KEY (one key for
  // every client's leads), OR the per-client dashboard key that the /d/<slug>/
  // <key> link already carries -- so the same link that opens the dashboard
  // also unlocks that client's leads, scoped to this slug only.
  const provided = extractKey(req);
  const authorized = keyOk(req) || (await verifyClientKey(slug, provided));
  if (!authorized) {
    // Deliberately identical for "no key configured" and "wrong key": a
    // different message would tell a prober which of the two it hit.
    return NextResponse.json({ error: "not authorized" }, { status: 401 });
  }

  const raw = await readVaultFile(`_data/leads/${slug}.json`);
  if (!raw) {
    return NextResponse.json(
      { error: "no lead list for this client yet" },
      { status: 404 },
    );
  }
  return new NextResponse(raw, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Never let an intermediary cache an authorized response.
      "cache-control": "no-store, private",
    },
  });
}
