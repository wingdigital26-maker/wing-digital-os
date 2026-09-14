import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import "../dashboards.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Detail route embeds the EXISTING built dashboard HTML in an iframe. The iframe
// src is the static file already served from public/ (/dashboards/<slug>.html) --
// we never rebuild or duplicate the dashboard markup here. We only render the
// frame when both the config and the built file exist; otherwise 404.

const CONFIG_DIR = path.join(process.cwd(), "scripts", "client_dashboard", "clients");
const PUBLIC_DIR = path.join(process.cwd(), "public", "dashboards");

function resolve(slug: string): { name: string } | null {
  const configPath = path.join(CONFIG_DIR, `${slug}.json`);
  const htmlPath = path.join(PUBLIC_DIR, `${slug}.html`);
  try {
    if (!fs.existsSync(configPath) || !fs.existsSync(htmlPath)) return null;
  } catch {
    return null;
  }
  let name = slug;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    name = cfg?.brand?.name || cfg?.name || slug;
  } catch {
    // fall back to slug
  }
  return { name };
}

export default async function DashboardDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Guard the path segment so it can only address a file inside public/dashboards.
  if (!/^[a-z0-9-]+$/i.test(slug)) notFound();

  const resolved = resolve(slug);
  if (!resolved) notFound();

  const src = `/dashboards/${slug}.html`;

  return (
    <div className="dash-detail">
      <div className="dash-detail-bar">
        <Link href="/dashboards" className="dash-back">← All dashboards</Link>
        <span className="dash-detail-name">{resolved.name}</span>
        <a href={src} target="_blank" rel="noreferrer" className="dash-fullpage">
          Open full page ↗
        </a>
      </div>
      <iframe src={src} title={`${resolved.name} dashboard`} className="dash-frame" />
    </div>
  );
}
