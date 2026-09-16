import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CLIENTS } from "../../api/dashboard/clients";
import "../dashboards.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Detail route embeds the client dashboard in an iframe, right inside the OS.
//
// 2026-09-16 (Jack): for clients wired into the LIVE dashboard system, this now
// embeds the exact page the CLIENT sees -- /dashboards/live.html?c=<slug> --
// with live data, not the older static snapshot. The dashboard API bypasses the
// per-client access key for a signed-in staff session (see app/api/dashboard/
// [slug]/route.ts), so the OS renders the real live view with no key in the URL.
// Clients that only have a built static file (no live registry entry) fall back
// to that file, so nothing 404s.

const CONFIG_DIR = path.join(process.cwd(), "scripts", "client_dashboard", "clients");
const PUBLIC_DIR = path.join(process.cwd(), "public", "dashboards");

function resolve(slug: string): { name: string; live: boolean } | null {
  const live = Object.prototype.hasOwnProperty.call(CLIENTS, slug);

  let hasStatic = false;
  try {
    hasStatic = fs.existsSync(path.join(PUBLIC_DIR, `${slug}.html`));
  } catch {
    hasStatic = false;
  }

  // Nothing to show unless the client is in the live registry OR has a built
  // static file.
  if (!live && !hasStatic) return null;

  // Prefer the live registry's brand name; fall back to the config JSON, then
  // the slug, so the header never blanks out.
  let name = CLIENTS[slug]?.brand?.name || slug;
  if (!CLIENTS[slug]?.brand?.name) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${slug}.json`), "utf8"));
      name = cfg?.brand?.name || cfg?.name || slug;
    } catch {
      // keep slug
    }
  }

  return { name, live };
}

export default async function DashboardDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Guard the path segment so it can only address a known slug / a file inside
  // public/dashboards.
  if (!/^[a-z0-9-]+$/i.test(slug)) notFound();

  const resolved = resolve(slug);
  if (!resolved) notFound();

  // Live clients get the exact customer-facing page (live data); others get
  // their built static file.
  const src = resolved.live
    ? `/dashboards/live.html?c=${encodeURIComponent(slug)}`
    : `/dashboards/${slug}.html`;

  return (
    <div className="dash-detail">
      <div className="dash-detail-bar">
        <Link href="/dashboards" className="dash-back">← All dashboards</Link>
        <span className="dash-detail-name">
          {resolved.name}
          {resolved.live && <span className="dash-live-tag">Live · what your client sees</span>}
        </span>
        <a href={src} target="_blank" rel="noreferrer" className="dash-fullpage">
          Open full page ↗
        </a>
      </div>
      <iframe src={src} title={`${resolved.name} dashboard`} className="dash-frame" />
    </div>
  );
}
