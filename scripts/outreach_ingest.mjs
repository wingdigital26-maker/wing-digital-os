#!/usr/bin/env node
// Load the cold-email engine's queue files into the OS review queue.
//
//   node scripts/outreach_ingest.mjs                      # every date, every tenant
//   node scripts/outreach_ingest.mjs --date 2026-09-28    # one batch
//   node scripts/outreach_ingest.mjs --tenant wing --base http://localhost:3000
//   node scripts/outreach_ingest.mjs --dry                # parse + show counts, send nothing
//
// Reads ghl-cli/outreach_queue/<tenant>/<YYYY-MM-DD>/<lead_id>.json (override
// with --queue or OUTREACH_QUEUE_DIR) and POSTs them to /api/outreach/ingest
// with x-heartbeat-key (HEARTBEAT_KEY from the environment or .env.local).
// Optional extras, if the engine writes them next to the queue:
//   outreach_audit.db (read-only): suppression, lead_state, breaker_tripped rows
//   outreach_queue/<tenant>/mailbox_state.json   [{mailbox, paused, reason, at}]
//   outreach_queue/<tenant>/suppression.json     [{email, reason, at, detail}]
// Idempotent: the route upserts on tenant + lead + date and never overwrites a
// person's edit or approval. This script sends no email and pushes nothing.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dry = args.includes("--dry");

function envFile() {
  const out = {};
  for (const f of [".env.local", ".env"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return out;
}
const env = { ...envFile(), ...process.env };

const queueRoot = opt("queue", env.OUTREACH_QUEUE_DIR || "C:/Users/wjack/ghl-cli/outreach_queue");
const base = (opt("base", env.OUTREACH_OS_URL || "https://wing-digital-os.vercel.app")).replace(/\/$/, "");
const onlyDate = opt("date");
const onlyTenant = opt("tenant");
const key = env.HEARTBEAT_KEY;

if (!fs.existsSync(queueRoot)) {
  console.error(`No queue folder at ${queueRoot}. Has write_sequences.py run yet?`);
  process.exit(2);
}

const readJson = (p) => {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
};

const tenants = fs.readdirSync(queueRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && (!onlyTenant || d.name === onlyTenant));
const items = [];
const mailboxes = [];
const suppression = [];
const leads = [];
for (const t of tenants) {
  const tdir = path.join(queueRoot, t.name);
  const mb = readJson(path.join(tdir, "mailbox_state.json"));
  if (Array.isArray(mb)) for (const m of mb) mailboxes.push({ tenant: t.name, ...m });
  const sup = readJson(path.join(tdir, "suppression.json"));
  if (Array.isArray(sup)) for (const s of sup) suppression.push({ tenant: t.name, ...s });
  for (const d of fs.readdirSync(tdir, { withFileTypes: true })) {
    if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name) || (onlyDate && d.name !== onlyDate)) continue;
    for (const f of fs.readdirSync(path.join(tdir, d.name))) {
      if (!f.endsWith(".json")) continue;
      const data = readJson(path.join(tdir, d.name, f));
      if (data && !data.research && typeof data.research_path === "string") {
        // Facts live in research/<lead>.research.json; inline them so the OS
        // can show the facts each email stands on.
        const rp = path.isAbsolute(data.research_path) ? data.research_path : path.join(path.dirname(queueRoot), data.research_path.replace(/\\/g, "/"));
        const research = readJson(rp) ?? readJson(path.join(tdir, d.name, "research", `${data.lead_id}.research.json`));
        if (research) data.research = research;
      }
      if (data) items.push({ path: `${t.name}/${d.name}/${f}`, data });
      else console.warn(`skipped unreadable ${t.name}/${d.name}/${f}`);
    }
  }
}

// The engine's append-only suppression table (outreach_core.py), read-only.
// Only email rows whose reason names a stop (unsubscribe, bounce, complaint,
// remove me) are mirrored; config rows like "tenant yaml" are not stops.
const auditDb = opt("audit", env.OUTREACH_AUDIT_DB || path.join(path.dirname(queueRoot), "outreach_audit.db"));
if (fs.existsSync(auditDb)) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(auditDb, { readOnly: true });
    const rows = db.prepare("SELECT ts, scope, kind, value, reason FROM suppression WHERE kind = 'email'").all();
    for (const r of rows) {
      if (onlyTenant && r.scope !== "*" && r.scope !== onlyTenant) continue;
      suppression.push({ tenant: r.scope === "*" ? (onlyTenant ?? "wing") : r.scope, email: r.value, reason: r.reason ?? "", at: r.ts, detail: r.reason ?? null });
    }
    // lead_state: round, re-touch schedule, stops and handoffs (CUSTOM_OUTREACH.md).
    try {
      for (const r of db.prepare("SELECT * FROM lead_state").all()) {
        if (onlyTenant && r.tenant !== onlyTenant) continue;
        leads.push({ ...r });
      }
    } catch { /* older audit db without lead_state */ }
    // Circuit breaker: a mailbox is paused from its latest breaker_tripped
    // row until a later push run shows the breaker let pushes through again.
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const trips = db.prepare("SELECT ts, tenant, detail_json FROM audit_log WHERE event = 'breaker_tripped' AND ts >= ? ORDER BY ts").all(weekAgo);
    const lastOk = db.prepare("SELECT tenant, MAX(ts) AS ts FROM audit_log WHERE event IN ('pushed','push_dry_run') GROUP BY tenant").all();
    const okBy = Object.fromEntries(lastOk.map((r) => [r.tenant, r.ts]));
    const latest = new Map();
    for (const t of trips) {
      if (onlyTenant && t.tenant !== onlyTenant) continue;
      let tripped = {};
      try { tripped = JSON.parse(t.detail_json || "{}").tripped || {}; } catch { /* keep empty */ }
      for (const [mailbox, why] of Object.entries(tripped)) {
        if (!mailbox.includes("@")) continue;
        latest.set(mailbox.toLowerCase(), { tenant: t.tenant, at: t.ts, reason: String(why) });
      }
    }
    for (const [mailbox, t] of latest) {
      mailboxes.push({ mailbox, tenant: t.tenant, paused: !(okBy[t.tenant] && okBy[t.tenant] > t.at), reason: t.reason, at: t.at });
    }
    db.close();
  } catch (e) {
    console.warn(`could not read ${auditDb}: ${e instanceof Error ? e.message : e}`);
  }
}

console.log(`${items.length} draft file(s), ${leads.length} lead state(s), ${mailboxes.length} mailbox state(s), ${suppression.length} suppression row(s) from ${queueRoot}`);
if (dry) process.exit(0);
if (!key) {
  console.error("HEARTBEAT_KEY is not set (environment or .env.local). Refusing to post.");
  process.exit(2);
}

let inserted = 0, updated = 0;
const refused = [];
for (let i = 0; i < Math.max(items.length, 1); i += 200) {
  const batch = items.slice(i, i + 200);
  const body = { items: batch, ...(i === 0 ? { mailboxes, suppression, leads } : {}) };
  const res = await fetch(`${base}/api/outreach/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-heartbeat-key": key },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) {
    console.error(`ingest failed (HTTP ${res.status}): ${out.reason ?? out.error ?? "no reason given"}`);
    process.exit(1);
  }
  inserted += out.inserted ?? 0;
  updated += out.updated ?? 0;
  refused.push(...(out.refused ?? []));
}
console.log(`into ${base}: ${inserted} new, ${updated} updated, ${refused.length} refused`);
for (const r of refused.slice(0, 50)) console.log(`  refused ${r.path ?? "(no path)"}: ${r.reason}`);
