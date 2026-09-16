import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Clean path-style dashboard link: /d/<client-slug>/<key>
//
// Some chat and SMS apps strip the query string off a shared link when it is
// tapped, so a "?c=slug&k=key" dashboard link can arrive at the browser with no
// client and no key, and the page then reads as empty or wrong. This route
// carries both in the PATH, which those apps keep, and 302-redirects to the
// real dashboard URL. The redirect runs inside a real browser, which preserves
// the query, so the static dashboard page loads exactly as before.
//
// No key check here on purpose: the dashboard API is still the gate. A bad key
// still comes back as 401 and the "missing access key" message. This route only
// carries the values across the app that mangles query strings.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string; key: string }> }
) {
  const { slug, key } = await params;
  // Prefer the bespoke, better-designed per-client build (/dashboards/<slug>.html)
  // when it exists -- it is richer AND live, and reads the ?k access key just like
  // the generic template. Fall back to the generic live template otherwise, so a
  // client without a bespoke build still gets a working dashboard.
  const safeSlug = /^[a-z0-9-]+$/i.test(slug) ? slug : "";
  let hasBespoke = false;
  try {
    hasBespoke = !!safeSlug && fs.existsSync(
      path.join(process.cwd(), "public", "dashboards", `${safeSlug}.html`)
    );
  } catch {
    hasBespoke = false;
  }
  const target = hasBespoke
    ? `/dashboards/${encodeURIComponent(slug)}.html?k=${encodeURIComponent(key)}`
    : `/dashboards/live.html?c=${encodeURIComponent(slug)}&k=${encodeURIComponent(key)}`;
  const url = new URL(target, _req.url);
  return NextResponse.redirect(url, 302);
}
