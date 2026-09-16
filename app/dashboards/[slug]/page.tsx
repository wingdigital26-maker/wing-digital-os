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
// 2026-09-16 (Jack): this shows the SAME page the client sees, and specifically
// the bespoke, better-designed per-client build at /dashboards/<slug>.html when
// one exists. Those bespoke files are BOTH richer AND live (they fetch
// /api/dashboard/<slug> at runtime, same as the generic template), and the
// dashboard API bypasses the per-client access key for a signed-in staff
// session, so the OS renders the real live view with no key in the URL. A client
// wired into the live registry but without a bespoke build falls back to the
// generic live template so nothing 404s.

const PUBLIC_DIR = path.join(process.cwd(), "public", "dashboards");
const CONFIG_DIR = path.join(process.cwd(), "scripts", "client_dashboard", "clients");

function resolve(slug: string): { name: string; src: string } | null {
  let hasBespoke = false;
  try {
    hasBespoke = fs.existsSync(path.join(PUBLIC_DIR, `${slug}.html`));
  } catch {
    hasBespoke = false;
  }
  const inRegistry = Object.prototype.hasOwnProperty.call(CLIENTS, slug);

  // Nothing to show unless a bespoke build exists OR the client is live-registry.
  if (!hasBespoke && !inRegistry) return null;

  // Prefer the bespoke build (the better, client-facing one); else the generic
  // live template addressed by client slug.
  const src = hasBespoke
    ? `/dashboards/${slug}.html`
    : `/dashboards/live.html?c=${encodeURIComponent(slug)}`;

  // Name: registry brand name first, then the config JSON, then the slug.
  let name = CLIENTS[slug]?.brand?.name || "";
  if (!name) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, `${slug}.json`), "utf8"));
      name = cfg?.brand?.name || cfg?.name || slug;
    } catch {
      name = slug;
    }
  }

  return { name, src };
}

export default async function DashboardDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-z0-9-]+$/i.test(slug)) notFound();

  const resolved = resolve(slug);
  if (!resolved) notFound();

  return (
    <div className="dash-detail">
      <div className="dash-detail-bar">
        <Link href="/dashboards" className="dash-back">← All dashboards</Link>
        <span className="dash-detail-name">
          {resolved.name}
          <span className="dash-live-tag">Live · what your client sees</span>
        </span>
        <a href={resolved.src} target="_blank" rel="noreferrer" className="dash-fullpage">
          Open full page ↗
        </a>
      </div>
      <iframe src={resolved.src} title={`${resolved.name} dashboard`} className="dash-frame" />
    </div>
  );
}
