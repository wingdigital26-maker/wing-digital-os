// ───────────────────────────────────────────────────────────────────────────
// Jarvis tool set for app/api/jarvis/route.ts.
//
// Every tool here reads or writes the OS Supabase directly through the
// pipeline helpers (service key), so the whole set works with Jack's PC off.
// The handful of legacy tools that shell out to python or read local disk are
// marked "needs Jack's PC" in their description and answer
// { pcRequired: true, message } in the cloud instead of failing.
//
// CONTRACT
//   JARVIS_TOOLS        Anthropic tool definitions (name, description, schema)
//   WRITE_TOOLS         names that change something. The route never runs one
//                       of these until the user confirmed it in the chat UI.
//   runJarvisTool()     execute one tool, always returns compact JSON text
//   describeAction()    one plain sentence for the confirmation card
//   toolActivityLine()  the small muted "Checked today's summary" line
//
// HONESTY RULES: a failed query is reported as { error } and never as an
// empty list or a zero. NULL from the database stays null. Every list is
// capped so a tool result never floods the model.
// ───────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { execFileSync, spawn } from "child_process";
import { isCloud } from "@/lib/runtime";
import { VAULT_PATH, listVaultFiles, readVaultFile } from "@/lib/vaultSource";
import { getRevenueTruth, BASIS_LABEL } from "@/lib/revenue";
import { sbGet, sbGetPaged, sbPost, sbPatch, esc, nullableText, SbError } from "@/app/api/pipeline/_lib";
import { sbInsertOrConflict, sbDelete } from "@/lib/automations/db";
import { emitEvent } from "@/lib/automations/emit";
import { EXPECTED_HEARTBEATS, inPcWindow } from "@/lib/watchdogExpected";
import { buildTimeline } from "@/app/components/pipeline/types";
import { researchSite, normalizeUrl, domainOf, isPublicHost } from "@/lib/siteResearch";
import type { TaskRow, WorkflowRow, WorkflowRunRow } from "@/lib/automations/types";

export type ToolArgs = Record<string, unknown>;

// A link the UI can render under the answer. `view` is an in-shell view id the
// shell's os:navigate handler understands; `href` is a routed page.
export type ToolLink = { label: string; view?: string; href?: string };

export type ToolOutcome = {
  // JSON text handed back to the model
  content: string;
  // links the UI shows under the answer (ids the result carried)
  links?: ToolLink[];
};

const GHL_CLI_DIR = "C:\\Users\\wjack\\ghl-cli";
const PROSPECTS_DB = path.join(GHL_CLI_DIR, "prospects.db");
const DAILY_COUNT_JSON = path.join(GHL_CLI_DIR, "outreach_logs", "daily_count.json");

// ── Tool definitions ─────────────────────────────────────────────────────────
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

export const JARVIS_TOOLS: ToolDef[] = [
  // ── READ: cloud-safe, straight from the OS database ──
  {
    name: "get_today_summary",
    description:
      "The Today strip: tasks due today, overdue tasks, new leads in the last 7 days (forms filled + missed calls), confirmed bookings in the next 7 days, open deals, active automations, unread inbound texts. Same numbers as the home screen. A null means that count could not be read, not zero. Start here for 'what needs my attention'.",
    input_schema: obj({}),
  },
  {
    name: "search_contacts",
    description:
      "Search CRM contacts by business name, contact name, email or phone. Returns id, names, phone, email, city, trade. Use the id with get_contact or any write tool.",
    input_schema: obj(
      { q: { type: "string", description: "Search text." }, limit: { type: "integer", description: "Max rows, default 10, max 20." } },
      ["q"]
    ),
  },
  {
    name: "get_contact",
    description:
      "Everything known about one contact: fields, tags, open tasks, deals with stage, and a timeline (calls, notes, texts, forms, bookings, automation runs), newest first.",
    input_schema: obj({ id: { type: "integer", description: "Contact id." } }, ["id"]),
  },
  {
    name: "list_tasks",
    description: "Follow-up tasks with the contact they belong to. Filter by due window.",
    input_schema: obj({
      open_only: { type: "boolean", description: "Default true. False includes completed tasks." },
      due: { type: "string", enum: ["today", "overdue", "week", "any"], description: "Due window. Default any." },
      limit: { type: "integer", description: "Default 20, max 40." },
    }),
  },
  {
    name: "list_upcoming_bookings",
    description: "Bookings in the next N days (default 7), not cancelled, soonest first, with who they are assigned to.",
    input_schema: obj({ days: { type: "integer", description: "1 to 60, default 7." } }),
  },
  {
    name: "list_workflows",
    description: "Every automation (workflow): id, name, status (draft/active/paused), trigger, action count, runs in the last 7 days.",
    input_schema: obj({}),
  },
  {
    name: "get_workflow_runs",
    description: "Recent automation runs, newest first, with workflow name, status, contact, and the step log.",
    input_schema: obj({
      workflow_id: { type: "string", description: "Only runs of this workflow (uuid). Optional." },
      limit: { type: "integer", description: "Default 15, max 40." },
    }),
  },
  {
    name: "list_recent_texts",
    description: "Recent SMS rows from the messages ledger: direction, status (draft/queued/sent/received), body, contact. Drafts are texts that were written but never sent.",
    input_schema: obj({
      limit: { type: "integer", description: "Default 15, max 40." },
      direction: { type: "string", enum: ["inbound", "outbound"], description: "Optional filter." },
    }),
  },
  {
    name: "list_sequences",
    description: "Email sequences with status, step count and enrollment counts. Nothing here sends; an external sender polls the due list.",
    input_schema: obj({}),
  },
  {
    name: "list_potential_clients",
    description: "The potential clients board: websites dropped in for research. id, domain, name, status (new/researched/contacted/proposal/won/lost), summary, research error.",
    input_schema: obj({ status: { type: "string", description: "Optional status filter." } }),
  },
  {
    name: "get_client_roster",
    description:
      "Active paying clients and the revenue truth: MRR with its basis per client, one-time and pipeline amounts kept separate, and the open money questions only Jack can answer. The only source for MRR and client count.",
    input_schema: obj({}),
  },
  {
    name: "get_agent_health",
    description: "Agent heartbeats: which scheduled agents reported recently and which are late or silent versus the expected cadence.",
    input_schema: obj({}),
  },
  {
    name: "get_system_check",
    description: "The latest Da Boss / watchdog report (is everything running, listed problems) plus a heartbeat summary. Use for 'is everything running' and 'any red flags'.",
    input_schema: obj({}),
  },
  // ── READ: vault and web ──
  {
    name: "read_vault_file",
    description: "Read one file from Jack's Obsidian vault by relative path, e.g. 'wiki/hot.md'. Read-only.",
    input_schema: obj({ path: { type: "string", description: "Path relative to the vault root. No leading slash, no '..'." } }, ["path"]),
  },
  {
    name: "search_vault",
    description: "Keyword search across the vault wiki/ folder. Returns matching files with the first matching line.",
    input_schema: obj({ keyword: { type: "string" } }, ["keyword"]),
  },
  {
    name: "business_snapshot",
    description: "The two condensed live state files (business snapshot + outreach snapshot) from the vault.",
    input_schema: obj({}),
  },
  {
    name: "web_search",
    description: "Search the internet (DuckDuckGo). Top 8 results with title, URL, snippet.",
    input_schema: obj({ query: { type: "string" } }, ["query"]),
  },
  {
    name: "fetch_url",
    description: "Fetch a web page and return its readable text (capped at 8000 chars).",
    input_schema: obj({ url: { type: "string" } }, ["url"]),
  },
  {
    name: "outreach_status",
    description: "Needs Jack's PC. Cold-email pipeline counts from the local prospects.db: emails sent today, total prospects, emailed, remaining. In the cloud this answers pcRequired.",
    input_schema: obj({}),
  },
  // ── WRITE: every one of these is confirmed by the user in the chat before it runs ──
  {
    name: "create_task",
    description: "Create a follow-up task. Optional contact, due time (ISO or hours from now), and body. Requires user confirmation.",
    input_schema: obj(
      {
        title: { type: "string" },
        contact_id: { type: "integer", description: "Optional contact the task is about." },
        due_in_hours: { type: "number", description: "Due this many hours from now. Optional." },
        due_at: { type: "string", description: "ISO timestamp. Optional, ignored if due_in_hours given." },
        body: { type: "string", description: "Details. Optional." },
      },
      ["title"]
    ),
  },
  {
    name: "complete_task",
    description: "Mark a task done. Emits task.completed so automations can react. Requires user confirmation.",
    input_schema: obj({ id: { type: "integer" } }, ["id"]),
  },
  {
    name: "add_tag",
    description: "Add a tag to a contact. Requires user confirmation.",
    input_schema: obj({ contact_id: { type: "integer" }, tag: { type: "string" } }, ["contact_id", "tag"]),
  },
  {
    name: "remove_tag",
    description: "Remove a tag from a contact. Requires user confirmation.",
    input_schema: obj({ contact_id: { type: "integer" }, tag: { type: "string" } }, ["contact_id", "tag"]),
  },
  {
    name: "add_note",
    description: "Add a note to a contact's timeline. Requires user confirmation.",
    input_schema: obj({ contact_id: { type: "integer" }, body: { type: "string" } }, ["contact_id", "body"]),
  },
  {
    name: "move_deal_stage",
    description: "Move a deal to a pipeline stage (by stage key like 'booked' or numeric stage id). Logs the stage change and fires deal.stage_changed. Requires user confirmation.",
    input_schema: obj({ deal_id: { type: "integer" }, stage: { type: "string", description: "Stage key or id." } }, ["deal_id", "stage"]),
  },
  {
    name: "create_deal",
    description: "Create a deal for a contact. value_cents is integer cents or omitted when not quoted (never 0 for unknown). Requires user confirmation.",
    input_schema: obj(
      {
        contact_id: { type: "integer" },
        title: { type: "string" },
        value_cents: { type: "integer", description: "Optional." },
        stage: { type: "string", description: "Stage key or id. Optional, defaults to the first stage." },
      },
      ["contact_id", "title"]
    ),
  },
  {
    name: "run_workflow_on_contact",
    description: "Run one automation by hand on one contact (manual.trigger). Works on drafts too. Texts and emails inside it are still drafted unless sending is switched on. Requires user confirmation.",
    input_schema: obj({ workflow_id: { type: "string" }, contact_id: { type: "integer" } }, ["workflow_id", "contact_id"]),
  },
  {
    name: "pause_workflow",
    description: "Pause an automation so it stops running on new events. Requires user confirmation.",
    input_schema: obj({ workflow_id: { type: "string" } }, ["workflow_id"]),
  },
  {
    name: "activate_workflow",
    description: "Activate an automation (needs at least one action). Activating sends nothing by itself. Requires user confirmation.",
    input_schema: obj({ workflow_id: { type: "string" } }, ["workflow_id"]),
  },
  {
    name: "add_potential_client",
    description: "Add a business website to the potential clients board and research it right away (name, phone, city, trade, services, platform, what the site lacks). Returns the summary so you can tell the user what was found. Requires user confirmation.",
    input_schema: obj({ url: { type: "string", description: "Website URL or bare domain." } }, ["url"]),
  },
  {
    name: "draft_text",
    description: "Write an SMS draft to a contact into the messages ledger with status draft. This never sends anything; Jack reviews drafts in the messaging board. Requires user confirmation.",
    input_schema: obj({ contact_id: { type: "integer" }, body: { type: "string" } }, ["contact_id", "body"]),
  },
  {
    name: "cancel_booking",
    description: "Cancel a booking by id (uuid). Requires user confirmation.",
    input_schema: obj({ id: { type: "string" } }, ["id"]),
  },
  {
    name: "write_vault_file",
    description: "Needs Jack's PC when the vault is local. Create, overwrite or append a vault file. Never writes under raw/ and refuses content that looks like a secret. Requires user confirmation.",
    input_schema: obj(
      {
        path: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"] },
      },
      ["path", "content", "mode"]
    ),
  },
  {
    name: "run_outreach",
    description: "Needs Jack's PC. Run the cold-email script daily_outreach.py. dryRun true previews; false sends REAL cold emails. Requires user confirmation. In the cloud this answers pcRequired.",
    input_schema: obj({ dryRun: { type: "boolean", description: "Default true." } }),
  },
  {
    name: "run_agent",
    description: "Needs Jack's PC. Trigger one local agent: dispatch, prospector, outreach, chronicler. Requires user confirmation. In the cloud this answers pcRequired.",
    input_schema: obj(
      {
        agent: { type: "string", enum: ["dispatch", "prospector", "outreach", "chronicler"] },
        dryRun: { type: "boolean" },
      },
      ["agent"]
    ),
  },
];

export const WRITE_TOOLS = new Set<string>([
  "create_task",
  "complete_task",
  "add_tag",
  "remove_tag",
  "add_note",
  "move_deal_stage",
  "create_deal",
  "run_workflow_on_contact",
  "pause_workflow",
  "activate_workflow",
  "add_potential_client",
  "draft_text",
  "cancel_booking",
  "write_vault_file",
  "run_outreach",
  "run_agent",
]);

export const PC_ONLY_TOOLS = new Set<string>(["outreach_status", "run_outreach", "run_agent"]);

export function isKnownTool(name: string): boolean {
  return JARVIS_TOOLS.some((t) => t.name === name);
}

// ── Small helpers ────────────────────────────────────────────────────────────
const json = (v: unknown) => JSON.stringify(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const clamp = (v: unknown, def: number, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};
const iso = (d: Date) => encodeURIComponent(d.toISOString());

function errText(e: unknown): string {
  if (e instanceof SbError) return `${e.message}${e.detail ? ` ${e.detail}` : ""}`.slice(0, 300);
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

const pcRequired = (what: string): ToolOutcome => ({
  content: json({ pcRequired: true, message: `${what} needs Jack's PC online. It is not available from the cloud.` }),
});

// Midnight today and tomorrow in Central time, as UTC instants. Same math as
// /api/home/summary so the numbers agree.
const CENTRAL = "America/Chicago";
function centralDayBounds(now: Date): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = get("hour") % 24;
  const wall = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  const offsetMs = wall - now.getTime();
  const midnightWall = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0);
  const nextMidnightWall = Date.UTC(get("year"), get("month") - 1, get("day") + 1, 0, 0, 0);
  return { start: new Date(midnightWall - offsetMs), end: new Date(nextMidnightWall - offsetMs) };
}

async function count(table: string, query: string): Promise<number | null> {
  try {
    const { total } = await sbGetPaged(table, "id", query, 0, 1);
    return typeof total === "number" && Number.isFinite(total) ? total : null;
  } catch {
    return null;
  }
}

type ContactLite = {
  id: number; business_name: string; contact_name: string | null; email: string | null;
  phone: string | null; city: string | null; trade: string | null; do_not_contact: boolean;
};
const CONTACT_LITE = "id,business_name,contact_name,email,phone,city,trade,do_not_contact";

async function getContactLite(id: number): Promise<ContactLite | null> {
  const rows = await sbGet<ContactLite>("crm_contacts", CONTACT_LITE, `id=eq.${id}`);
  return rows[0] ?? null;
}

// ── READ tools ───────────────────────────────────────────────────────────────
async function getTodaySummary(): Promise<ToolOutcome> {
  const now = new Date();
  const today = centralDayBounds(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400_000);
  const weekAhead = new Date(now.getTime() + 7 * 86400_000);
  const [tasks_due_today, tasks_overdue, new_leads_7d, bookings_upcoming_7d, open_deals, automations_active, unread_texts] =
    await Promise.all([
      count("tasks", `done_at=is.null&due_at=gte.${iso(today.start)}&due_at=lt.${iso(today.end)}`),
      count("tasks", `done_at=is.null&due_at=lt.${iso(now)}`),
      count("events", `type=in.(form.submitted,call.missed)&occurred_at=gte.${iso(weekAgo)}`),
      count("bookings", `status=eq.confirmed&starts_at=gte.${iso(now)}&starts_at=lt.${iso(weekAhead)}`),
      count("crm_deals", "status=eq.open"),
      count("workflows", "status=eq.active"),
      count("messages", "direction=eq.inbound&channel=eq.sms&read_at=is.null"),
    ]);
  return {
    content: json({
      as_of: now.toISOString(),
      note: "null = could not be read from the database, not zero",
      tasks_due_today, tasks_overdue, new_leads_7d, bookings_upcoming_7d, open_deals, automations_active, unread_texts,
    }),
    links: [
      { label: "Tasks", href: "/automations/tasks" },
      { label: "CRM", view: "crm" },
      { label: "Calendar", view: "calendar" },
    ],
  };
}

async function searchContacts(a: ToolArgs): Promise<ToolOutcome> {
  const q = str(a.q);
  if (!q) return { content: json({ error: "q is required" }) };
  const limit = clamp(a.limit, 10, 1, 20);
  const like = `*${esc(q)}*`;
  const { rows, total } = await sbGetPaged<ContactLite>(
    "crm_contacts",
    CONTACT_LITE,
    `or=(business_name.ilike.${like},contact_name.ilike.${like},email.ilike.${like},phone.ilike.${like})&order=updated_at.desc`,
    0,
    limit
  );
  return {
    content: json({ q, total, returned: rows.length, contacts: rows }),
    links: rows.slice(0, 3).map((c) => ({ label: `${c.business_name} in CRM`, view: "crm" })),
  };
}

async function getContact(a: ToolArgs): Promise<ToolOutcome> {
  const id = int(a.id);
  if (!id) return { content: json({ error: "id must be a positive integer" }) };
  const contact = (await sbGet(
    "crm_contacts",
    "id,business_name,contact_name,title,email,phone,website,city,state,trade,source,do_not_contact,dnc_reason,notes,created_at,updated_at",
    `id=eq.${id}`
  ))[0];
  if (!contact) return { content: json({ error: `No contact with id ${id}` }) };
  const email = contact.email ? String(contact.email).trim() : null;
  const settle = async <T,>(p: Promise<T[]>): Promise<T[] | null> => p.catch(() => null);
  const [tags, tasks, deals, activities, messages, submissions, bookings, runs, events] = await Promise.all([
    settle(sbGet("contact_tags", "tag,created_at", `contact_id=eq.${id}&order=created_at.desc&limit=50`)),
    settle(sbGet("tasks", "id,contact_id,deal_id,title,body,due_at,done_at,source,created_at", `contact_id=eq.${id}&done_at=is.null&order=due_at.asc.nullslast&limit=20`)),
    settle(sbGet("crm_deals", "id,title,value_cents,status,stage_id,expected_close,won_at,lost_at,lost_reason,created_at,updated_at,crm_stages(id,key,label,is_won,is_lost)", `contact_id=eq.${id}&order=updated_at.desc&limit=20`)),
    settle(sbGet("crm_activities", "id,contact_id,deal_id,kind,outcome,body,occurred_at,source", `contact_id=eq.${id}&order=occurred_at.desc&limit=40`)),
    settle(sbGet("messages", "id,contact_id,channel,direction,to_addr,from_addr,body,status,error,created_at,status_updated_at", `contact_id=eq.${id}&order=created_at.desc&limit=40`)),
    settle(sbGet("form_submissions", "id,form_id,data,source_url,created_at,forms(slug,name)", `contact_id=eq.${id}&order=created_at.desc&limit=10`)),
    settle(email ? sbGet("bookings", "id,name,email,phone,starts_at,ends_at,status,source,notes,created_at", `email=ilike.${esc(email)}&order=starts_at.desc&limit=10`) : Promise.resolve([])),
    settle(sbGet("workflow_runs", "id,workflow_id,event_id,status,log,error,started_at,finished_at,workflows(name)", `contact_id=eq.${id}&order=started_at.desc&limit=10`)),
    settle(sbGet("events", "id,type,payload,occurred_at,processed_at", `contact_id=eq.${id}&order=occurred_at.desc&limit=20`)),
  ]);
  const failed = Object.entries({ tags, tasks, deals, activities, messages, submissions, bookings, runs, events })
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  const timeline = buildTimeline({ activities, messages, submissions, bookings, runs, events })
    .slice(0, 25)
    .map((t) => ({ at: t.at, line: t.line, detail: t.detail ? String(t.detail).slice(0, 200) : null }));
  return {
    content: json({
      contact,
      tags: tags?.map((t: { tag: string }) => t.tag) ?? null,
      open_tasks: tasks,
      deals: deals?.map((d: Record<string, unknown>) => ({
        id: d.id, title: d.title, value_cents: d.value_cents, status: d.status,
        stage: (d.crm_stages as { key?: string; label?: string } | null)?.label ?? null,
        stage_key: (d.crm_stages as { key?: string } | null)?.key ?? null,
        expected_close: d.expected_close,
      })) ?? null,
      timeline,
      lists_that_could_not_load: failed,
    }),
    links: [{ label: `${contact.business_name} in CRM`, view: "crm" }],
  };
}

async function listTasks(a: ToolArgs): Promise<ToolOutcome> {
  const openOnly = a.open_only !== false;
  const due = str(a.due) || "any";
  const limit = clamp(a.limit, 20, 1, 40);
  const now = new Date();
  const today = centralDayBounds(now);
  const filters: string[] = [];
  if (openOnly) filters.push("done_at=is.null");
  if (due === "today") filters.push(`due_at=gte.${iso(today.start)}`, `due_at=lt.${iso(today.end)}`);
  else if (due === "overdue") filters.push(`due_at=lt.${iso(now)}`);
  else if (due === "week") filters.push(`due_at=gte.${iso(now)}`, `due_at=lt.${iso(new Date(now.getTime() + 7 * 86400_000))}`);
  const rows = await sbGet<TaskRow & { crm_contacts: { business_name: string; contact_name: string | null; phone: string | null } | null }>(
    "tasks",
    "id,contact_id,deal_id,title,body,due_at,done_at,source,created_at,crm_contacts(business_name,contact_name,phone)",
    [...filters, "order=due_at.asc.nullslast,created_at.desc", `limit=${limit}`].join("&")
  );
  return {
    content: json({
      filter: { open_only: openOnly, due },
      returned: rows.length,
      tasks: rows.map((t) => ({
        id: t.id, title: t.title, due_at: t.due_at, done_at: t.done_at, contact_id: t.contact_id,
        contact: t.crm_contacts ? `${t.crm_contacts.business_name}${t.crm_contacts.contact_name ? ` (${t.crm_contacts.contact_name})` : ""}` : null,
        phone: t.crm_contacts?.phone ?? null, source: t.source,
      })),
    }),
    links: [{ label: "Tasks", href: "/automations/tasks" }],
  };
}

async function listUpcomingBookings(a: ToolArgs): Promise<ToolOutcome> {
  const days = clamp(a.days, 7, 1, 60);
  const now = new Date();
  const to = new Date(now.getTime() + days * 86400_000);
  const rows = await sbGet(
    "bookings",
    "id,name,email,phone,starts_at,ends_at,status,source,client_slug,notes,assigned_to",
    `status=neq.cancelled&starts_at=gte.${iso(now)}&starts_at=lt.${iso(to)}&order=starts_at.asc&limit=40`
  );
  return {
    content: json({ days, timezone: CENTRAL, returned: rows.length, bookings: rows }),
    links: [{ label: "Calendar", view: "calendar" }],
  };
}

async function listWorkflows(): Promise<ToolOutcome> {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [workflows, actions, runs] = await Promise.all([
    sbGet<WorkflowRow>("workflows", "id,name,client_slug,status,trigger_type,trigger_filter,description,updated_at", "order=created_at.desc&limit=60"),
    sbGet<{ workflow_id: string }>("workflow_actions", "workflow_id"),
    sbGet<{ workflow_id: string; status: string }>("workflow_runs", "workflow_id,status", `started_at=gte.${encodeURIComponent(since)}`),
  ]);
  const ac = new Map<string, number>();
  for (const x of actions) ac.set(x.workflow_id, (ac.get(x.workflow_id) ?? 0) + 1);
  const rc = new Map<string, { done: number; failed: number; total: number }>();
  for (const r of runs) {
    const c = rc.get(r.workflow_id) ?? { done: 0, failed: 0, total: 0 };
    c.total++;
    if (r.status === "done") c.done++;
    if (r.status === "failed") c.failed++;
    rc.set(r.workflow_id, c);
  }
  return {
    content: json({
      returned: workflows.length,
      workflows: workflows.map((w) => ({
        id: w.id, name: w.name, status: w.status, trigger: w.trigger_type, filter: w.trigger_filter,
        client_slug: w.client_slug, actions: ac.get(w.id) ?? 0, runs_7d: rc.get(w.id) ?? { done: 0, failed: 0, total: 0 },
      })),
    }),
    links: [{ label: "Automations", href: "/automations" }],
  };
}

async function getWorkflowRuns(a: ToolArgs): Promise<ToolOutcome> {
  const limit = clamp(a.limit, 15, 1, 40);
  const wf = str(a.workflow_id);
  const filter = wf ? `&workflow_id=eq.${encodeURIComponent(wf)}` : "";
  const rows = await sbGet<WorkflowRunRow & { workflows: { name: string } | null; crm_contacts: { business_name: string } | null }>(
    "workflow_runs",
    "id,workflow_id,event_id,contact_id,status,log,error,started_at,finished_at,workflows(name),crm_contacts(business_name)",
    `order=started_at.desc&limit=${limit}${filter}`
  );
  return {
    content: json({
      returned: rows.length,
      runs: rows.map((r) => ({
        id: r.id, workflow: r.workflows?.name ?? null, workflow_id: r.workflow_id, status: r.status,
        contact_id: r.contact_id, contact: r.crm_contacts?.business_name ?? null, error: r.error,
        started_at: r.started_at, finished_at: r.finished_at,
        steps: Array.isArray(r.log) ? r.log.slice(0, 8).map((s) => `${s.ok ? "ok" : "failed"} ${s.action_type}: ${String(s.note).slice(0, 80)}`) : [],
      })),
    }),
    links: [{ label: "Automation runs", href: "/automations/runs" }],
  };
}

async function listRecentTexts(a: ToolArgs): Promise<ToolOutcome> {
  const limit = clamp(a.limit, 15, 1, 40);
  const dir = str(a.direction);
  const f = dir === "inbound" || dir === "outbound" ? `&direction=eq.${dir}` : "";
  const rows = await sbGet(
    "messages",
    "id,contact_id,client_slug,direction,to_addr,from_addr,body,status,error,created_at,read_at,crm_contacts(business_name,contact_name)",
    `channel=eq.sms${f}&order=created_at.desc&limit=${limit}`
  );
  return {
    content: json({
      returned: rows.length,
      texts: rows.map((m: Record<string, unknown>) => ({
        id: m.id, direction: m.direction, status: m.status, contact_id: m.contact_id,
        contact: (m.crm_contacts as { business_name?: string } | null)?.business_name ?? null,
        to: m.to_addr, from: m.from_addr, body: m.body ? String(m.body).slice(0, 240) : null,
        error: m.error, created_at: m.created_at, read: m.read_at != null,
      })),
    }),
    links: [{ label: "Messaging", view: "crm" }],
  };
}

async function listSequences(): Promise<ToolOutcome> {
  const [sequences, steps, enrollments] = await Promise.all([
    sbGet("sequences", "id,name,status,client_slug,description,updated_at", "order=created_at.desc&limit=40"),
    sbGet<{ sequence_id: string }>("sequence_steps", "sequence_id"),
    sbGet<{ sequence_id: string; status: string }>("sequence_enrollments", "sequence_id,status"),
  ]);
  const sc = new Map<string, number>();
  for (const s of steps) sc.set(s.sequence_id, (sc.get(s.sequence_id) ?? 0) + 1);
  const ec = new Map<string, { total: number; active: number }>();
  for (const e of enrollments) {
    const c = ec.get(e.sequence_id) ?? { total: 0, active: 0 };
    c.total++;
    if (e.status === "active") c.active++;
    ec.set(e.sequence_id, c);
  }
  return {
    content: json({
      note: "Activating a sequence sends nothing; an external sender polls the due list.",
      sequences: sequences.map((s: Record<string, unknown>) => ({
        ...s, steps: sc.get(String(s.id)) ?? 0, enrolled: ec.get(String(s.id)) ?? { total: 0, active: 0 },
      })),
    }),
    links: [{ label: "Sequences", href: "/sequences" }],
  };
}

async function listPotentialClients(a: ToolArgs): Promise<ToolOutcome> {
  const status = str(a.status);
  const f = status ? `status=eq.${esc(status)}&` : "";
  const rows = await sbGet(
    "potential_clients",
    "id,domain,website,name,phone,email,city,trade,status,summary,research_error,researched_at,crm_contact_id,created_at",
    `${f}order=created_at.desc&limit=40`
  );
  return {
    content: json({ status_filter: status || null, returned: rows.length, potential_clients: rows }),
    links: [{ label: "Clients", view: "clients" }],
  };
}

async function getClientRoster(): Promise<ToolOutcome> {
  const t = await getRevenueTruth();
  return {
    content: json({
      as_of: t.asOf,
      active_clients: t.activeClients,
      roster_source: t.rosterSource,
      mrr: t.mrr,
      mrr_basis: t.mrrBasisLine,
      clients: t.clients.map((c) => ({
        name: c.name, slug: c.slug,
        amount: c.amount, basis: BASIS_LABEL[c.basis],
        term_ends: c.term?.end ?? null, months_left: c.term?.monthsRemaining ?? null,
        invoice_backed: c.evidenceBacked, note: c.note,
      })),
      one_time_total_not_mrr: t.oneTimeTotal,
      pipeline_total_not_earned: t.pipelineTotal,
      pipeline_deals: t.pipelineDeals,
      unconfirmed_total_held_out_of_mrr: t.unconfirmedTotal,
      open_questions_for_jack: t.questions,
    }),
    links: [{ label: "Clients", view: "clients" }],
  };
}

type Beat = { agent: string; status: string; message: string | null; last_beat: string; meta?: Record<string, unknown> | null };

async function readBeats(): Promise<Beat[]> {
  return sbGet<Beat>("agent_heartbeats", "agent,status,message,last_beat,meta", "order=last_beat.desc&limit=60");
}

function judgeBeats(beats: Beat[]) {
  const now = Date.now();
  const byAgent = new Map(beats.map((b) => [b.agent, b]));
  const pcWindow = inPcWindow();
  return EXPECTED_HEARTBEATS.map((e) => {
    const b = byAgent.get(e.agent);
    if (!b) return { agent: e.agent, label: e.label, state: "never_reported", last_beat: null as string | null, message: null as string | null };
    const ageMin = Math.round((now - Date.parse(b.last_beat)) / 60000);
    const judged = e.windowed ? pcWindow : true;
    const late = judged && ageMin > e.staleMin;
    return {
      agent: e.agent, label: e.label,
      state: b.status === "error" ? "error" : b.status === "disabled" ? "disabled" : late ? "late" : judged ? "ok" : "outside_window_not_judged",
      last_beat: b.last_beat, age_minutes: ageMin, expected_within_minutes: e.staleMin, message: b.message,
    };
  });
}

async function getAgentHealth(): Promise<ToolOutcome> {
  const beats = await readBeats();
  const judged = judgeBeats(beats);
  const expectedNames = new Set(EXPECTED_HEARTBEATS.map((e) => e.agent));
  const others = beats.filter((b) => !expectedNames.has(b.agent)).slice(0, 20).map((b) => ({ agent: b.agent, status: b.status, last_beat: b.last_beat, message: b.message }));
  return {
    content: json({ checked_at: new Date().toISOString(), pc_window_now: inPcWindow(), expected: judged, other_agents_seen: others }),
    links: [{ label: "Mission Control", view: "mission" }],
  };
}

async function getSystemCheck(): Promise<ToolOutcome> {
  const [raw, beats] = await Promise.all([
    readVaultFile("wiki/state/watchdog.md").catch(() => null),
    readBeats().catch(() => null),
  ]);
  let report: Record<string, unknown>;
  if (!raw) {
    report = { available: false, message: "No Da Boss report exists yet (wiki/state/watchdog.md missing or unreadable)." };
  } else {
    const lines = raw.split(/\r?\n/);
    const head = lines[0]?.trim() ?? "";
    const updated = raw.match(/^updated:\s*(.+)$/m)?.[1]?.trim() ?? (head.match(/^DA BOSS\s*-\s*(.+)$/i)?.[1] ?? null);
    const overall = lines.find((l) => /OVERALL/i.test(l))?.trim() ?? (/^Nothing needs you\./m.test(raw) ? "Nothing needs you." : null);
    // Problem lines: either the PROBLEMS section of the old format or the
    // "- item" lines of the Da Boss sections that are asks, not resolved/blind.
    const problems: string[] = [];
    let inSection = false;
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      if (/^(#{1,4}|\*\*)?\s*PROBLEMS\b/i.test(t) && !/OVERALL/i.test(t)) { inSection = true; continue; }
      if (/^(MOST EXPENSIVE THING|ALSO YOURS TO DO|STUCK, WANTS A DECISION|CHRONIC, REPORTING HAS NOT WORKED)/i.test(t)) { inSection = true; continue; }
      if (/^(#{1,4}|\*\*)?\s*(RESOLVED|ALL\s*CLEAR|COULD NOT VERIFY)\b/i.test(t) || /^\d+ resolved:/i.test(t) || /^Everything above was measured/i.test(t)) { inSection = false; continue; }
      if (inSection && /^(?:[-*]|\d+\.)\s+/.test(t) && problems.length < 15) problems.push(t.replace(/^(?:[-*]|\d+\.)\s+/, "").slice(0, 240));
    }
    const blind = raw.match(/COULD NOT VERIFY\s*\((\d+)\)/i)?.[1] ?? raw.match(/\((\d+) check\(s\) could not be verified/i)?.[1] ?? null;
    report = { available: true, updated, overall, problem_count: problems.length, problems, could_not_verify: blind ? Number(blind) : 0 };
  }
  const heartbeats = beats ? judgeBeats(beats).filter((j) => j.state !== "ok").map((j) => ({ agent: j.label, state: j.state, last_beat: j.last_beat })) : null;
  return {
    content: json({ boss_report: report, heartbeats_not_ok: heartbeats, heartbeats_note: beats ? null : "agent_heartbeats could not be read" }),
    links: [{ label: "Mission Control", view: "mission" }],
  };
}

// ── Vault and web ────────────────────────────────────────────────────────────
async function readVault(a: ToolArgs): Promise<ToolOutcome> {
  const rel = str(a.path).replace(/^[/\\]+/, "");
  if (!rel || rel.includes("..")) return { content: json({ error: "path is required and may not contain '..'" }) };
  const text = await readVaultFile(rel);
  if (text === null) return { content: json({ error: `could not read '${rel}' (missing or unreadable)` }) };
  return { content: text.length > 16000 ? text.slice(0, 16000) + "\n...[truncated]" : text };
}

async function searchVault(a: ToolArgs): Promise<ToolOutcome> {
  const keyword = str(a.keyword);
  if (!keyword) return { content: json({ error: "keyword is required" }) };
  const needle = keyword.toLowerCase();
  const results: string[] = [];
  const files = (await listVaultFiles()).filter((rel) => rel.startsWith("wiki/"));
  for (const rel of files) {
    if (results.length >= 30) break;
    const text = await readVaultFile(rel);
    if (!text) continue;
    for (const line of text.split(/\r?\n/)) {
      if (line.toLowerCase().includes(needle)) {
        results.push(`${rel}: ${line.trim().slice(0, 180)}`);
        break;
      }
    }
  }
  return { content: results.length ? results.join("\n") : `No matches for "${keyword}" in the vault wiki.` };
}

async function businessSnapshot(): Promise<ToolOutcome> {
  const [biz, out] = await Promise.all([
    readVaultFile("wiki/state/business-snapshot.md"),
    readVaultFile("wiki/state/outreach-snapshot.md"),
  ]);
  const cap = (s: string | null) => (s ? (s.length > 3000 ? s.slice(0, 3000) + "\n...[truncated]" : s) : "(unavailable)");
  return { content: `### business-snapshot\n${cap(biz)}\n\n### outreach-snapshot\n${cap(out)}` };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function webSearch(a: ToolArgs): Promise<ToolOutcome> {
  const query = str(a.query);
  if (!query) return { content: json({ error: "query is required" }) };
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisBot/1.0" },
      cache: "no-store",
    });
    if (!res.ok) return { content: json({ error: `search returned HTTP ${res.status}` }) };
    const html = await res.text();
    const results: { title: string; url: string; snippet: string }[] = [];
    const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>)?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && results.length < 8) {
      let url = m[1];
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { /* keep */ } }
      const title = stripHtml(m[2] ?? "");
      if (title && url) results.push({ title, url, snippet: stripHtml(m[3] ?? "").slice(0, 240) });
    }
    return { content: json({ query, results }) };
  } catch (e) {
    return { content: json({ error: `search failed: ${errText(e)}` }) };
  }
}

async function fetchUrl(a: ToolArgs): Promise<ToolOutcome> {
  const url = str(a.url);
  if (!/^https?:\/\//i.test(url)) return { content: json({ error: "url must start with http:// or https://" }) };
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JarvisBot/1.0" }, cache: "no-store", redirect: "follow" });
    let text = stripHtml(await res.text());
    if (text.length > 8000) text = text.slice(0, 8000) + " ...[truncated]";
    return { content: `HTTP ${res.status} ${url}\n\n${text}` };
  } catch (e) {
    return { content: json({ error: `fetch failed: ${errText(e)}` }) };
  }
}

function outreachStatus(): ToolOutcome {
  if (isCloud()) return pcRequired("Reading prospects.db");
  const out: Record<string, unknown> = {};
  try {
    if (fs.existsSync(DAILY_COUNT_JSON)) out.daily_count_json = JSON.parse(fs.readFileSync(DAILY_COUNT_JSON, "utf-8"));
  } catch { /* optional */ }
  try {
    const py = `import sqlite3,json
c=sqlite3.connect(r"${PROSPECTS_DB}")
total=c.execute("SELECT COUNT(*) FROM prospects").fetchone()[0]
emailed=c.execute("SELECT COUNT(*) FROM prospects WHERE emailed_at IS NOT NULL").fetchone()[0]
today=c.execute("SELECT COUNT(*) FROM prospects WHERE date(emailed_at)=date('now','localtime')").fetchone()[0]
remaining=c.execute("SELECT COUNT(*) FROM prospects WHERE status IN ('new','enriching')").fetchone()[0]
print(json.dumps({"total_prospects":total,"emailed":emailed,"emails_sent_today":today,"remaining_new_or_enriching":remaining}))`;
    const stdout = execFileSync("python", ["-c", py], { encoding: "utf-8", timeout: 15000 });
    Object.assign(out, JSON.parse(stdout.trim()));
  } catch (e) {
    out.db_error = `Could not read prospects.db via python: ${errText(e)}`;
  }
  if (!Object.keys(out).length) return { content: json({ error: "no outreach data available" }) };
  return { content: json(out) };
}

// ── WRITE tools ──────────────────────────────────────────────────────────────
async function createTask(a: ToolArgs): Promise<ToolOutcome> {
  const title = str(a.title);
  if (!title) return { content: json({ error: "title is required" }) };
  let contactId: number | null = null;
  if (a.contact_id != null && a.contact_id !== "") {
    contactId = int(a.contact_id);
    if (!contactId) return { content: json({ error: "contact_id must be a positive integer" }) };
    if (!(await getContactLite(contactId))) return { content: json({ error: `No contact with id ${contactId}` }) };
  }
  let dueAt: string | null = null;
  const hours = Number(a.due_in_hours);
  if (a.due_in_hours != null && Number.isFinite(hours) && hours >= 0) dueAt = new Date(Date.now() + hours * 3600_000).toISOString();
  else if (str(a.due_at)) {
    const d = new Date(str(a.due_at));
    if (Number.isNaN(d.getTime())) return { content: json({ error: "due_at must be an ISO timestamp" }) };
    dueAt = d.toISOString();
  }
  const task = await sbPost<TaskRow>("tasks", {
    contact_id: contactId, deal_id: null, client_slug: null, title,
    body: nullableText(a.body), due_at: dueAt, assigned_email: null, source: "jarvis",
  });
  return {
    content: json({ ok: true, task: { id: task.id, title: task.title, due_at: task.due_at, contact_id: task.contact_id } }),
    links: [{ label: `Task #${task.id}`, href: "/automations/tasks" }],
  };
}

async function completeTask(a: ToolArgs): Promise<ToolOutcome> {
  const id = int(a.id);
  if (!id) return { content: json({ error: "id must be a positive integer" }) };
  const existing = (await sbGet<TaskRow>("tasks", "*", `id=eq.${id}`))[0];
  if (!existing) return { content: json({ error: `No task #${id}` }) };
  if (existing.done_at) return { content: json({ ok: true, changed: false, message: `Task #${id} was already done at ${existing.done_at}` }) };
  const updated = await sbPatch<TaskRow>("tasks", `id=eq.${id}`, { done_at: new Date().toISOString() });
  const task = updated[0];
  const event = await emitEvent({
    type: "task.completed", client_slug: task.client_slug, contact_id: task.contact_id,
    payload: { task_id: task.id, title: task.title, source: task.source, completed_by: "jarvis" },
  });
  return {
    content: json({ ok: true, task: { id: task.id, title: task.title, done_at: task.done_at }, event_id: event.id, event_error: event.error }),
    links: [{ label: "Tasks", href: "/automations/tasks" }],
  };
}

async function addTag(a: ToolArgs): Promise<ToolOutcome> {
  const contactId = int(a.contact_id);
  const tag = str(a.tag);
  if (!contactId || !tag) return { content: json({ error: "contact_id and tag are required" }) };
  const c = await getContactLite(contactId);
  if (!c) return { content: json({ error: `No contact with id ${contactId}` }) };
  const r = await sbInsertOrConflict("contact_tags", { contact_id: contactId, tag });
  return {
    content: json({ ok: true, added: !r.conflict, already_there: r.conflict, contact: c.business_name, tag }),
    links: [{ label: `${c.business_name} in CRM`, view: "crm" }],
  };
}

async function removeTag(a: ToolArgs): Promise<ToolOutcome> {
  const contactId = int(a.contact_id);
  const tag = str(a.tag);
  if (!contactId || !tag) return { content: json({ error: "contact_id and tag are required" }) };
  const rows = await sbDelete("contact_tags", `contact_id=eq.${contactId}&tag=eq.${esc(tag)}`);
  if (!rows.length) return { content: json({ ok: false, error: "That tag was not on this contact" }) };
  return { content: json({ ok: true, removed: rows.length, contact_id: contactId, tag }), links: [{ label: "CRM", view: "crm" }] };
}

async function addNote(a: ToolArgs): Promise<ToolOutcome> {
  const contactId = int(a.contact_id);
  const body = str(a.body);
  if (!contactId || !body) return { content: json({ error: "contact_id and body are required" }) };
  const c = await getContactLite(contactId);
  if (!c) return { content: json({ error: `No contact with id ${contactId}` }) };
  const created = await sbPost<{ id: number }>("crm_activities", {
    contact_id: contactId, deal_id: null, kind: "note", outcome: null, body,
    occurred_at: new Date().toISOString(), source: "jarvis", created_by: null,
  });
  return {
    content: json({ ok: true, activity_id: created.id, contact: c.business_name }),
    links: [{ label: `${c.business_name} in CRM`, view: "crm" }],
  };
}

type Stage = { id: number; key: string; label: string; is_won: boolean; is_lost: boolean };
async function resolveStage(v: unknown): Promise<Stage | null> {
  const s = str(v) || (typeof v === "number" ? String(v) : "");
  if (!s) return null;
  const asNum = Number(s);
  const filter = Number.isInteger(asNum) ? `id=eq.${asNum}` : `key=eq.${esc(s)}`;
  return (await sbGet<Stage>("crm_stages", "id,key,label,is_won,is_lost", filter))[0] ?? null;
}

async function moveDealStage(a: ToolArgs): Promise<ToolOutcome> {
  const dealId = int(a.deal_id);
  if (!dealId) return { content: json({ error: "deal_id must be a positive integer" }) };
  const before = (await sbGet<{ id: number; contact_id: number; stage_id: number; title: string; status: string }>(
    "crm_deals", "id,contact_id,stage_id,title,status", `id=eq.${dealId}`
  ))[0];
  if (!before) return { content: json({ error: `No deal with id ${dealId}` }) };
  const to = await resolveStage(a.stage);
  if (!to) return { content: json({ error: "Unknown stage. Use a stage key like 'booked' or a stage id." }) };
  if (to.id === before.stage_id) return { content: json({ ok: true, changed: false, message: `Deal is already in ${to.label}` }) };
  const from = (await sbGet<Stage>("crm_stages", "id,key,label,is_won,is_lost", `id=eq.${before.stage_id}`))[0] ?? null;
  const patch: Record<string, unknown> = { stage_id: to.id };
  const now = new Date().toISOString();
  if (to.is_won && before.status !== "won") { patch.status = "won"; patch.won_at = now; patch.lost_at = null; patch.lost_reason = null; }
  else if (to.is_lost && before.status !== "lost") { patch.status = "lost"; patch.lost_at = now; patch.won_at = null; }
  const updated = await sbPatch("crm_deals", `id=eq.${dealId}`, patch);
  if (!updated.length) throw new Error("Update matched no rows.");
  let activityError: string | null = null;
  try {
    await sbPost("crm_activities", {
      contact_id: before.contact_id, deal_id: dealId, kind: "stage_change", outcome: to.key,
      body: `${from ? from.label : `stage ${before.stage_id}`} -> ${to.label}`, source: "jarvis", created_by: null,
    });
  } catch (e) { activityError = errText(e); }
  const ev = await emitEvent({
    type: "deal.stage_changed", contact_id: before.contact_id,
    payload: { deal_id: dealId, stage_key: to.key, from_stage_key: from?.key ?? null, title: before.title },
  }).catch((e) => ({ id: null, error: errText(e) }));
  return {
    content: json({ ok: true, deal_id: dealId, title: before.title, from: from?.label ?? null, to: to.label, status: patch.status ?? before.status, activity_logged: !activityError, activity_error: activityError, event_id: ev.id, event_error: ev.error }),
    links: [{ label: "Pipeline", view: "crm" }],
  };
}

async function createDeal(a: ToolArgs): Promise<ToolOutcome> {
  const contactId = int(a.contact_id);
  const title = str(a.title);
  if (!contactId || !title) return { content: json({ error: "contact_id and title are required" }) };
  const c = await getContactLite(contactId);
  if (!c) return { content: json({ error: `No contact with id ${contactId}` }) };
  let value: number | null = null;
  if (a.value_cents != null && a.value_cents !== "") {
    const n = Number(a.value_cents);
    if (!Number.isInteger(n) || n < 0) return { content: json({ error: "value_cents must be a non-negative integer number of cents" }) };
    value = n;
  }
  let stage = await resolveStage(a.stage);
  if (!stage && a.stage != null && str(a.stage)) return { content: json({ error: "Unknown stage" }) };
  if (!stage) {
    stage = (await sbGet<Stage>("crm_stages", "id,key,label,is_won,is_lost", "order=sort.asc&limit=1"))[0] ?? null;
    if (!stage) return { content: json({ error: "No pipeline stages are configured" }) };
  }
  const created = await sbPost<{ id: number }>("crm_deals", {
    contact_id: contactId, stage_id: stage.id, title, value_cents: value,
    status: stage.is_won ? "won" : stage.is_lost ? "lost" : "open",
    expected_close: null, won_at: stage.is_won ? new Date().toISOString() : null, lost_at: stage.is_lost ? new Date().toISOString() : null, owner_id: null,
  });
  return {
    content: json({ ok: true, deal: { id: created.id, title, contact: c.business_name, stage: stage.label, value_cents: value } }),
    links: [{ label: "Pipeline", view: "crm" }],
  };
}

async function runWorkflowOnContact(a: ToolArgs): Promise<ToolOutcome> {
  const workflowId = str(a.workflow_id);
  const contactId = int(a.contact_id);
  if (!workflowId || !contactId) return { content: json({ error: "workflow_id and contact_id are required" }) };
  const wf = (await sbGet<WorkflowRow>("workflows", "*", `id=eq.${encodeURIComponent(workflowId)}`))[0];
  if (!wf) return { content: json({ error: "No such workflow" }) };
  const c = await getContactLite(contactId);
  if (!c) return { content: json({ error: `No contact with id ${contactId}` }) };
  const emitted = await emitEvent({
    type: "manual.trigger", client_slug: wf.client_slug, contact_id: contactId,
    payload: { workflow_id: wf.id, triggered_by: "jarvis" },
  });
  if (emitted.id == null) return { content: json({ ok: false, error: emitted.error }) };
  const runs = await sbGet<WorkflowRunRow>("workflow_runs", "id,status,log,error", `event_id=eq.${emitted.id}&order=started_at.asc`);
  return {
    content: json({ ok: !emitted.error, workflow: wf.name, contact: c.business_name, event_id: emitted.id, warning: emitted.error, runs: runs.map((r) => ({ id: r.id, status: r.status, error: r.error, steps: (r.log ?? []).map((s) => `${s.ok ? "ok" : "failed"} ${s.action_type}: ${String(s.note).slice(0, 80)}`) })) }),
    links: [{ label: "Automation runs", href: "/automations/runs" }],
  };
}

async function setWorkflowStatus(a: ToolArgs, status: "paused" | "active"): Promise<ToolOutcome> {
  const id = str(a.workflow_id);
  if (!id) return { content: json({ error: "workflow_id is required" }) };
  const q = `id=eq.${encodeURIComponent(id)}`;
  if (status === "active") {
    const actions = await sbGet<{ id: string }>("workflow_actions", "id", `workflow_id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!actions.length) return { content: json({ error: "This automation has no actions yet, so it cannot be activated." }) };
  }
  const rows = await sbPatch<WorkflowRow>("workflows", q, { status, updated_at: new Date().toISOString() });
  if (!rows[0]) return { content: json({ error: "That automation no longer exists" }) };
  return {
    content: json({ ok: true, workflow: rows[0].name, status: rows[0].status, note: status === "active" ? "Activating sends nothing by itself. Texts and emails stay drafts unless sending is switched on for the deployment." : null }),
    links: [{ label: rows[0].name, href: `/automations/${rows[0].id}` }],
  };
}

// Insert the row, then research the site inline (lib/siteResearch.ts, same as
// /api/potential-clients) and patch what it found. A failed research is
// recorded on the row as research_error; the row still exists.
async function addPotentialClient(a: ToolArgs): Promise<ToolOutcome> {
  const u = normalizeUrl(str(a.url));
  if (!u) return { content: json({ error: "url must be a website address like acmeroofing.com" }) };
  if (!isPublicHost(u.hostname)) return { content: json({ error: "That address points at a private or internal host, which the OS will not open." }) };
  const domain = domainOf(u);
  const r = await sbInsertOrConflict<{ id: number; domain: string; status: string }>("potential_clients", {
    domain, website: u.href, status: "new",
  });
  if (r.conflict) {
    const existing = (await sbGet("potential_clients", "id,domain,name,status,summary,created_at", `domain=eq.${esc(domain)}`))[0];
    return { content: json({ ok: true, added: false, message: "Already on the board", existing }), links: [{ label: "Clients", view: "clients" }] };
  }
  const id = r.row.id;
  let patch: Record<string, unknown>;
  let research: Record<string, unknown> | null = null;
  try {
    const s = await researchSite(u.href);
    patch = {
      website: s.website, name: s.name, phone: s.phone, email: s.email, city: s.city, state: s.state,
      trade: s.trade, services: s.services, socials: s.socials, signals: s.signals, summary: s.summary,
      researched_at: new Date().toISOString(), research_error: null, status: "researched",
    };
    research = {
      name: s.name, phone: s.phone, email: s.email, city: s.city, state: s.state, trade: s.trade,
      services: s.services.slice(0, 8), socials: Object.keys(s.socials), platform: s.signals.platform,
      has_contact_form: s.signals.has_contact_form, has_chat_widget: s.signals.has_chat_widget,
      has_online_booking: s.signals.has_online_booking, mobile_viewport: s.signals.mobile_viewport,
      summary: s.summary,
    };
  } catch (e) {
    patch = { research_error: errText(e).slice(0, 500) };
  }
  let patchError: string | null = null;
  try {
    const rows = await sbPatch("potential_clients", `id=eq.${id}`, patch);
    if (!rows.length) patchError = "Update matched no rows.";
  } catch (e) {
    patchError = errText(e);
  }
  return {
    content: json({
      ok: true, added: true, id, domain,
      status: research ? "researched" : "new",
      research,
      research_error: research ? null : ((patch.research_error as string) ?? null),
      patch_error: patchError,
    }),
    links: [{ label: "Clients", view: "clients" }],
  };
}

async function draftText(a: ToolArgs): Promise<ToolOutcome> {
  const contactId = int(a.contact_id);
  const body = str(a.body);
  if (!contactId || !body) return { content: json({ error: "contact_id and body are required" }) };
  const c = await getContactLite(contactId);
  if (!c) return { content: json({ error: `No contact with id ${contactId}` }) };
  if (!c.phone) return { content: json({ error: `${c.business_name} has no phone number on file, so no text can be drafted.` }) };
  const row = await sbPost<{ id: number }>("messages", {
    contact_id: contactId, client_slug: null, channel: "sms", direction: "outbound",
    to_addr: c.phone, from_addr: null, body: body.slice(0, 1600), status: "draft",
    error: "drafted by Jarvis, not sent", status_updated_at: new Date().toISOString(),
  });
  return {
    content: json({ ok: true, draft_id: row.id, to: c.business_name, phone: c.phone, status: "draft", sent: false, note: "Nothing was sent. The draft sits in the messages ledger for review." }),
    links: [{ label: "Messaging", view: "crm" }],
  };
}

async function cancelBooking(a: ToolArgs): Promise<ToolOutcome> {
  const id = str(a.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { content: json({ error: "id must be a booking uuid" }) };
  const rows = await sbPatch<{ id: string; name: string; starts_at: string; status: string }>("bookings", `id=eq.${encodeURIComponent(id)}`, { status: "cancelled" });
  if (!rows.length) return { content: json({ error: "No booking with that id" }) };
  return { content: json({ ok: true, booking: rows[0] }), links: [{ label: "Calendar", view: "calendar" }] };
}

const SECRET_PATTERNS = ["sk-", "Bearer ", "pit-", "eyJ", "api_key="];
function writeVaultFile(a: ToolArgs): ToolOutcome {
  if (isCloud()) return pcRequired("Writing to the vault");
  const rel = str(a.path).replace(/^[/\\]+/, "");
  if (!rel) return { content: json({ error: "path is required" }) };
  const resolved = path.resolve(VAULT_PATH, rel);
  const rootWithSep = VAULT_PATH.endsWith(path.sep) ? VAULT_PATH : VAULT_PATH + path.sep;
  if (resolved !== VAULT_PATH && !resolved.startsWith(rootWithSep)) return { content: json({ error: "path escapes the vault" }) };
  const relNorm = path.relative(VAULT_PATH, resolved).replace(/\\/g, "/").toLowerCase();
  if (relNorm === "raw" || relNorm.startsWith("raw/")) return { content: json({ error: "writes under raw/ are forbidden" }) };
  const content = str(a.content) ? String(a.content) : "";
  const hit = SECRET_PATTERNS.find((p) => content.includes(p));
  if (hit) return { content: json({ error: `content looks like it contains a secret (matched '${hit}'); refused` }) };
  const mode = a.mode === "append" ? "append" : "overwrite";
  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const existed = fs.existsSync(resolved);
    if (mode === "append") fs.appendFileSync(resolved, content, "utf-8");
    else fs.writeFileSync(resolved, content, "utf-8");
    return { content: json({ ok: true, action: mode === "append" ? "appended" : existed ? "overwrote" : "created", path: relNorm, chars: content.length }) };
  } catch (e) {
    return { content: json({ error: `write failed: ${errText(e)}` }) };
  }
}

function runPython(args: string[], extraEnv?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python", args, { cwd: GHL_CLI_DIR, env: { ...process.env, PYTHONIOENCODING: "utf-8", ...(extraEnv || {}) }, windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const finish = (r: { code: number; stdout: string; stderr: string }) => { if (!done) { done = true; resolve(r); } };
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
    setTimeout(() => { child.kill(); finish({ code: -2, stdout, stderr: stderr + "\n[timeout after 120s]" }); }, 120_000);
  });
}

async function runOutreach(a: ToolArgs): Promise<ToolOutcome> {
  if (isCloud()) return pcRequired("Running daily_outreach.py");
  const dryRun = a.dryRun !== false;
  const args = ["daily_outreach.py", ...(dryRun ? ["--dry-run"] : [])];
  const r = await runPython(args);
  return { content: json({ dryRun, command: `python ${args.join(" ")}`, exitCode: r.code, ok: r.code === 0, stdout: r.stdout.slice(0, 6000), stderr: r.stderr.slice(0, 2000) }) };
}

const AGENTS: Record<string, { args: string[]; env?: Record<string, string>; note?: string }> = {
  outreach: { args: ["daily_outreach.py"] },
  chronicler: { args: ["chronicler.py", "--minutes", "90", "--since-watermark"], env: { PYTHONIOENCODING: "utf-8" } },
  dispatch: { args: ["dispatch_briefing.py"] },
  prospector: { args: ["audit_pdf_generator.py", "--from-db"], note: "Only refreshes audit PDFs from the DB; a full scan needs a Claude session." },
};

async function runAgent(a: ToolArgs): Promise<ToolOutcome> {
  if (isCloud()) return pcRequired("Running a local agent");
  const agent = str(a.agent);
  const cfg = AGENTS[agent];
  if (!cfg) return { content: json({ error: `unknown agent '${agent}'. Allowed: ${Object.keys(AGENTS).join(", ")}` }) };
  const args = [...cfg.args];
  if (a.dryRun === true && (agent === "outreach" || agent === "chronicler")) args.push("--dry-run");
  const r = await runPython(args, cfg.env);
  return { content: json({ agent, command: `python ${args.join(" ")}`, exitCode: r.code, ok: r.code === 0, stdout: r.stdout.slice(0, 6000), stderr: r.stderr.slice(0, 2000), note: cfg.note }) };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
export async function runJarvisTool(name: string, rawArgs: unknown): Promise<ToolOutcome> {
  const a: ToolArgs = rawArgs && typeof rawArgs === "object" ? (rawArgs as ToolArgs) : {};
  try {
    switch (name) {
      case "get_today_summary": return await getTodaySummary();
      case "search_contacts": return await searchContacts(a);
      case "get_contact": return await getContact(a);
      case "list_tasks": return await listTasks(a);
      case "list_upcoming_bookings": return await listUpcomingBookings(a);
      case "list_workflows": return await listWorkflows();
      case "get_workflow_runs": return await getWorkflowRuns(a);
      case "list_recent_texts": return await listRecentTexts(a);
      case "list_sequences": return await listSequences();
      case "list_potential_clients": return await listPotentialClients(a);
      case "get_client_roster": return await getClientRoster();
      case "get_agent_health": return await getAgentHealth();
      case "get_system_check": return await getSystemCheck();
      case "read_vault_file": return await readVault(a);
      case "search_vault": return await searchVault(a);
      case "business_snapshot": return await businessSnapshot();
      case "web_search": return await webSearch(a);
      case "fetch_url": return await fetchUrl(a);
      case "outreach_status": return outreachStatus();
      case "create_task": return await createTask(a);
      case "complete_task": return await completeTask(a);
      case "add_tag": return await addTag(a);
      case "remove_tag": return await removeTag(a);
      case "add_note": return await addNote(a);
      case "move_deal_stage": return await moveDealStage(a);
      case "create_deal": return await createDeal(a);
      case "run_workflow_on_contact": return await runWorkflowOnContact(a);
      case "pause_workflow": return await setWorkflowStatus(a, "paused");
      case "activate_workflow": return await setWorkflowStatus(a, "active");
      case "add_potential_client": return await addPotentialClient(a);
      case "draft_text": return await draftText(a);
      case "cancel_booking": return await cancelBooking(a);
      case "write_vault_file": return writeVaultFile(a);
      case "run_outreach": return await runOutreach(a);
      case "run_agent": return await runAgent(a);
      default: return { content: json({ error: `unknown tool '${name}'` }) };
    }
  } catch (e) {
    // The model must hear "could not check", never a fake empty answer.
    return { content: json({ error: `${name} failed: ${errText(e)}`, could_not_check: true }) };
  }
}

// ── Human wording ────────────────────────────────────────────────────────────
function hoursWord(h: number): string {
  if (h < 1) return `${Math.round(h * 60)} minutes`;
  return h === 1 ? "1 hour" : `${Number.isInteger(h) ? h : h.toFixed(1)} hours`;
}

// One plain sentence for the confirmation card: "Create task 'Call back X' due in 2 hours".
export function describeAction(name: string, rawArgs: unknown): string {
  const a: ToolArgs = rawArgs && typeof rawArgs === "object" ? (rawArgs as ToolArgs) : {};
  const s = (k: string) => str(a[k]);
  switch (name) {
    case "create_task": {
      const h = Number(a.due_in_hours);
      const when = a.due_in_hours != null && Number.isFinite(h) ? ` due in ${hoursWord(h)}` : s("due_at") ? ` due ${s("due_at")}` : "";
      return `Create task '${s("title")}'${when}${a.contact_id ? ` for contact #${a.contact_id}` : ""}`;
    }
    case "complete_task": return `Mark task #${a.id} as done`;
    case "add_tag": return `Add tag '${s("tag")}' to contact #${a.contact_id}`;
    case "remove_tag": return `Remove tag '${s("tag")}' from contact #${a.contact_id}`;
    case "add_note": return `Add a note to contact #${a.contact_id}: "${s("body").slice(0, 120)}"`;
    case "move_deal_stage": return `Move deal #${a.deal_id} to stage '${s("stage")}'`;
    case "create_deal": return `Create deal '${s("title")}' for contact #${a.contact_id}${a.value_cents != null ? ` worth $${(Number(a.value_cents) / 100).toLocaleString()}` : ""}`;
    case "run_workflow_on_contact": return `Run automation ${s("workflow_id").slice(0, 8)} on contact #${a.contact_id}`;
    case "pause_workflow": return `Pause automation ${s("workflow_id").slice(0, 8)}`;
    case "activate_workflow": return `Activate automation ${s("workflow_id").slice(0, 8)}`;
    case "add_potential_client": return `Add ${s("url")} as a potential client`;
    case "draft_text": return `Draft a text to contact #${a.contact_id} (not sent): "${s("body").slice(0, 120)}"`;
    case "cancel_booking": return `Cancel booking ${s("id").slice(0, 8)}`;
    case "write_vault_file": return `${a.mode === "append" ? "Append to" : "Write"} vault file ${s("path")}`;
    case "run_outreach": return a.dryRun === false ? "Run outreach and SEND real cold emails" : "Dry-run the outreach script (no sends)";
    case "run_agent": return `Run the ${s("agent")} agent${a.dryRun ? " (dry run)" : ""}`;
    default: return `Run ${name}`;
  }
}

// The small muted activity line the UI shows while a tool runs.
export function toolActivityLine(name: string, rawArgs: unknown): string {
  const a: ToolArgs = rawArgs && typeof rawArgs === "object" ? (rawArgs as ToolArgs) : {};
  const s = (k: string) => str(a[k]);
  switch (name) {
    case "get_today_summary": return "Checked today's summary";
    case "search_contacts": return `Searched contacts for '${s("q").slice(0, 40)}'`;
    case "get_contact": return `Opened contact #${a.id}`;
    case "list_tasks": return "Listed tasks";
    case "list_upcoming_bookings": return "Checked upcoming bookings";
    case "list_workflows": return "Listed automations";
    case "get_workflow_runs": return "Checked automation runs";
    case "list_recent_texts": return "Read recent texts";
    case "list_sequences": return "Listed sequences";
    case "list_potential_clients": return "Checked potential clients";
    case "get_client_roster": return "Checked the client roster";
    case "get_agent_health": return "Checked agent heartbeats";
    case "get_system_check": return "Ran the system check";
    case "read_vault_file": return `Read ${s("path").slice(0, 50)}`;
    case "search_vault": return `Searched the vault for '${s("keyword").slice(0, 40)}'`;
    case "business_snapshot": return "Read the business snapshot";
    case "web_search": return `Searched the web for '${s("query").slice(0, 40)}'`;
    case "fetch_url": return `Fetched ${s("url").slice(0, 50)}`;
    case "outreach_status": return "Checked outreach status";
    default: return WRITE_TOOLS.has(name) ? describeAction(name, a) : `Ran ${name}`;
  }
}
