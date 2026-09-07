// ───────────────────────────────────────────────────────────────────────────
// Nimbus deep-access tools (build spec "Nimbus on your machine", phase 2 + 3).
//
// The tools in jarvisTools.ts cover the OS database, the vault, the CRM and
// the agents. These five cover the parts of the business Nimbus could not see:
// the lead pipeline, what actually got published for each client, the cold
// email send ledger, revenue, and the call room. Plus the memory file that
// makes him start a conversation warm instead of cold.
//
// HARD RULES (same as jarvisTools.ts, restated because this file is new)
//   * Every tool here is READ-ONLY except `remember`, which appends one line
//     to a plain markdown file in the vault and still goes through the
//     confirmation card like every other write.
//   * A failed query reports { error, could_not_check: true }. Never an empty
//     list, never a zero. A zero that means "no data" is a lie.
//   * Secrets are unreachable. Nothing here reads ghl-cli\.env or any other
//     credential store, and SECRET_FILE_DENY below is the explicit block for
//     the file-reading tools.
//   * Local only. isCloud() short-circuits the tools that touch Jack's disk,
//     because the cloud copy of the OS is reachable from the internet.
// ───────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { isCloud } from "@/lib/runtime";
import { VAULT_PATH, readVaultFile } from "@/lib/vaultSource";
import { getRevenueTruth, BASIS_LABEL } from "@/lib/revenue";
import { sbGet } from "@/app/api/pipeline/_lib";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { runNimbusWatch, formatWatchReport } from "@/lib/nimbusWatch";

export type LocalToolArgs = Record<string, unknown>;
export type LocalToolOutcome = { content: string; links?: { label: string; view?: string; href?: string }[] };

type ToolDef = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required: string[] };
};
const obj = (properties: Record<string, unknown>, required: string[] = []): ToolDef["input_schema"] => ({
  type: "object",
  properties,
  required,
});

const json = (v: unknown) => JSON.stringify(v);
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fail = (msg: string): LocalToolOutcome => ({ content: json({ error: msg, could_not_check: true }) });
const pcRequired = (what: string): LocalToolOutcome => ({
  content: json({ pcRequired: true, message: `${what} needs Jack's PC. This is the cloud copy of the OS, so it cannot reach that.` }),
});

const GHL_CLI_DIR = "C:\\Users\\wjack\\ghl-cli";
const PROSPECTS_DB = path.join(GHL_CLI_DIR, "prospects.db");
// The built dashboards carry the published record as `const DATA = {...};`.
// That is the same object each client sees, so reading it here means Nimbus and
// the client are quoting one source.
const DASHBOARDS_DIR = path.join(process.cwd(), "public", "dashboards");

// ── The deny list ───────────────────────────────────────────────────────────
// "Access to every part of the business" stops here. These never resolve, for
// any tool, by any path spelling. Nimbus may be told a credential's NAME; he
// is never given its value.
export const SECRET_FILE_DENY = [
  /(^|[\\/])\.env($|\.)/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])id_rsa/i,
  /(^|[\\/])credentials?\.(json|ya?ml|txt)$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|txt|env)$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.key$/i,
];
/** True when a path must never be read. Checked before any file tool opens anything. */
export function isDeniedPath(p: string): boolean {
  const s = String(p || "").replace(/\\/g, "/");
  return SECRET_FILE_DENY.some((re) => re.test(s));
}

// ── Memory ──────────────────────────────────────────────────────────────────
// One plain markdown file in the vault. Jack can open it, edit a line, or
// delete one. That reversibility is the whole reason this is a file and not a
// fine-tuned model.
export const MEMORY_REL_PATH = "wiki/nimbus/memory.md";
const MEMORY_HEADER =
  "# Nimbus memory\n\n" +
  "Things Jack told Nimbus to remember. One dated line each. Safe to edit or delete by hand.\n" +
  "Never put a credential in this file.\n\n";

/** The memory file, capped so it can never flood the system prompt. Null when there is none. */
export async function readNimbusMemory(): Promise<string | null> {
  try {
    const text = await readVaultFile(MEMORY_REL_PATH);
    if (!text) return null;
    const lines = text.split(/\r?\n/).filter((l) => l.trim().startsWith("- "));
    if (!lines.length) return null;
    return lines.slice(-120).join("\n").slice(-8000);
  } catch {
    return null;
  }
}

function centralDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const SECRET_VALUE_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/, /pit-[A-Za-z0-9-]{8,}/, /AKIA[0-9A-Z]{12,}/, /eyJ[A-Za-z0-9_-]{20,}\./];

function remember(a: LocalToolArgs): LocalToolOutcome {
  if (isCloud()) return pcRequired("Writing to Nimbus memory");
  const fact = str(a.fact).trim().replace(/\s+/g, " ");
  if (!fact) return fail("fact is required");
  if (fact.length > 400) return fail("fact is too long; keep it under 400 characters");
  if (SECRET_VALUE_PATTERNS.some((re) => re.test(fact))) {
    return fail("that looks like a credential, so it was not written to memory");
  }
  const abs = path.join(VAULT_PATH, ...MEMORY_REL_PATH.split("/"));
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, MEMORY_HEADER, "utf-8");
    fs.appendFileSync(abs, `- ${centralDate()}: ${fact}\n`, "utf-8");
    return { content: json({ ok: true, remembered: fact, path: MEMORY_REL_PATH }) };
  } catch (e) {
    return fail(`could not write memory: ${errText(e)}`);
  }
}

async function recallMemory(): Promise<LocalToolOutcome> {
  const mem = await readNimbusMemory();
  if (!mem) return { content: json({ memory: null, note: "nothing has been remembered yet" }) };
  return { content: json({ path: MEMORY_REL_PATH, memory: mem }) };
}

// ── query_pipeline: the lead pipeline in prospects.db ───────────────────────
function pySql(sql: string, timeoutMs = 20000): unknown {
  const py = [
    "import sqlite3,json,sys",
    `c=sqlite3.connect(r"${PROSPECTS_DB}")`,
    "c.row_factory=sqlite3.Row",
    `rows=[dict(r) for r in c.execute(${JSON.stringify(sql)})]`,
    "sys.stdout.write(json.dumps(rows,default=str))",
  ].join("\n");
  const stdout = execFileSync("python", ["-c", py], { encoding: "utf-8", timeout: timeoutMs, windowsHide: true });
  return JSON.parse(stdout.trim() || "[]");
}

const IDENT = /^[a-z_][a-z0-9_]*$/;
const sqlLit = (v: string) => `'${v.replace(/'/g, "''")}'`;

function queryPipeline(a: LocalToolArgs): LocalToolOutcome {
  if (isCloud()) return pcRequired("Reading the lead pipeline");
  if (!fs.existsSync(PROSPECTS_DB)) return fail(`prospects.db not found at ${PROSPECTS_DB}`);
  const where: string[] = [];
  const like = (col: string, v: string) => `lower(${col}) LIKE '%' || lower(${sqlLit(v)}) || '%'`;
  const eq = (col: string, v: string) => `lower(${col}) = lower(${sqlLit(v)})`;
  if (str(a.city)) where.push(like("city", str(a.city)));
  if (str(a.state)) where.push(eq("state", str(a.state)));
  if (str(a.trade)) where.push(eq("trade", str(a.trade)));
  if (str(a.status)) where.push(eq("status", str(a.status)));
  if (str(a.tier)) where.push(eq("tier", str(a.tier)));
  if (a.uncalled === true) where.push("called_at IS NULL");
  if (a.unemailed === true) where.push("emailed_at IS NULL");
  if (str(a.name)) where.push(like("name", str(a.name)));
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const groupBy = str(a.group_by);
  try {
    if (groupBy) {
      if (!IDENT.test(groupBy)) return fail(`group_by must be a plain column name, got '${groupBy}'`);
      const rows = pySql(
        `SELECT ${groupBy} AS value, COUNT(*) AS n FROM prospects ${clause} GROUP BY ${groupBy} ORDER BY n DESC LIMIT 40`
      );
      return { content: json({ source: "prospects.db (local)", filters: where, grouped_by: groupBy, groups: rows }) };
    }
    const total = (pySql(`SELECT COUNT(*) AS n FROM prospects ${clause}`) as { n: number }[])[0]?.n ?? null;
    const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
    const rows = pySql(
      `SELECT id,name,city,state,trade,tier,status,phone,email,website,google_reviews,google_rating,` +
        `called_at,emailed_at,call_notes FROM prospects ${clause} ORDER BY id DESC LIMIT ${limit}`
    );
    return { content: json({ source: "prospects.db (local)", filters: where, matching: total, showing: rows }) };
  } catch (e) {
    return fail(`prospects.db query failed: ${errText(e)}`);
  }
}

// ── client_publishing: what actually went live for a client ─────────────────
type DashboardItem = { type?: string; title?: string; date?: string; url?: string; status?: string };
type DashboardData = {
  slug?: string;
  brand?: { name?: string };
  items?: DashboardItem[];
  metrics?: Record<string, unknown>;
  dataThrough?: string;
  generatedAt?: string;
};

function daysAgo(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/** Pull the DATA object a built dashboard renders. Null when it is not there. */
function readDashboardData(file: string): DashboardData | null {
  const html = fs.readFileSync(file, "utf-8");
  const marker = "const DATA = ";
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const open = at + marker.length;
  if (html[open] !== "{") return null;
  // Walk the braces so a brace inside a string cannot end the object early.
  let depth = 0;
  let inStr = false;
  let quote = "";
  let esc = false;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(open, i + 1)) as DashboardData;
    }
  }
  return null;
}

function clientPublishing(a: LocalToolArgs): LocalToolOutcome {
  if (!fs.existsSync(DASHBOARDS_DIR)) return fail(`built dashboards not found at ${DASHBOARDS_DIR}`);
  let files: string[];
  try {
    files = fs.readdirSync(DASHBOARDS_DIR).filter((f) => f.endsWith(".html") && !f.endsWith(".artifact.html"));
  } catch (e) {
    return fail(`could not list dashboards: ${errText(e)}`);
  }
  const want = str(a.client).toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const slug = f.replace(/\.html$/, "");
    let data: DashboardData | null;
    try {
      data = readDashboardData(path.join(DASHBOARDS_DIR, f));
    } catch (e) {
      out.push({ slug, error: `dashboard data unreadable: ${errText(e)}` });
      continue;
    }
    if (!data) continue;
    const name = data.brand?.name ?? null;
    if (want) {
      const hay = `${slug}${name || ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!hay.includes(want)) continue;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    const ages = items.map((i) => (i.date ? daysAgo(i.date) : null));
    const within = (d: number) => ages.filter((x) => x !== null && (x as number) <= d).length;
    const byType: Record<string, number> = {};
    for (const i of items) byType[i.type || "unknown"] = (byType[i.type || "unknown"] || 0) + 1;
    out.push({
      slug,
      client: name,
      total_published: items.length,
      last_7_days: within(7),
      last_30_days: within(30),
      by_type: byType,
      most_recent: items
        .filter((i) => i.date)
        .sort((x, y) => String(y.date).localeCompare(String(x.date)))
        .slice(0, 5)
        .map((i) => ({ title: i.title ?? null, type: i.type ?? null, date: i.date ?? null, url: i.url ?? null })),
      data_through: data.dataThrough ?? null,
      built_at: data.generatedAt ?? null,
      metrics: data.metrics && Object.keys(data.metrics).length ? data.metrics : null,
    });
  }
  if (!out.length) {
    return fail(want ? `no client dashboard matched '${str(a.client)}'` : "no built client dashboards found");
  }
  return {
    content: json({
      source: "public/dashboards/*.html, the same record each client's dashboard renders",
      note: "Counted from the last dashboard build, not a live crawl of the client's site. Check data_through before quoting it as current.",
      clients: out,
    }),
  };
}

// ── send_ledger: what cold email actually went out ──────────────────────────
function sonarEnv(): { url: string; key: string } {
  const url = process.env.SONAR_SUPABASE_URL;
  const key = process.env.SONAR_SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are not set on this host");
  return { url: url.replace(/\/$/, ""), key };
}

async function sonarCount(query: string): Promise<number | null> {
  const { url, key } = sonarEnv();
  return restCount(url, key, query);
}

/** HEAD + count=exact against any PostgREST. Throws rather than returning 0. */
async function restCount(url: string, key: string, query: string): Promise<number | null> {
  const sep = query.includes("?") ? "&" : "?";
  const r = await fetch(`${url}/rest/v1/${query}${sep}select=id`, {
    method: "HEAD",
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${r.status} counting ${query.split("?")[0]}`);
  const cr = r.headers.get("content-range");
  const n = cr ? Number(cr.split("/")[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function osEnv(): { url: string; key: string } {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) throw new Error("OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set on this host");
  return { url: url.replace(/\/$/, ""), key };
}

async function osRows<T>(query: string): Promise<T[]> {
  const { url, key } = osEnv();
  const r = await fetch(`${url}/rest/v1/${query}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
  return (await r.json()) as T[];
}

async function sendLedger(a: LocalToolArgs): Promise<LocalToolOutcome> {
  const days = Math.min(Math.max(Number(a.days) || 30, 1), 365);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const enc = encodeURIComponent(since);
  const out: Record<string, unknown> = {
    window_days: days,
    since,
    source: "outbound from the Sonar database; prospects and the sender's daily state from the OS database",
  };
  const problems: string[] = [];
  let got = 0;
  try {
    out.emails_delivered_to_smtp = await sonarCount(`outbound?sent_at=gte.${enc}`);
    out.send_errors = await sonarCount(`outbound?last_send_error=not.is.null&sent_at=is.null&last_send_attempt_at=gte.${enc}`);
    got++;
  } catch (e) {
    problems.push(`outbound: ${errText(e)}`);
  }
  try {
    const os = osEnv();
    out.prospects_emailed = await restCount(os.url, os.key, `prospects?emailed_at=gte.${enc}`);
    got++;
  } catch (e) {
    problems.push(`prospects: ${errText(e)}`);
  }
  try {
    out.sender_state = await osRows<Record<string, unknown>>(
      "outreach_state?select=client,day,count,paused,last_send_ts,updated_at&order=updated_at.desc&limit=5"
    );
    got++;
  } catch (e) {
    problems.push(`outreach_state: ${errText(e)}`);
  }
  if (!got) return fail(`send ledger unavailable: ${problems.join("; ")}`);
  if (problems.length) out.could_not_check = problems;
  return { content: json(out), links: [{ label: "Deliverability", view: "email" }] };
}

// ── revenue_state ───────────────────────────────────────────────────────────
async function revenueState(): Promise<LocalToolOutcome> {
  try {
    const t = await getRevenueTruth();
    return {
      content: json({
        asOf: t.asOf,
        mrr: t.mrr,
        mrrDurable: t.mrrDurable,
        mrrExpiring: t.mrrExpiring,
        mrrBasisLine: t.mrrBasisLine,
        nextExpiry: t.nextExpiry,
        activeClients: t.activeClients,
        clientsWithFigure: t.clientsWithFigure,
        oneTimeTotal: t.oneTimeTotal,
        expectedTotal: t.expectedTotal,
        unconfirmedTotal: t.unconfirmedTotal,
        pipelineTotal: t.pipelineTotal,
        rosterSource: t.rosterSource,
        questions: t.questions,
        clients: t.clients.map((c) => ({ name: c.name, amount: c.amount, basis: c.basis, basisLabel: BASIS_LABEL[c.basis] })),
        clients_with_no_figure: t.unknown.map((c) => c.name),
      }),
      links: [{ label: "Clients", view: "clients" }],
    };
  } catch (e) {
    return fail(`revenue truth failed: ${errText(e)}`);
  }
}

// ── call_room ───────────────────────────────────────────────────────────────
type CallLead = {
  id: string;
  company: string;
  city: string | null;
  state: string | null;
  vertical: string | null;
  status: string;
  last_outcome: string | null;
  last_called_at: string | null;
  call_count: number | null;
  next_action_at: string | null;
  claimed_by_email: string | null;
};

async function callRoom(a: LocalToolArgs): Promise<LocalToolOutcome> {
  try {
    const where: string[] = [];
    if (str(a.outcome)) where.push(`last_outcome=eq.${encodeURIComponent(str(a.outcome))}`);
    if (str(a.status)) where.push(`status=eq.${encodeURIComponent(str(a.status))}`);
    if (Number(a.min_calls)) where.push(`call_count=gte.${Math.floor(Number(a.min_calls))}`);
    if (str(a.city)) where.push(`city=ilike.*${encodeURIComponent(str(a.city))}*`);
    const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
    const rows = await sbGet<CallLead>(
      "call_leads",
      "id,company,city,state,vertical,status,last_outcome,last_called_at,call_count,next_action_at,claimed_by_email",
      `${where.length ? where.join("&") + "&" : ""}order=last_called_at.desc.nullslast&limit=${limit}`
    );
    const byOutcome: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const r of rows) {
      const o = r.last_outcome || "never called";
      byOutcome[o] = (byOutcome[o] || 0) + 1;
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    }
    return {
      content: json({
        source: "OS Supabase call_leads",
        note: "The counts below describe the returned rows only, not the whole table.",
        filters: where,
        returned: rows.length,
        by_outcome: byOutcome,
        by_status: byStatus,
        leads: rows,
      }),
      links: [{ label: "Call room", href: "/calls" }],
    };
  } catch (e) {
    return fail(`call room query failed: ${errText(e)}`);
  }
}

// ── nimbus_report: the same watch the scheduled alerts run on ───────────────
async function nimbusReport(): Promise<LocalToolOutcome> {
  try {
    const w = await runNimbusWatch();
    return {
      content: json({
        ranAt: w.ranAt,
        headline: w.headline,
        problems: w.problems.map((p) => ({
          id: p.id,
          label: p.label,
          detail: p.detail,
          // Always answer with the fix, never just the symptom.
          fix: p.fix ?? null,
          link: p.link?.href ?? null,
          severity: p.severity ?? "normal",
        })),
        could_not_check: w.unknowns.map((u) => ({ id: u.id, label: u.label, why: u.detail })),
        working: w.checks.filter((c) => c.state === "ok").map((c) => ({ label: c.label, detail: c.detail })),
        text: formatWatchReport(w),
      }),
      links: w.problems.length && w.problems[0].link ? [{ label: w.problems[0].link.label, href: w.problems[0].link.href }] : undefined,
    };
  } catch (e) {
    return fail(`the watch failed to run: ${errText(e)}`);
  }
}

// ── Definitions, dispatch and wording ───────────────────────────────────────
export const NIMBUS_LOCAL_TOOLS: ToolDef[] = [
  {
    name: "query_pipeline",
    description:
      "Needs Jack's PC. The lead pipeline in prospects.db: filter by city, state, trade, status, tier or name, restrict to uncalled or unemailed leads, or group by any column for counts. Use for questions like how many Tier 1 roofers are left uncalled in Frisco. Read-only.",
    input_schema: obj({
      city: { type: "string" },
      state: { type: "string" },
      trade: { type: "string", description: "e.g. roofing, b2b, plumbing" },
      status: { type: "string", description: "e.g. new, enriching, emailed" },
      tier: { type: "string", description: "e.g. T1, T1-A, T1-B" },
      name: { type: "string", description: "Business name contains this." },
      uncalled: { type: "boolean", description: "Only leads never called." },
      unemailed: { type: "boolean", description: "Only leads never emailed." },
      group_by: { type: "string", description: "Count by this column instead of listing rows, e.g. city, tier, status." },
      limit: { type: "integer", description: "Rows to return, max 50. Default 15." },
    }),
  },
  {
    name: "client_publishing",
    description:
      "What actually went live for each client: totals by type, the last 7 and 30 days, the most recent titles with dates, and the data-through date. Optional client slug or name to narrow it. Read-only.",
    input_schema: obj({ client: { type: "string", description: "Client slug or part of the name. Omit for all clients." } }),
  },
  {
    name: "send_ledger",
    description:
      "Cold email that actually went out, from the Sonar database the cloud sender writes: emails delivered to the SMTP server, send errors, prospects emailed, and the sender's daily state. Use for how many emails went out in a period. Read-only.",
    input_schema: obj({ days: { type: "integer", description: "Look-back window in days. Default 30, max 365." } }),
  },
  {
    name: "revenue_state",
    description:
      "The single source of revenue truth: MRR with its basis, the durable and expiring split, the next expiry, one-time, expected, unconfirmed and pipeline totals kept separate, and which clients have no figure on file. Read-only.",
    input_schema: obj({}),
  },
  {
    name: "call_room",
    description:
      "Call room leads and their outcomes. Filter by outcome, status, city or a minimum call count. Use for questions like who did I mark no answer twice. Read-only.",
    input_schema: obj({
      outcome: { type: "string", description: "Exact last outcome, e.g. no_answer, booked." },
      status: { type: "string" },
      city: { type: "string" },
      min_calls: { type: "integer", description: "Only leads called at least this many times." },
      limit: { type: "integer", description: "Rows to return, max 50. Default 20." },
    }),
  },
  {
    name: "nimbus_report",
    description:
      "Run your own watch over the whole business and report what is working, what is broken, and what could not be checked: cold email sending, revenue running out, client sites gone quiet, the lead pipeline, overdue call-backs and the agent fleet. This is the same check behind the alerts pushed to Jack's phone. Use it for what is broken, anything wrong, give me a report, or how are we doing.",
    input_schema: obj({}),
  },
  {
    name: "recall_memory",
    description:
      "Read everything the user has told you to remember. Your system prompt already carries this, so only call it when you are asked what you remember or you need the full file.",
    input_schema: obj({}),
  },
  {
    name: "remember",
    description:
      "Needs Jack's PC. Append one dated line to your memory file in the vault. Use it when the user says remember that, or states a lasting preference, price, rule or decision worth carrying into later conversations. Never store a credential. Requires user confirmation.",
    input_schema: obj({ fact: { type: "string", description: "One sentence, written so it still makes sense months from now." } }, ["fact"]),
  },
];

export const NIMBUS_LOCAL_WRITE_TOOLS = new Set(["remember"]);

export function isNimbusLocalTool(name: string): boolean {
  return NIMBUS_LOCAL_TOOLS.some((t) => t.name === name);
}

export async function runNimbusLocalTool(name: string, rawArgs: unknown): Promise<LocalToolOutcome> {
  const a: LocalToolArgs = rawArgs && typeof rawArgs === "object" ? (rawArgs as LocalToolArgs) : {};
  try {
    switch (name) {
      case "query_pipeline":
        return queryPipeline(a);
      case "client_publishing":
        return clientPublishing(a);
      case "send_ledger":
        return await sendLedger(a);
      case "revenue_state":
        return await revenueState();
      case "call_room":
        return await callRoom(a);
      case "nimbus_report":
        return await nimbusReport();
      case "recall_memory":
        return await recallMemory();
      case "remember":
        return remember(a);
      default:
        return fail(`unknown tool '${name}'`);
    }
  } catch (e) {
    return fail(`${name} failed: ${errText(e)}`);
  }
}

export function describeLocalAction(name: string, rawArgs: unknown): string | null {
  const a: LocalToolArgs = rawArgs && typeof rawArgs === "object" ? (rawArgs as LocalToolArgs) : {};
  if (name === "remember") return `Remember: "${str(a.fact).slice(0, 160)}"`;
  return null;
}

export function localActivityLine(name: string, rawArgs: unknown): string | null {
  const a: LocalToolArgs = rawArgs && typeof rawArgs === "object" ? (rawArgs as LocalToolArgs) : {};
  switch (name) {
    case "query_pipeline":
      return `Queried the lead pipeline${str(a.city) ? ` in ${str(a.city)}` : ""}`;
    case "client_publishing":
      return str(a.client) ? `Checked what was published for ${str(a.client)}` : "Checked client publishing";
    case "send_ledger":
      return "Read the send ledger";
    case "revenue_state":
      return "Checked revenue";
    case "call_room":
      return "Checked the call room";
    case "nimbus_report":
      return "Ran the full watch";
    case "recall_memory":
      return "Read your memory";
    default:
      return null;
  }
}
