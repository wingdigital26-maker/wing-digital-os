import fs from "node:fs";
import path from "node:path";
import Link from "next/link";
import BackToOs from "../components/BackToOs";
import "./dashboards.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// This index reflects EXACTLY what exists on disk. Nothing about the client
// list is hardcoded: we read every config in scripts/client_dashboard/clients/,
// pull the human name out of each JSON, then check whether the built static
// HTML actually landed under public/dashboards/. A config with no built file
// shows an honest "not built yet" state instead of a dead link.

type DashboardEntry = {
  slug: string;
  name: string;
  built: boolean;
};

const CONFIG_DIR = path.join(process.cwd(), "scripts", "client_dashboard", "clients");
const PUBLIC_DIR = path.join(process.cwd(), "public", "dashboards");

function readEntries(): DashboardEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  return files
    .map((file) => {
      const slug = file.replace(/\.json$/, "");
      let name = slug;
      try {
        const raw = fs.readFileSync(path.join(CONFIG_DIR, file), "utf8");
        const cfg = JSON.parse(raw);
        // Configs carry the display name under brand.name; fall back to a
        // top-level name, then to the slug so a malformed file never blanks out.
        name = cfg?.brand?.name || cfg?.name || slug;
      } catch {
        // Leave name as the slug if the JSON can't be parsed.
      }
      let built = false;
      try {
        built = fs.existsSync(path.join(PUBLIC_DIR, `${slug}.html`));
      } catch {
        built = false;
      }
      return { slug, name, built };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function DashboardsIndexPage() {
  const entries = readEntries();
  const builtCount = entries.filter((e) => e.built).length;

  return (
    <div className="dash-index page-scroll">
      <div className="dash-index-inner">
        <BackToOs style={{ marginBottom: 16 }} />
        <header className="dash-head">
          <h1>Client dashboards</h1>
          <p>
            Every client reporting dashboard, opened right inside the OS.{" "}
            {entries.length > 0
              ? `${builtCount} of ${entries.length} built.`
              : "No dashboard configs found yet."}
          </p>
        </header>

        {entries.length === 0 ? (
          <div className="dash-empty">
            No configs found in <code>scripts/client_dashboard/clients/</code>.
          </div>
        ) : (
          <div className="dash-grid">
            {entries.map((e) =>
              e.built ? (
                <Link key={e.slug} href={`/dashboards/${e.slug}`} className="dash-card dash-card-live">
                  <span className="dash-card-name">{e.name}</span>
                  <span className="dash-card-slug">{e.slug}</span>
                  <span className="dash-card-state dash-state-open">Open dashboard →</span>
                </Link>
              ) : (
                <div key={e.slug} className="dash-card dash-card-pending" aria-disabled="true">
                  <span className="dash-card-name">{e.name}</span>
                  <span className="dash-card-slug">{e.slug}</span>
                  <span className="dash-card-state dash-state-pending">Not built yet</span>
                </div>
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
