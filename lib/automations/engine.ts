// ───────────────────────────────────────────────────────────────────────────
// The automation engine: turns rows in `events` into `workflow_runs`.
//
// WHY THIS EXISTS
// Every other part of the OS records facts (a form came in, a call was
// missed, a deal moved). This is the only module that reads those facts and
// DOES something with them, so every rule about what an automation may do to
// a human lives here and nowhere else.
//
// HOW A RUN HAPPENS
//   1. read unprocessed events, oldest first
//   2. resolve (or create) the contact from the event payload
//   3. load active workflows for that trigger type, apply the filter + client
//      scoping, insert one workflow_runs row per match BEFORE acting
//   4. execute actions in step_order, appending to the run log per action;
//      stop on the first failure and record it
//   5. mark the event processed, even when nothing matched
//
// SAFETY RULES
//   * IDEMPOTENT: workflow_runs UNIQUE (workflow_id, event_id). A conflict on
//     insert means this event already fired this workflow, so it is skipped.
//     Two engines (an inline call and the cron) may overlap safely.
//   * SEND GATE (send_sms): a text goes out only when ALL of these hold:
//       AUTOMATION_SEND_ENABLED=1 on the deployment
//       the workflow is active
//       a contact exists and do_not_contact is false
//       no consent row for that phone (or contact) with channel sms is revoked
//       Twilio is configured (twilioCreds() is non-null)
//       the destination is a real E.164 number
//     Otherwise the message is written to the ledger as a DRAFT with the
//     plain-English reason. Nothing is ever silently dropped.
//   * send_email is ALWAYS a draft: no sending domain exists yet.
//   * enroll_sequence writes an enrollment row. It sends nothing; the external
//     sender decides, and only for active sequences.
//   * Engine actions do NOT emit new events (no deal.stage_changed from
//     move_stage). A workflow that reacts to stage changes by changing stages
//     would otherwise loop forever.
//   * NULL means unknown. Merge tags that cannot be resolved are left in place
//     and named in the log; the engine never invents a company or a city.
//   * client scoping: a workflow with client_slug fires only for events with
//     the same client_slug. A workflow with NULL client_slug fires only for
//     events with NULL client_slug (Wing's own). There is no "all clients"
//     wildcard, on purpose: a client's automation must never touch another
//     client's leads.
// ───────────────────────────────────────────────────────────────────────────
import {
  sbGet,
  sbPost,
  sbPatch,
  sbInsertOrConflict,
  SbError,
  esc,
} from "./db";
import { dueDateFrom, type StepRow } from "@/app/api/sequences/_lib";
import { twilioCreds, twilioSend, logMessage, patchMessages, webhookKey } from "@/lib/sms";
import { pushToAll } from "@/lib/push";
import type {
  ContactLite,
  EventRow,
  WorkflowActionRow,
  WorkflowRow,
  WorkflowRunLogEntry,
  WorkflowRunRow,
} from "./types";

export type ProcessSummary = {
  scanned: number;
  matched_runs: number;
  done: number;
  failed: number;
  skipped: number;
  errors: string[];
};

export type ProcessOptions = { limit?: number; onlyEventId?: number };

const CONTACT_SELECT = "id,business_name,contact_name,email,phone,city,do_not_contact";
const E164_RE = /^\+\d{8,15}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Stage = { id: number; key: string; label: string; is_won: boolean; is_lost: boolean };
type Deal = { id: number; contact_id: number; stage_id: number; title: string; status: string };

type ActionResult = { ok: boolean; note: string };

type Ctx = {
  event: EventRow;
  workflow: WorkflowRow;
  contact: ContactLite | null;
  run: WorkflowRunRow;
};

// ── Small coercions ────────────────────────────────────────────────────────
function str(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

// Best-effort E.164. A bare 10-digit US number becomes +1XXXXXXXXXX; anything
// that cannot be made unambiguous returns null rather than a guess.
export function toE164(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  if (E164_RE.test(s)) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (s.startsWith("+") && E164_RE.test(`+${digits}`)) return `+${digits}`;
  return null;
}

function lowerEmail(v: unknown): string | null {
  const s = str(v)?.toLowerCase() ?? null;
  return s && EMAIL_RE.test(s) ? s : null;
}

// ── Merge tags ─────────────────────────────────────────────────────────────
// {{first_name}} falls back to "there". Every other tag has no safe fallback:
// when the data is missing the tag stays in the text and is reported, so a
// draft never goes out reading "Hi there from {{company}}" unnoticed.
const TAG_RE = /\{\{[a-z_]+\}\}/g;

function firstNameFrom(contact: ContactLite | null, payload: Record<string, unknown>): string {
  const fromPayload = str(payload.first_name);
  const raw = contact?.contact_name?.trim() || fromPayload || str(payload.name) || "";
  const first = raw.split(/\s+/)[0] || "";
  const bad = new Set(["", "none", "there", "info", "sales", "team", "owner", "contact"]);
  return bad.has(first.toLowerCase()) ? "there" : first;
}

export function renderMerge(
  text: string,
  ctx: { contact: ContactLite | null; payload: Record<string, unknown> }
): { text: string; unresolved: string[] } {
  const { contact, payload } = ctx;
  const values: Record<string, string | null> = {
    first_name: firstNameFrom(contact, payload),
    company: contact?.business_name?.trim() || str(payload.business_name) || str(payload.company),
    business: contact?.business_name?.trim() || str(payload.business_name) || str(payload.company),
    phone: contact?.phone || toE164(payload.phone),
    email: contact?.email || lowerEmail(payload.email),
    city: contact?.city || str(payload.city),
  };
  let out = text;
  for (const [k, v] of Object.entries(values)) {
    if (v) out = out.replaceAll(`{{${k}}}`, v);
  }
  const unresolved = Array.from(new Set(out.match(TAG_RE) || []));
  return { text: out, unresolved };
}

function mergeNote(unresolved: string[]): string {
  return unresolved.length ? ` (unresolved merge tags left in place: ${unresolved.join(", ")})` : "";
}

// ── Contact resolution ─────────────────────────────────────────────────────
async function loadContact(id: number): Promise<ContactLite | null> {
  const rows = await sbGet<ContactLite>("crm_contacts", CONTACT_SELECT, `id=eq.${id}`);
  return rows[0] ?? null;
}

async function resolveContact(event: EventRow): Promise<{ contact: ContactLite | null; note: string }> {
  if (event.contact_id) {
    const c = await loadContact(event.contact_id);
    if (c) return { contact: c, note: `contact #${c.id} from event` };
    return { contact: null, note: `event named contact #${event.contact_id} but no such row exists` };
  }
  const p = event.payload || {};
  const email = lowerEmail(p.email);
  const phone = toE164(p.phone);

  if (email) {
    const rows = await sbGet<ContactLite>("crm_contacts", CONTACT_SELECT, `email=ilike.${esc(email)}&limit=1`);
    if (rows[0]) return { contact: rows[0], note: `contact #${rows[0].id} matched by email` };
  }
  if (phone) {
    const rows = await sbGet<ContactLite>("crm_contacts", CONTACT_SELECT, `phone=eq.${esc(phone)}&limit=1`);
    if (rows[0]) return { contact: rows[0], note: `contact #${rows[0].id} matched by phone` };
  }

  const businessName = str(p.business_name) || str(p.company) || str(p.name) || email || phone;
  if (!businessName) {
    return { contact: null, note: "no identity in payload (no email, phone, or business name); no contact" };
  }
  const first = str(p.first_name);
  const last = str(p.last_name);
  const contactName = str(p.name) || [first, last].filter(Boolean).join(" ") || null;
  const created = await sbPost<ContactLite>("crm_contacts", {
    business_name: businessName,
    contact_name: contactName,
    email,
    phone,
    city: str(p.city),
    source: event.type,
    source_ref: `${event.type}:${event.id}`,
  });
  return { contact: created, note: `created contact #${created.id} from payload` };
}

// ── Workflow matching ──────────────────────────────────────────────────────
function filterMatches(workflow: WorkflowRow, event: EventRow): boolean {
  const filter = workflow.trigger_filter || {};
  const payload = event.payload || {};
  for (const [key, want] of Object.entries(filter)) {
    const wantS = str(want);
    if (!wantS) continue; // an empty filter value narrows nothing
    if (key === "contains") {
      const body = str(payload.body) || "";
      if (!body.toLowerCase().includes(wantS.toLowerCase())) return false;
      continue;
    }
    const have = str(payload[key]);
    if (!have || have.toLowerCase() !== wantS.toLowerCase()) return false;
  }
  return true;
}

function scopeMatches(workflow: WorkflowRow, event: EventRow): boolean {
  return (workflow.client_slug ?? null) === (event.client_slug ?? null);
}

async function matchingWorkflows(event: EventRow): Promise<WorkflowRow[]> {
  // A manual trigger names its workflow in the payload and runs ONLY that one,
  // whatever its status: pressing Run on a draft is how you test it. Everything
  // the workflow does still passes the send gate, which requires active.
  const manualId = event.type === "manual.trigger" ? str(event.payload?.workflow_id) : null;
  if (manualId) {
    const rows = await sbGet<WorkflowRow>("workflows", "*", `id=eq.${encodeURIComponent(manualId)}`);
    return rows;
  }
  const rows = await sbGet<WorkflowRow>(
    "workflows",
    "*",
    `status=eq.active&trigger_type=eq.${esc(event.type)}&order=created_at.asc`
  );
  return rows.filter((w) => scopeMatches(w, event) && filterMatches(w, event));
}

async function loadActions(workflowIds: string[]): Promise<Map<string, WorkflowActionRow[]>> {
  const map = new Map<string, WorkflowActionRow[]>();
  if (!workflowIds.length) return map;
  const rows = await sbGet<WorkflowActionRow>(
    "workflow_actions",
    "*",
    `workflow_id=in.(${workflowIds.map(encodeURIComponent).join(",")})&order=step_order.asc`
  );
  for (const r of rows) {
    const list = map.get(r.workflow_id) || [];
    list.push(r);
    map.set(r.workflow_id, list);
  }
  return map;
}

// ── Shared lookups used by several actions ─────────────────────────────────
async function openDeal(contactId: number): Promise<Deal | null> {
  const rows = await sbGet<Deal>(
    "crm_deals",
    "id,contact_id,stage_id,title,status",
    `contact_id=eq.${contactId}&status=eq.open&order=created_at.desc&limit=1`
  );
  return rows[0] ?? null;
}

async function stageByKey(key: string): Promise<Stage | null> {
  const rows = await sbGet<Stage>("crm_stages", "id,key,label,is_won,is_lost", `key=eq.${esc(key)}`);
  return rows[0] ?? null;
}

async function stageById(id: number): Promise<Stage | null> {
  const rows = await sbGet<Stage>("crm_stages", "id,key,label,is_won,is_lost", `id=eq.${id}`);
  return rows[0] ?? null;
}

function baseUrl(): string | null {
  const b = process.env.PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "";
  return b ? b.replace(/\/+$/, "") : null;
}

// ── Actions ────────────────────────────────────────────────────────────────
type ActionFn = (cfg: Record<string, unknown>, ctx: Ctx) => Promise<ActionResult>;

const skipped = (why: string): ActionResult => ({ ok: true, note: `skipped: ${why}` });

const addTag: ActionFn = async (cfg, ctx) => {
  const tag = str(cfg.tag);
  if (!tag) throw new Error("add_tag: config.tag is required");
  if (!ctx.contact) return skipped("no contact to tag");
  const r = await sbInsertOrConflict("contact_tags", { contact_id: ctx.contact.id, tag });
  return { ok: true, note: r.conflict ? `tag "${tag}" was already on contact #${ctx.contact.id}` : `tagged contact #${ctx.contact.id} "${tag}"` };
};

const addNote: ActionFn = async (cfg, ctx) => {
  const body = str(cfg.body);
  if (!body) throw new Error("add_note: config.body is required");
  if (!ctx.contact) return skipped("no contact to note");
  const m = renderMerge(body, { contact: ctx.contact, payload: ctx.event.payload });
  await sbPost("crm_activities", {
    contact_id: ctx.contact.id,
    kind: "note",
    body: m.text,
    source: `workflow:${ctx.workflow.id}`,
  });
  return { ok: true, note: `note added to contact #${ctx.contact.id}${mergeNote(m.unresolved)}` };
};

const createDeal: ActionFn = async (cfg, ctx) => {
  const title = str(cfg.title);
  const stageKey = str(cfg.stage_key);
  if (!title) throw new Error("create_deal: config.title is required");
  if (!stageKey) throw new Error("create_deal: config.stage_key is required");
  if (!ctx.contact) return skipped("no contact to open a deal for");
  const existing = await openDeal(ctx.contact.id);
  if (existing) return skipped(`contact #${ctx.contact.id} already has open deal #${existing.id}`);
  const stage = await stageByKey(stageKey);
  if (!stage) throw new Error(`create_deal: no pipeline stage with key "${stageKey}"`);
  const m = renderMerge(title, { contact: ctx.contact, payload: ctx.event.payload });
  const now = new Date().toISOString();
  const deal = await sbPost<Deal>("crm_deals", {
    contact_id: ctx.contact.id,
    stage_id: stage.id,
    title: m.text,
    value_cents: null,
    status: stage.is_won ? "won" : stage.is_lost ? "lost" : "open",
    won_at: stage.is_won ? now : null,
    lost_at: stage.is_lost ? now : null,
  });
  await sbPost("crm_activities", {
    contact_id: ctx.contact.id,
    deal_id: deal.id,
    kind: "stage_change",
    outcome: stage.key,
    body: `created in ${stage.label}`,
    source: `workflow:${ctx.workflow.id}`,
  });
  return { ok: true, note: `deal #${deal.id} created in ${stage.label}${mergeNote(m.unresolved)}` };
};

const moveStage: ActionFn = async (cfg, ctx) => {
  const stageKey = str(cfg.stage_key);
  if (!stageKey) throw new Error("move_stage: config.stage_key is required");
  if (!ctx.contact) return skipped("no contact, so no deal to move");
  const deal = await openDeal(ctx.contact.id);
  if (!deal) return skipped(`contact #${ctx.contact.id} has no open deal`);
  const to = await stageByKey(stageKey);
  if (!to) throw new Error(`move_stage: no pipeline stage with key "${stageKey}"`);
  if (to.id === deal.stage_id) return skipped(`deal #${deal.id} is already in ${to.label}`);
  const from = await stageById(deal.stage_id);

  // Mirrors app/api/pipeline/deals/route.ts PATCH: a terminal stage implies
  // the status and stamps the close time; a non-terminal stage keeps "open".
  const patch: Record<string, unknown> = { stage_id: to.id };
  const now = new Date().toISOString();
  if (to.is_won) {
    patch.status = "won";
    patch.won_at = now;
    patch.lost_at = null;
    patch.lost_reason = null;
  } else if (to.is_lost) {
    patch.status = "lost";
    patch.lost_at = now;
    patch.won_at = null;
  }
  const updated = await sbPatch<Deal>("crm_deals", `id=eq.${deal.id}`, patch);
  if (!updated.length) throw new Error(`move_stage: deal #${deal.id} update matched no rows`);
  await sbPost("crm_activities", {
    contact_id: ctx.contact.id,
    deal_id: deal.id,
    kind: "stage_change",
    outcome: to.key,
    body: `${from ? from.label : `stage ${deal.stage_id}`} -> ${to.label}`,
    source: `workflow:${ctx.workflow.id}`,
  });
  return { ok: true, note: `deal #${deal.id} moved to ${to.label}${patch.status ? ` (${patch.status})` : ""}` };
};

const enrollSequence: ActionFn = async (cfg, ctx) => {
  const sequenceId = str(cfg.sequence_id);
  if (!sequenceId) throw new Error("enroll_sequence: config.sequence_id is required");
  if (!ctx.contact) return skipped("no contact to enroll");
  if (ctx.contact.do_not_contact) return skipped(`contact #${ctx.contact.id} is marked do not contact`);
  const email = lowerEmail(ctx.contact.email) || lowerEmail(ctx.event.payload?.email);
  if (!email) return skipped(`contact #${ctx.contact.id} has no email address`);

  const steps = await sbGet<StepRow>(
    "sequence_steps",
    "*",
    `sequence_id=eq.${encodeURIComponent(sequenceId)}&order=step_order.asc&limit=1`
  );
  if (!steps[0]) throw new Error(`enroll_sequence: sequence ${sequenceId} has no steps (or does not exist)`);

  const r = await sbInsertOrConflict<{ id: string }>("sequence_enrollments", {
    sequence_id: sequenceId,
    email,
    name: ctx.contact.contact_name,
    company: ctx.contact.business_name,
    current_step: 0,
    status: "active",
    next_send_at: dueDateFrom(new Date(), steps[0].wait_days),
  });
  if (r.conflict) return skipped(`${email} is already on this sequence`);
  return { ok: true, note: `enrolled ${email} (enrollment ${r.row.id}); nothing sent from here` };
};

async function smsRevoked(phone: string, contactId: number | null): Promise<boolean> {
  const or = contactId
    ? `or=(address.eq.${esc(phone)},contact_id.eq.${contactId})`
    : `address=eq.${esc(phone)}`;
  const rows = await sbGet<{ id: number }>("consent", "id", `channel=eq.sms&revoked_at=not.is.null&${or}&limit=1`);
  return rows.length > 0;
}

const sendSms: ActionFn = async (cfg, ctx) => {
  const template = str(cfg.body);
  if (!template) throw new Error("send_sms: config.body is required");
  const m = renderMerge(template, { contact: ctx.contact, payload: ctx.event.payload });
  const to = ctx.contact?.phone ? toE164(ctx.contact.phone) : toE164(ctx.event.payload?.phone);
  const creds = twilioCreds();

  // THE SEND GATE. Every reason is recorded, first one wins.
  let reason: string | null = null;
  if (process.env.AUTOMATION_SEND_ENABLED !== "1") reason = "sending is switched off on this deployment";
  else if (ctx.workflow.status !== "active") reason = "workflow is not active";
  else if (!ctx.contact) reason = "no contact";
  else if (ctx.contact.do_not_contact) reason = "contact opted out";
  else if (!to) reason = "no phone number";
  else if (await smsRevoked(to, ctx.contact.id)) reason = "contact opted out";
  else if (!creds) reason = "Twilio not configured";

  if (reason || !to || !creds) {
    const drafted = await logMessage({
      contact_id: ctx.contact?.id ?? null,
      client_slug: ctx.event.client_slug,
      channel: "sms",
      direction: "outbound",
      to_addr: to,
      from_addr: creds?.from ?? null,
      body: m.text,
      status: "draft",
      error: reason ?? "no phone number",
    });
    if (drafted.id == null) throw new Error(`send_sms: could not write the draft to the ledger (${drafted.error})`);
    return { ok: true, note: `drafted (message #${drafted.id}), not sent: ${reason}${mergeNote(m.unresolved)}` };
  }

  // Log BEFORE sending, exactly like /api/sms/send: an unlogged text is the
  // untracked message the ledger exists to prevent.
  const logged = await logMessage({
    contact_id: ctx.contact?.id ?? null,
    client_slug: ctx.event.client_slug,
    channel: "sms",
    direction: "outbound",
    to_addr: to,
    from_addr: creds.from,
    body: m.text,
    status: "queued",
  });
  if (logged.id == null) throw new Error(`send_sms: refused to send, could not log first (${logged.error})`);

  const base = baseUrl();
  const wk = webhookKey();
  const statusCallback = base
    ? `${base}/api/sms/status${wk ? `?k=${encodeURIComponent(wk)}` : ""}`
    : undefined;
  const sent = await twilioSend(creds, to, m.text, statusCallback);
  const now = new Date().toISOString();
  const patchErr = await patchMessages(
    `id=eq.${logged.id}`,
    sent.ok
      ? { status: sent.status || "sent", provider_sid: sent.sid, status_updated_at: now }
      : { status: "failed", error: sent.error, status_updated_at: now }
  );
  if (!sent.ok) throw new Error(`send_sms: ${sent.error} (message #${logged.id})`);
  return {
    ok: true,
    note: `sent to ${to} (message #${logged.id}, sid ${sent.sid})${patchErr ? `; ledger update failed: ${patchErr}` : ""}${mergeNote(m.unresolved)}`,
  };
};

const sendEmail: ActionFn = async (cfg, ctx) => {
  const subject = str(cfg.subject);
  const body = str(cfg.body);
  if (!subject) throw new Error("send_email: config.subject is required");
  if (!body) throw new Error("send_email: config.body is required");
  const to = lowerEmail(ctx.contact?.email) || lowerEmail(ctx.event.payload?.email);
  if (!to) return skipped("no email address on the contact");
  const s = renderMerge(subject, { contact: ctx.contact, payload: ctx.event.payload });
  const b = renderMerge(body, { contact: ctx.contact, payload: ctx.event.payload });
  const unresolved = Array.from(new Set([...s.unresolved, ...b.unresolved]));
  const drafted = await logMessage({
    contact_id: ctx.contact?.id ?? null,
    client_slug: ctx.event.client_slug,
    channel: "email",
    direction: "outbound",
    to_addr: to,
    body: `${s.text}\n\n${b.text}`,
    status: "draft",
    error: "drafted; no sending domain exists yet",
  });
  if (drafted.id == null) throw new Error(`send_email: could not write the draft to the ledger (${drafted.error})`);
  return { ok: true, note: `drafted email to ${to} (message #${drafted.id}); no sending domain exists yet${mergeNote(unresolved)}` };
};

const notifyPush: ActionFn = async (cfg, ctx) => {
  const title = str(cfg.title);
  if (!title) throw new Error("notify_push: config.title is required");
  const t = renderMerge(title, { contact: ctx.contact, payload: ctx.event.payload });
  const bodyRaw = str(cfg.body);
  const b = bodyRaw ? renderMerge(bodyRaw, { contact: ctx.contact, payload: ctx.event.payload }) : null;
  const r = await pushToAll({
    title: t.text,
    body: b?.text,
    url: ctx.contact ? "/?view=crm" : "/automations/runs",
    tag: `workflow:${ctx.workflow.id}:${ctx.event.id}`,
  });
  if (r.total === 0) {
    return { ok: true, note: "push not delivered: no subscribed devices or push is not configured on this deployment" };
  }
  return { ok: true, note: `push sent to ${r.sent} of ${r.total} devices, ${r.failed} failed` };
};

const createTask: ActionFn = async (cfg, ctx) => {
  const title = str(cfg.title);
  if (!title) throw new Error("create_task: config.title is required");
  const hoursRaw = cfg.due_in_hours;
  const hours = hoursRaw === undefined || hoursRaw === null || hoursRaw === "" ? null : Number(hoursRaw);
  if (hours !== null && !Number.isFinite(hours)) throw new Error("create_task: due_in_hours must be a number");
  const m = renderMerge(title, { contact: ctx.contact, payload: ctx.event.payload });
  const deal = ctx.contact ? await openDeal(ctx.contact.id) : null;
  const task = await sbPost<{ id: number }>("tasks", {
    contact_id: ctx.contact?.id ?? null,
    deal_id: deal?.id ?? null,
    client_slug: ctx.event.client_slug,
    title: m.text,
    due_at: hours === null ? null : new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
    source: `workflow:${ctx.workflow.id}`,
  });
  return { ok: true, note: `task #${task.id} created${hours === null ? " (no due date)" : ` due in ${hours}h`}${mergeNote(m.unresolved)}` };
};

const webhook: ActionFn = async (cfg, ctx) => {
  const url = str(cfg.url);
  if (!url) throw new Error("webhook: config.url is required");
  if (!/^https:\/\//i.test(url)) throw new Error("webhook: only https URLs are allowed");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: ctx.event,
        contact: ctx.contact,
        workflow: { id: ctx.workflow.id, name: ctx.workflow.name },
      }),
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`webhook: ${url} answered HTTP ${r.status}`);
    return { ok: true, note: `POST ${url} answered HTTP ${r.status}` };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(`webhook: ${url} did not answer within 5 s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
};

const ACTIONS: Record<string, ActionFn> = {
  add_tag: addTag,
  add_note: addNote,
  create_deal: createDeal,
  move_stage: moveStage,
  enroll_sequence: enrollSequence,
  send_sms: sendSms,
  send_email: sendEmail,
  notify_push: notifyPush,
  create_task: createTask,
  webhook,
};

// ── One run ────────────────────────────────────────────────────────────────
async function executeRun(ctx: Ctx, actions: WorkflowActionRow[]): Promise<"done" | "failed"> {
  const log: WorkflowRunLogEntry[] = [];
  let error: string | null = null;

  if (!actions.length) {
    log.push({ step_order: 0, action_type: "none", ok: true, note: "workflow has no actions", at: new Date().toISOString() });
  }

  for (const a of actions) {
    const fn = ACTIONS[a.action_type];
    try {
      if (!fn) throw new Error(`unknown action type "${a.action_type}"`);
      const r = await fn(a.config || {}, ctx);
      log.push({ step_order: a.step_order, action_type: a.action_type, ok: r.ok, note: r.note, at: new Date().toISOString() });
      if (!r.ok) {
        error = `step ${a.step_order} (${a.action_type}): ${r.note}`;
        break;
      }
    } catch (e) {
      const msg = e instanceof SbError ? `${e.message}${e.detail ? ` ${e.detail}` : ""}` : e instanceof Error ? e.message : String(e);
      log.push({ step_order: a.step_order, action_type: a.action_type, ok: false, note: msg.slice(0, 600), at: new Date().toISOString() });
      error = `step ${a.step_order} (${a.action_type}): ${msg}`.slice(0, 800);
      break; // stop on first failure; the log shows exactly how far it got
    }
  }

  const status = error ? "failed" : "done";
  await sbPatch("workflow_runs", `id=eq.${ctx.run.id}`, {
    status,
    log,
    error,
    finished_at: new Date().toISOString(),
  });
  return status;
}

// ── The loop ───────────────────────────────────────────────────────────────
export async function processEvents(opts: ProcessOptions = {}): Promise<ProcessSummary> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 25));
  const summary: ProcessSummary = { scanned: 0, matched_runs: 0, done: 0, failed: 0, skipped: 0, errors: [] };

  const query = opts.onlyEventId
    ? `id=eq.${opts.onlyEventId}&processed_at=is.null&limit=1`
    : `processed_at=is.null&order=created_at.asc&limit=${limit}`;
  const events = await sbGet<EventRow>("events", "*", query);

  for (const event of events) {
    summary.scanned++;
    try {
      await processOne(event, summary);
    } catch (e) {
      // The event stays unprocessed so the cron retries it; the failure is
      // reported, never swallowed.
      const msg = e instanceof SbError ? `${e.message}${e.detail ? ` ${e.detail}` : ""}` : e instanceof Error ? e.message : String(e);
      summary.errors.push(`event #${event.id} (${event.type}): ${msg}`.slice(0, 800));
    }
  }
  return summary;
}

async function processOne(event: EventRow, summary: ProcessSummary): Promise<void> {
  const resolved = await resolveContact(event);
  const contact = resolved.contact;
  if (contact && contact.id !== event.contact_id) {
    await sbPatch("events", `id=eq.${event.id}`, { contact_id: contact.id });
    event.contact_id = contact.id;
  }

  const workflows = await matchingWorkflows(event);
  const actionsByWorkflow = await loadActions(workflows.map((w) => w.id));

  for (const workflow of workflows) {
    const inserted = await sbInsertOrConflict<WorkflowRunRow>("workflow_runs", {
      workflow_id: workflow.id,
      event_id: event.id,
      contact_id: contact?.id ?? null,
      status: "running",
      log: [{ step_order: 0, action_type: "resolve_contact", ok: true, note: resolved.note, at: new Date().toISOString() }],
    });
    if (inserted.conflict) {
      summary.skipped++;
      continue; // this event already ran this workflow
    }
    summary.matched_runs++;
    const run = inserted.row;
    const ctx: Ctx = { event, workflow, contact, run };
    try {
      const status = await executeRun(ctx, actionsByWorkflow.get(workflow.id) || []);
      if (status === "done") summary.done++;
      else summary.failed++;
    } catch (e) {
      // executeRun catches per-action errors itself; reaching here means the
      // run row could not be finalized. Try once more to leave evidence.
      summary.failed++;
      const msg = e instanceof Error ? e.message : String(e);
      summary.errors.push(`run #${run.id}: ${msg}`.slice(0, 800));
      await sbPatch("workflow_runs", `id=eq.${run.id}`, {
        status: "failed",
        error: msg.slice(0, 800),
        finished_at: new Date().toISOString(),
      }).catch(() => undefined);
    }
  }

  await sbPatch("events", `id=eq.${event.id}`, { processed_at: new Date().toISOString() });
}

// Runs that have been "running" for longer than any serverless invocation can
// live are dead. Mark them so the board does not show a spinner forever.
export async function failStuckRuns(olderThanMinutes = 10): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const rows = await sbPatch<{ id: number }>(
    "workflow_runs",
    `status=eq.running&started_at=lt.${encodeURIComponent(cutoff)}`,
    { status: "failed", error: "timed out", finished_at: new Date().toISOString() }
  );
  return rows.length;
}
