import { NextRequest } from "next/server";
import fs from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";
import { isCloud } from "@/lib/runtime";
import { VAULT_PATH, listVaultFiles, readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

// ── Jarvis: agentic assistant for Wing Digital OS ─────────────────────────────
// Jarvis has FULL-ACCESS tools (Anthropic tool-use / function calling), enabled
// at Jack's explicit request. When Claude asks for a tool we run it here on
// Jack's PC, feed the result back, and continue the loop until Claude produces
// a final answer, which we stream to the browser. Outward-facing / destructive
// actions require an in-chat confirmation from Jack (enforced by the system
// prompt) plus hard guardrails in the tool implementations below (vault path
// containment, no raw/ writes, secret scanning, no GHL DELETE).

const MODEL = "claude-opus-5";

const VAULT_ROOT = VAULT_PATH;
const VAULT_WIKI = path.join(VAULT_ROOT, "wiki");
const GHL_CLI_DIR = "C:\\Users\\wjack\\ghl-cli";
const PROSPECTS_DB = path.join(GHL_CLI_DIR, "prospects.db");
const DAILY_COUNT_JSON = path.join(GHL_CLI_DIR, "outreach_logs", "daily_count.json");

const SYSTEM_PROMPT = `You are Jarvis, the AI assistant for Wing Digital, a DFW marketing automation agency. Owner: Jack Wing. Active clients include Jackson Roofing ($700/mo retainer). The outreach pipeline sends cold emails to roofing companies in DFW via GHL.

You are an AGENT with FULL read/write access via live tools that run on Jack's PC. Jack explicitly enabled this. Use tools to act on REAL data instead of guessing.

READ tools (no confirmation needed):
- read_vault_file: read any file from Jack's Obsidian vault (relative path).
- search_vault: keyword-search the vault wiki/ folder, returns matching files + lines.
- query_ghl: live GHL stats — total contacts, active clients, MRR, appointments this week, pipeline value.
- outreach_status: cold-email pipeline status — emails sent today, total prospects, emailed, remaining.
- business_snapshot: the two condensed live state files (business + outreach snapshot).
- web_search: search the internet (DuckDuckGo) — titles, URLs, snippets.
- fetch_url: fetch a URL and return its readable text.

WRITE / ACTION tools:
- write_vault_file: create, overwrite, or append a vault file. Never touches raw/ (hard rule) and refuses content containing secrets.
- run_outreach: trigger one outreach send (daily_outreach.py). dryRun=true previews; dryRun=false sends REAL cold emails.
- ghl_update: make a GHL API call (GET/POST/PUT). DELETE is blocked.
- run_agent: trigger one of the 4 agents: dispatch, prospector, outreach, chronicler.

CONFIRMATION RULES:
- Internal reads (any read tool, GET-only ghl_update, dry runs) need NO confirmation — just do them.
- OUTWARD-FACING or DESTRUCTIVE actions — sending real emails (run_outreach with dryRun=false, run_agent outreach), GHL writes (POST/PUT), overwriting existing vault files — require confirmation: state exactly what you're about to do, ask Jack to confirm in chat, and only execute after he says yes. One confirmation per action — never treat one yes as blanket approval for later actions.
- When a question is about current numbers, clients, the vault, or outreach, CALL A TOOL — never fabricate figures.
- Be concise, action-oriented, and direct. Jack communicates via voice, so keep responses conversational and short.`;

// ── Tool definitions (Anthropic tool-use schema) ──────────────────────────────
const TOOLS = [
  {
    name: "read_vault_file",
    description:
      "Read a single file from Jack's Obsidian vault (Jacks Ai Brain 2.0). Read-only. Provide a path relative to the vault root, e.g. 'wiki/clients/jackson-roofing.md'.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the vault root. No leading slash, no '..'.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "search_vault",
    description:
      "Search the vault's wiki/ folder for a keyword and return matching file paths plus the matching line. Read-only. Use to find where something is documented.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "Case-insensitive keyword or phrase to search for." },
      },
      required: ["keyword"],
    },
  },
  {
    name: "query_ghl",
    description:
      "Get live GoHighLevel stats for Wing Digital: total contacts, active clients, MRR, appointments this week, and open pipeline value. Read-only.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "outreach_status",
    description:
      "Get the cold-email outreach pipeline status: emails sent today, total prospects, how many have been emailed, and how many remain. Read-only.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "business_snapshot",
    description:
      "Return the two condensed, auto-generated live state files (business snapshot + outreach snapshot) from the vault. Fastest way to get a high-level current picture. Read-only.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "write_vault_file",
    description:
      "Create or edit a file in Jack's Obsidian vault. Paths under raw/ are never writable (hard business rule). Overwriting an existing file requires Jack's in-chat confirmation first; creating a new file or appending is lower-risk.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the vault root, e.g. 'wiki/clients/new-client.md'. No leading slash, no '..'." },
        content: { type: "string", description: "The content to write or append." },
        mode: { type: "string", enum: ["overwrite", "append"], description: "'overwrite' replaces/creates the file; 'append' adds to the end (creates if missing)." },
      },
      required: ["path", "content", "mode"],
    },
  },
  {
    name: "run_outreach",
    description:
      "Trigger one outreach send by running daily_outreach.py (the cold-email pipeline). dryRun=true (default) previews without sending. dryRun=false sends REAL cold emails — get Jack's in-chat confirmation before calling with dryRun=false.",
    input_schema: {
      type: "object",
      properties: {
        dryRun: { type: "boolean", description: "Preview only when true (default). False sends real emails." },
      },
      required: [],
    },
  },
  {
    name: "ghl_update",
    description:
      "Make a GoHighLevel API call. GET is read-only (no confirmation needed). POST/PUT modify CRM data — get Jack's in-chat confirmation first. DELETE is not allowed.",
    input_schema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PUT"], description: "HTTP method." },
        path: { type: "string", description: "API path, e.g. '/contacts/upsert' or '/contacts/?locationId=...'." },
        body: { type: "object", description: "JSON body for POST/PUT requests." },
      },
      required: ["method", "path"],
    },
  },
  {
    name: "web_search",
    description:
      "Search the internet (DuckDuckGo). Returns the top ~8 results with title, URL, and snippet. Read-only.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch_url",
    description:
      "Fetch a web page by URL and return its readable text (HTML stripped, capped ~8000 chars). Read-only.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch, e.g. 'https://example.com/page'." },
      },
      required: ["url"],
    },
  },
  {
    name: "run_agent",
    description:
      "Trigger one of the 4 Wing Digital agents: dispatch (morning briefing), prospector (refresh audit PDFs), outreach (cold-email send — outward-facing, confirm with Jack first unless dryRun), chronicler (vault digest). Returns stdout/stderr.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["dispatch", "prospector", "outreach", "chronicler"], description: "Which agent to run." },
        dryRun: { type: "boolean", description: "Dry run where supported (outreach, chronicler)." },
      },
      required: ["agent"],
    },
  },
];

// ── Tool implementations (ALL READ-ONLY) ──────────────────────────────────────

async function toolReadVaultFile(input: { path?: string }): Promise<string> {
  const rel = (input.path ?? "").replace(/^[/\\]+/, "");
  if (rel.includes("..")) return "ERROR: path escapes the vault. Access denied.";
  const text = await readVaultFile(rel);
  if (text === null) return `ERROR: could not read '${rel}'. It may not exist.`;
  return text.length > 20000 ? text.slice(0, 20000) + "\n...[truncated]" : text;
}

async function toolSearchVault(input: { keyword?: string }): Promise<string> {
  const keyword = (input.keyword ?? "").trim();
  if (!keyword) return "ERROR: no keyword provided.";
  const needle = keyword.toLowerCase();
  const results: string[] = [];
  const MAX = 40;

  const files = (await listVaultFiles()).filter((rel) => rel.startsWith("wiki/"));
  for (const rel of files) {
    if (results.length >= MAX) break;
    const text = await readVaultFile(rel);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (line.toLowerCase().includes(needle)) {
        results.push(`${rel}: ${line.trim().slice(0, 200)}`);
        break; // one hit per file keeps results readable
      }
    }
  }

  if (results.length === 0) return `No matches for "${keyword}" in the vault wiki.`;
  return `Matches for "${keyword}" (${results.length}${results.length >= MAX ? "+" : ""}):\n` + results.join("\n");
}

async function toolQueryGhl(): Promise<string> {
  const GHL_API_KEY = process.env.GHL_API_KEY;
  const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    return "ERROR: GHL credentials not configured on the server.";
  }
  const headers = {
    Authorization: `Bearer ${GHL_API_KEY}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  };
  async function ghlFetch(p: string) {
    try {
      const res = await fetch(`https://services.leadconnectorhq.com${p}`, { headers, cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  // Active clients + MRR come from the client-notes roster (same source /api/ghl uses),
  // NOT from GHL opp values which are one-time deal values.
  const CLIENTS_DIR = path.join(VAULT_WIKI, "clients");
  let mrr = 0;
  let activeClients = 0;
  const clientNames: string[] = [];
  try {
    const files = fs.readdirSync(CLIENTS_DIR).filter((f) => f.endsWith(".md"));
    for (const f of files) {
      const text = fs.readFileSync(path.join(CLIENTS_DIR, f), "utf-8");
      const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const kv: Record<string, string> = {};
      if (fm) {
        for (const line of fm[1].split(/\r?\n/)) {
          const m = line.match(/^(\w[\w_-]*):\s*(.+)$/);
          if (m) kv[m[1].toLowerCase()] = m[2].trim();
        }
      }
      const status = (kv["status"] || "active").toLowerCase();
      const clientMrr = kv["mrr"] ? Number(kv["mrr"]) : 0;
      if (status === "active" && clientMrr > 0) {
        mrr += clientMrr;
        activeClients++;
        clientNames.push(`${kv["client_name"] || f.replace(/\.md$/, "")} ($${clientMrr}/mo)`);
      }
    }
  } catch {
    mrr = 700;
    activeClients = 1;
    clientNames.push("Jackson Roofing ($700/mo)");
  }

  const [contacts, opportunities] = await Promise.all([
    ghlFetch(`/contacts/?locationId=${GHL_LOCATION_ID}&limit=100`),
    ghlFetch(`/opportunities/search?location_id=${GHL_LOCATION_ID}&limit=100`),
  ]);

  const totalContacts = contacts?.meta?.total ?? (contacts?.contacts?.length ?? 0);
  const allOpps = opportunities?.opportunities ?? [];
  const openOpps = allOpps.filter((o: any) => o.status === "open");
  const pipelineValue = openOpps.reduce((s: number, o: any) => s + (o.monetaryValue ?? 0), 0);

  // Appointments this week (per-calendar, like /api/ghl).
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);
  const calList = await ghlFetch(`/calendars/?locationId=${GHL_LOCATION_ID}`);
  const calendars = calList?.calendars ?? [];
  const eventBatches = await Promise.all(
    calendars.map((cal: any) =>
      ghlFetch(
        `/calendars/events?locationId=${GHL_LOCATION_ID}&calendarId=${cal.id}&startTime=${weekStart.getTime()}&endTime=${weekEnd.getTime()}`
      )
    )
  );
  const apptsThisWeek = eventBatches.flatMap((b: any) => b?.events ?? []).length;

  return JSON.stringify(
    {
      totalContacts,
      activeClients,
      activeClientList: clientNames,
      mrr: `$${mrr}/mo`,
      appointmentsThisWeek: apptsThisWeek,
      openPipelineOpportunities: openOpps.length,
      openPipelineValue: `$${pipelineValue}`,
    },
    null,
    2
  );
}

function toolOutreachStatus(): string {
  if (isCloud()) {
    return "This reads the local prospects.db via python and needs the PC online. (pcRequired)";
  }
  const out: Record<string, unknown> = {};

  // 1) daily_count.json if it exists (source of truth for "sent today" when present).
  try {
    if (fs.existsSync(DAILY_COUNT_JSON)) {
      out.daily_count_json = JSON.parse(fs.readFileSync(DAILY_COUNT_JSON, "utf-8"));
    }
  } catch {
    /* ignore */
  }

  // 2) prospects.db counts via python's stdlib sqlite3 (no node sqlite dep needed).
  try {
    const py = `import sqlite3,json
c=sqlite3.connect(r"${PROSPECTS_DB}")
total=c.execute("SELECT COUNT(*) FROM prospects").fetchone()[0]
emailed=c.execute("SELECT COUNT(*) FROM prospects WHERE emailed_at IS NOT NULL").fetchone()[0]
today=c.execute("SELECT COUNT(*) FROM prospects WHERE date(emailed_at)=date('now','localtime')").fetchone()[0]
remaining=c.execute("SELECT COUNT(*) FROM prospects WHERE status IN ('new','enriching')").fetchone()[0]
print(json.dumps({"total_prospects":total,"emailed":emailed,"emails_sent_today":today,"remaining_new_or_enriching":remaining}))`;
    const stdout = execFileSync("python", ["-c", py], {
      encoding: "utf-8",
      timeout: 15000,
    });
    Object.assign(out, JSON.parse(stdout.trim()));
  } catch (e: any) {
    out.db_error =
      "Could not read prospects.db via python. " + (e?.message ?? "unknown error");
  }

  if (Object.keys(out).length === 0) {
    return "ERROR: no outreach data available (no daily_count.json and prospects.db unreadable).";
  }
  return JSON.stringify(out, null, 2);
}

function toolBusinessSnapshot(): string {
  const files = [
    ["business-snapshot", path.join(VAULT_WIKI, "state", "business-snapshot.md")],
    ["outreach-snapshot", path.join(VAULT_WIKI, "state", "outreach-snapshot.md")],
  ];
  const parts: string[] = [];
  for (const [label, p] of files) {
    try {
      parts.push(`### ${label}\n` + fs.readFileSync(p, "utf-8"));
    } catch {
      parts.push(`### ${label}\n(unavailable)`);
    }
  }
  return parts.join("\n\n");
}

// ── Full-access tool implementations ──────────────────────────────────────────

const SECRET_PATTERNS = ["sk-", "Bearer ", "pit-", "eyJ", "api_key="];

function toolWriteVaultFile(input: { path?: string; content?: string; mode?: string }): string {
  const rel = (input.path ?? "").replace(/^[/\\]+/, "");
  if (!rel) return "ERROR: no path provided.";
  const resolved = path.resolve(VAULT_ROOT, rel);
  const rootWithSep = VAULT_ROOT.endsWith(path.sep) ? VAULT_ROOT : VAULT_ROOT + path.sep;
  if (resolved !== VAULT_ROOT && !resolved.startsWith(rootWithSep)) {
    return "ERROR: path escapes the vault. Write denied.";
  }
  // Hard business rule: nothing under raw/ is ever writable.
  const relNorm = path.relative(VAULT_ROOT, resolved).replace(/\\/g, "/").toLowerCase();
  if (relNorm === "raw" || relNorm.startsWith("raw/")) {
    return "ERROR: writes under raw/ are forbidden (hard business rule).";
  }
  const content = input.content ?? "";
  const hit = SECRET_PATTERNS.find((p) => content.includes(p));
  if (hit) {
    return `ERROR: content appears to contain a secret (matched '${hit}'). Refusing to write secrets into the vault.`;
  }
  const mode = input.mode === "append" ? "append" : "overwrite";
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const existed = fs.existsSync(resolved);
    if (mode === "append") {
      fs.appendFileSync(resolved, content, "utf-8");
    } else {
      fs.writeFileSync(resolved, content, "utf-8");
    }
    return `OK: ${mode === "append" ? "appended to" : existed ? "overwrote" : "created"} '${relNorm}' (${content.length} chars).`;
  } catch (e: any) {
    return "ERROR: write failed. " + (e?.message ?? "unknown");
  }
}

function runPythonInGhlCli(
  args: string[],
  extraEnv?: Record<string, string>
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python", args, {
      cwd: GHL_CLI_DIR,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", ...(extraEnv || {}) },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (r: { code: number; stdout: string; stderr: string }) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
    setTimeout(() => {
      child.kill();
      finish({ code: -2, stdout, stderr: stderr + "\n[timeout: killed after 120s]" });
    }, 120_000);
  });
}

async function toolRunOutreach(input: { dryRun?: boolean }): Promise<string> {
  if (isCloud()) {
    return "Outreach runs the local daily_outreach.py pipeline and needs the PC online. (pcRequired)";
  }
  const dryRun = input.dryRun !== false; // default true
  const args = ["daily_outreach.py"];
  if (dryRun) args.push("--dry-run");
  const r = await runPythonInGhlCli(args);
  return JSON.stringify(
    { dryRun, command: `python ${args.join(" ")}`, exitCode: r.code, ok: r.code === 0, stdout: r.stdout.slice(0, 8000), stderr: r.stderr.slice(0, 4000) },
    null,
    2
  );
}

// Same agent map as /api/agents/run — only the 4 known keeper agents.
const JARVIS_AGENTS: Record<string, { args: string[]; env?: Record<string, string>; note?: string }> = {
  outreach: { args: ["daily_outreach.py"] },
  chronicler: {
    args: ["chronicler.py", "--minutes", "90", "--since-watermark"],
    env: { PYTHONIOENCODING: "utf-8" },
  },
  dispatch: { args: ["dispatch_briefing.py"] },
  prospector: {
    args: ["audit_pdf_generator.py", "--from-db"],
    note: "Prospector is skill-driven (t1-lead-find). This only refreshes audit PDFs from the DB; a full scan needs a Claude session.",
  },
};

async function toolRunAgent(input: { agent?: string; dryRun?: boolean }): Promise<string> {
  if (isCloud()) {
    return "Running an agent spawns local python scripts and needs the PC online. (pcRequired)";
  }
  const agent = String(input.agent ?? "").trim();
  const cfg = JARVIS_AGENTS[agent];
  if (!cfg) {
    return `ERROR: unknown agent '${agent}'. Allowed: ${Object.keys(JARVIS_AGENTS).join(", ")}.`;
  }
  const args = [...cfg.args];
  if (input.dryRun === true && (agent === "outreach" || agent === "chronicler")) {
    args.push("--dry-run");
  }
  const r = await runPythonInGhlCli(args, cfg.env);
  return JSON.stringify(
    { agent, command: `python ${args.join(" ")}`, exitCode: r.code, ok: r.code === 0, stdout: r.stdout.slice(0, 8000), stderr: r.stderr.slice(0, 4000), note: cfg.note },
    null,
    2
  );
}

async function toolGhlUpdate(input: { method?: string; path?: string; body?: unknown }): Promise<string> {
  const method = String(input.method ?? "GET").toUpperCase();
  if (!["GET", "POST", "PUT"].includes(method)) {
    return `ERROR: method '${method}' not allowed. Only GET, POST, PUT (DELETE is blocked).`;
  }
  const apiPath = String(input.path ?? "");
  if (!apiPath.startsWith("/")) return "ERROR: path must start with '/'.";
  const GHL_API_KEY = process.env.GHL_API_KEY;
  if (!GHL_API_KEY) return "ERROR: GHL_API_KEY not configured on the server.";
  try {
    const res = await fetch(`https://services.leadconnectorhq.com${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: method === "GET" ? undefined : JSON.stringify(input.body ?? {}),
      cache: "no-store",
    });
    let text = await res.text();
    if (text.length > 12000) text = text.slice(0, 12000) + "\n...[truncated]";
    return `HTTP ${res.status} ${method} ${apiPath}\n${text}`;
  } catch (e: any) {
    return "ERROR: GHL request failed. " + (e?.message ?? "unknown");
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function toolWebSearch(input: { query?: string }): Promise<string> {
  const query = (input.query ?? "").trim();
  if (!query) return "ERROR: no query provided.";
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisBot/1.0" },
      cache: "no-store",
    });
    if (!res.ok) return `ERROR: search returned HTTP ${res.status}.`;
    const html = await res.text();
    // Parse DDG html results: each result has result__a (title/link) and result__snippet.
    const results: string[] = [];
    const blockRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>)?/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) && results.length < 8) {
      let url = m[1];
      // DDG wraps URLs as /l/?uddg=<encoded>
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          url = decodeURIComponent(uddg[1]);
        } catch {
          /* keep raw */
        }
      }
      const title = stripHtml(m[2] ?? "");
      const snippet = stripHtml(m[3] ?? "");
      if (title && url) results.push(`${results.length + 1}. ${title}\n   ${url}${snippet ? `\n   ${snippet.slice(0, 300)}` : ""}`);
    }
    if (results.length === 0) return `No results parsed for "${query}".`;
    return `Top results for "${query}":\n\n` + results.join("\n\n");
  } catch (e: any) {
    return "ERROR: search failed. " + (e?.message ?? "unknown");
  }
}

async function toolFetchUrl(input: { url?: string }): Promise<string> {
  const url = (input.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return "ERROR: url must start with http:// or https://";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisBot/1.0" },
      cache: "no-store",
      redirect: "follow",
    });
    const html = await res.text();
    let text = stripHtml(html);
    if (text.length > 8000) text = text.slice(0, 8000) + " ...[truncated]";
    return `HTTP ${res.status} ${url}\n\n${text}`;
  } catch (e: any) {
    return "ERROR: fetch failed. " + (e?.message ?? "unknown");
  }
}

async function runTool(name: string, input: any): Promise<string> {
  switch (name) {
    case "read_vault_file":
      return await toolReadVaultFile(input ?? {});
    case "search_vault":
      return await toolSearchVault(input ?? {});
    case "query_ghl":
      return await toolQueryGhl();
    case "outreach_status":
      return toolOutreachStatus();
    case "business_snapshot":
      return toolBusinessSnapshot();
    case "write_vault_file":
      return toolWriteVaultFile(input ?? {});
    case "run_outreach":
      return await toolRunOutreach(input ?? {});
    case "ghl_update":
      return await toolGhlUpdate(input ?? {});
    case "web_search":
      return await toolWebSearch(input ?? {});
    case "fetch_url":
      return await toolFetchUrl(input ?? {});
    case "run_agent":
      return await toolRunAgent(input ?? {});
    default:
      return `ERROR: unknown tool '${name}'.`;
  }
}

// ── Claude Code engine ─────────────────────────────────────────────────────────
// Jarvis primarily runs through the Claude Code CLI (Jack's subscription, full
// toolset, vault CLAUDE.md context — same trust level as the scheduled agents:
// --dangerously-skip-permissions with cwd = the vault). The Anthropic API tool
// loop below remains as a fallback if the CLI is missing or fails to spawn.

const CLAUDE_CODE_TIMEOUT_MS = 180_000;
const SESSION_FILE = "C:\\Users\\wjack\\wing-digital-os\\.jarvis-session.json";

let cachedCliPath: string | null | undefined; // undefined = not resolved yet

function findClaudeCli(): string | null {
  // Test/ops override: force the Anthropic API engine even where the CLI exists
  // (mirrors the Vercel condition, where no CLI is installed).
  if (process.env.JARVIS_DISABLE_CLI === "1") return null;
  if (cachedCliPath !== undefined) return cachedCliPath;
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(process.env.USERPROFILE ?? "C:\\Users\\wjack", ".local", "bin", "claude.exe"),
    "C:\\Users\\wjack\\.local\\bin\\claude.exe",
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        cachedCliPath = c;
        return c;
      }
    } catch {
      /* keep looking */
    }
  }
  // Same resolution the scheduler uses: (Get-Command claude).Source ≈ `where claude`.
  try {
    const out = execFileSync("where", ["claude"], { encoding: "utf-8", timeout: 5000 });
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && fs.existsSync(l));
    if (first) {
      cachedCliPath = first;
      return first;
    }
  } catch {
    /* not on PATH */
  }
  cachedCliPath = null;
  return null;
}

function readSessions(): Record<string, string> {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function saveSession(conversationId: string, sessionId: string) {
  try {
    const sessions = readSessions();
    sessions[conversationId] = sessionId;
    // Keep the file small: cap at the 50 most recent conversations.
    const keys = Object.keys(sessions);
    if (keys.length > 50) {
      for (const k of keys.slice(0, keys.length - 50)) delete sessions[k];
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2), "utf-8");
  } catch {
    /* non-fatal: continuity degrades to fresh sessions */
  }
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v =
    i.description ?? i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? i.prompt ?? i.skill;
  const s = typeof v === "string" ? v : JSON.stringify(input);
  return (s ?? "").slice(0, 60);
}

// Runs one Jarvis turn through the Claude Code CLI, streaming into `send`.
// Resolves true when the CLI handled the turn (even if it errored mid-stream —
// we've already streamed output so falling back would double-answer).
// Resolves false ONLY when the CLI never produced usable output (spawn error /
// instant exit), in which case the caller falls back to the API path.
function runClaudeCode(opts: {
  cli: string;
  userText: string;
  conversationId: string | null;
  send: (obj: any) => void;
  signal: AbortSignal;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const { cli, userText, conversationId, send, signal } = opts;
    const prevSession = conversationId ? readSessions()[conversationId] : undefined;
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--dangerously-skip-permissions",
    ];
    if (prevSession) args.push("--resume", prevSession);
    args.push(userText);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, args, { cwd: VAULT_ROOT, windowsHide: true, env: process.env });
    } catch {
      resolve(false);
      return;
    }

    let committed = false; // saw parseable CLI output → this engine owns the turn
    let done = false;
    let sawDelta = false; // partial text deltas observed → skip full-message text
    let anyText = false;
    let resultText = "";
    let buffer = "";

    const commit = () => {
      if (!committed) {
        committed = true;
        send({ engine: "claude-code" });
      }
    };
    const kill = () => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    };
    const onAbort = () => kill(); // client disconnected → don't leave the CLI running
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      if (committed) send({ text: "\n\n(Jarvis timed out after 180s — the CLI task was stopped.)" });
      kill();
    }, CLAUDE_CODE_TIMEOUT_MS);

    const handleLine = (line: string) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      commit();
      if (ev.type === "system" && ev.subtype === "init") {
        if (conversationId && ev.session_id) saveSession(conversationId, ev.session_id);
      } else if (ev.type === "stream_event") {
        const e = ev.event;
        if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          sawDelta = true;
          anyText = true;
          send({ text: e.delta.text });
        }
      } else if (ev.type === "assistant") {
        const blocks: any[] = ev.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "tool_use") {
            send({ tool: b.name, detail: summarizeToolInput(b.input) });
          } else if (b.type === "text" && b.text && !sawDelta) {
            anyText = true;
            send({ text: b.text });
          }
        }
      } else if (ev.type === "result") {
        if (typeof ev.result === "string") resultText = ev.result;
        if (conversationId && ev.session_id) saveSession(conversationId, ev.session_id);
      }
    };

    child.stdout?.on("data", (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr?.on("data", () => {
      /* progress noise */
    });

    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(ok);
    };

    child.on("error", () => {
      // ENOENT etc. — CLI unusable, fall back if nothing was streamed yet.
      if (!committed) finish(false);
    });
    child.on("close", (code) => {
      if (buffer.trim()) handleLine(buffer.trim());
      if (!committed) {
        finish(false); // produced nothing parseable → let the API path answer
        return;
      }
      // Result text is the safety net when no assistant text was streamed.
      if (!anyText && resultText) send({ text: resultText });
      else if (!anyText && code !== 0 && !signal.aborted) {
        send({ text: "(Jarvis/Claude Code exited without a reply — try again.)" });
      }
      finish(true);
    });
  });
}

// ── OS context for the API engine ─────────────────────────────────────────────
// The same live OS state limited mode reads (mission data + vault state
// snapshots + hot.md) is fed to the Anthropic API engine as system context so
// Jarvis can answer anything about the OS even when it cannot reach a tool.
async function buildOsContext(): Promise<string> {
  const [biz, outreach, hot, log, health] = await Promise.all([
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
    readVaultFile("wiki/hot.md"),
    readVaultFile("wiki/log.md"),
    readVaultFile("wiki/state/health-board.md"),
  ]);
  const parts: string[] = [];
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n...[truncated]" : s);
  if (biz) parts.push("## BUSINESS SNAPSHOT (live)\n" + cap(biz.trim(), 2500));
  if (outreach) parts.push("## OUTREACH SNAPSHOT (live)\n" + cap(outreach.trim(), 2500));
  if (hot) parts.push("## CURRENT FOCUS (hot.md)\n" + cap(hot.trim(), 3000));
  if (health) parts.push("## CLIENT HEALTH BOARD\n" + cap(health.trim(), 2500));
  if (log) {
    // Recent activity: the last ~40 log entries (headers + a couple lines each).
    const lines = log.split(/\r?\n/);
    const idxs = lines
      .map((l, i) => (l.startsWith("## ") ? i : -1))
      .filter((i) => i >= 0);
    const start = idxs.length > 40 ? idxs[idxs.length - 40] : 0;
    parts.push("## RECENT OS ACTIVITY (log.md tail)\n" + cap(lines.slice(start).join("\n").trim(), 6000));
  }
  if (parts.length === 0) return "";
  return (
    "\n\n# LIVE WING OS STATE (auto-injected, current as of this request)\n" +
    "Use this as ground truth about the OS, agents, clients, and pipeline. " +
    "Prefer tools for anything not covered here.\n\n" +
    parts.join("\n\n")
  );
}

// ── Anthropic call (non-streaming) used inside the API engine loop ─────────────
async function callAnthropic(apiKey: string, messages: any[], systemExtra: string) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT + systemExtra,
      tools: TOOLS,
      messages,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  return res.json();
}

// ── Limited mode (engine 3) ────────────────────────────────────────────────
// No Claude Code CLI and no API key (e.g. a bare Vercel deploy). Instead of
// erroring out, answer from the live vault state snapshots so Jarvis can still
// report what is going on inside the OS. Clearly labeled as limited mode.
async function runLimitedMode(send: (obj: any) => void, userText: string) {
  send({ engine: "limited" });
  const [biz, outreach, hot, log] = await Promise.all([
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
    readVaultFile("wiki/hot.md"),
    readVaultFile("wiki/log.md"),
  ]);

  const parts: string[] = [];
  parts.push("Limited mode: the full AI backend is unreachable from here, so this is a direct readout of the live OS state instead of a reasoned answer.\n");

  const q = userText.toLowerCase();
  const wantAll = !/(outreach|email|pipeline|client|mrr|focus|log|activity|agent)/.test(q);

  if (biz && (wantAll || /client|mrr|business|money|revenue/.test(q))) {
    parts.push("BUSINESS SNAPSHOT\n" + biz.trim().slice(0, 1200));
  }
  if (outreach && (wantAll || /outreach|email|pipeline|lead|prospect|sent/.test(q))) {
    parts.push("\nOUTREACH SNAPSHOT\n" + outreach.trim().slice(0, 1200));
  }
  if (hot && (wantAll || /focus|priorit|question|decision|next/.test(q))) {
    parts.push("\nCURRENT FOCUS (hot.md)\n" + hot.trim().slice(0, 1000));
  }
  if (log && (wantAll || /log|activity|agent|recent|happen|today/.test(q))) {
    const recent = log.split(/\r?\n/).filter(l => l.startsWith("## ")).slice(-8).join("\n");
    if (recent) parts.push("\nRECENT ACTIVITY (log.md)\n" + recent);
  }
  if (parts.length === 1) {
    parts.push("No vault state files are reachable right now. Try again once the vault source is connected.");
  }
  send({ text: parts.join("\n") });
}

// Engine 2: the Anthropic Messages API agent loop — first-class whenever the
// Claude Code CLI is unavailable (e.g. on Vercel). Gets the full OS context
// (mission data + vault state snapshots + hot.md) as system context, plus the
// same tool set (cloud-unsafe tools degrade gracefully with pcRequired notes).
async function runApiLoop(send: (obj: any) => void, messages: any[], userText: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await runLimitedMode(send, userText);
    return;
  }
  let systemExtra = "";
  try {
    systemExtra = await buildOsContext();
  } catch {
    /* context is best-effort; the tools still work */
  }
  try {
        // Agent loop: keep letting Claude call tools until it stops asking.
        const MAX_TURNS = 8;
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const resp = await callAnthropic(apiKey, messages, systemExtra);
          const blocks: any[] = resp.content ?? [];

          // Stream any text this turn produced.
          for (const b of blocks) {
            if (b.type === "text" && b.text) send({ text: b.text });
          }

          if (resp.stop_reason === "tool_use") {
            const toolUses = blocks.filter((b) => b.type === "tool_use");
            // Record the assistant turn verbatim (text + tool_use blocks).
            messages.push({ role: "assistant", content: blocks });

            const toolResults: any[] = [];
            for (const tu of toolUses) {
              // Tell the UI which tool is running, with a short human hint.
              const inp: any = tu.input ?? {};
              const detail =
                inp.query ?? inp.keyword ?? inp.path ?? inp.url ?? inp.agent ?? "";
              send({ tool: tu.name, detail: String(detail).slice(0, 60) });
              let result: string;
              try {
                result = await runTool(tu.name, tu.input);
              } catch (e: any) {
                result = "ERROR: " + (e?.message ?? "tool failed");
              }
              toolResults.push({
                type: "tool_result",
                tool_use_id: tu.id,
                content: result,
              });
            }
            messages.push({ role: "user", content: toolResults });
            continue; // loop again so Claude can use the results
          }

          // No tool use -> this was the final answer.
          break;
        }
  } catch (e: any) {
    send({ text: "\n\n(Jarvis hit an error: " + (e?.message ?? "unknown") + ")" });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const incoming = body.messages ?? [];
  const conversationId =
    typeof body.conversationId === "string" && body.conversationId.trim()
      ? body.conversationId.trim().slice(0, 100)
      : null;
  // Normalize history: browser sends {role, content:string}. Keep as-is.
  const messages: any[] = incoming.map((m: any) => ({ role: m.role, content: m.content }));
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (obj: any) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          closed = true; // client went away mid-stream
        }
      };

      try {
        // Engine 1: Claude Code CLI (subscription + full toolset + vault context).
        const cli = findClaudeCli();
        let handled = false;
        if (cli && userText) {
          handled = await runClaudeCode({
            cli,
            userText,
            conversationId,
            send,
            signal: req.signal,
          });
        }
        // Engine 2 (fallback): the original Anthropic API tool loop.
        if (!handled) {
          if (process.env.ANTHROPIC_API_KEY) send({ engine: "api" });
          await runApiLoop(send, messages, userText);
        }
      } catch (e: any) {
        send({ text: "\n\n(Jarvis hit an error: " + (e?.message ?? "unknown") + ")" });
      } finally {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
