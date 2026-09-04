// Shared types for the CRM pipeline UI.
//
// These mirror the /api/pipeline contract exactly. Every field the schema lets
// be NULL is nullable here too, because NULL means unknown and the UI has to be
// able to say "unknown" rather than invent a value. Optional (`?`) is used only
// where the API may legitimately omit a key; the renderer treats missing and
// null the same way, which is: say so honestly.

export type Contact = {
  id: number;
  business_name: string;
  contact_name?: string | null;
  title?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  state?: string | null;
  trade?: string | null;
  website?: string | null;
  do_not_contact?: boolean | null;
};

export type Deal = {
  id: number;
  title: string;
  value_cents?: number | null;
  status?: string | null;
  stage_id?: number | null;
  contact?: Contact | null;
};

export type Stage = {
  id: number;
  key: string;
  label: string;
  sort: number;
  is_won?: boolean | null;
  is_lost?: boolean | null;
  deals?: Deal[] | null;
  deal_count?: number | null;
  value_cents_total?: number | null;
};

export type PipelinePayload = {
  stages?: Stage[] | null;
  error?: string;
};

export type ContactsPayload = {
  contacts?: Contact[] | null;
  total?: number | null;
  error?: string;
};

export type Activity = {
  id: number;
  contact_id?: number | null;
  deal_id?: number | null;
  kind: string;
  outcome?: string | null;
  body?: string | null;
  occurred_at?: string | null;
  source?: string | null;
};

// ── honest formatters ──────────────────────────────────────────────────────
// The rule from the schema: NULL is unknown, and unknown never renders as zero.
// A deal with no quote says "not quoted". A real zero-cent deal is a different
// thing and still prints as $0, because someone actually recorded that number.

export const UNKNOWN_VALUE = "not quoted";
export const UNKNOWN_PHONE = "no phone on file";
export const UNKNOWN_EMAIL = "no email on file";
export const UNKNOWN_PERSON = "no contact name yet";

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return UNKNOWN_VALUE;
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: dollars % 1 === 0 ? 0 : 2,
  });
}

// Column totals: a stage where nothing has been quoted has no total to show,
// so it returns null and the caller prints nothing rather than "$0".
export function stageTotal(stage: Stage): string | null {
  if (stage.value_cents_total === null || stage.value_cents_total === undefined) return null;
  return money(stage.value_cents_total);
}

export function whenText(iso: string | null | undefined): string {
  if (!iso) return "date unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "date unknown";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// Returns null when the API gave neither a count nor a deals array, so the
// header can say the count is unknown instead of asserting zero.
export function countOf(stage: Stage): number | null {
  if (typeof stage.deal_count === "number") return stage.deal_count;
  if (Array.isArray(stage.deals)) return stage.deals.length;
  return null;
}

export function countText(stage: Stage): string {
  const n = countOf(stage);
  if (n === null) return "deal count unknown";
  return `${n} ${n === 1 ? "deal" : "deals"}`;
}

// ── Unified contact view (GET /api/pipeline/contact?id=) ───────────────────
// One response carries everything known about a contact. Every list is its
// own query on the server; a list that failed arrives as `null` and its name
// is in `errors`, so the UI can say "messages could not be loaded" instead of
// "no messages", which are very different things to someone about to call.

export type ContactFull = Contact & {
  source?: string | null;
  source_ref?: string | null;
  verified_at?: string | null;
  dnc_reason?: string | null;
  notes?: string | null;
  owner_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type TagRow = { contact_id: number; tag: string; created_at: string };

export type TaskItem = {
  id: number;
  contact_id: number | null;
  deal_id: number | null;
  title: string;
  body: string | null;
  due_at: string | null;
  done_at: string | null;
  source: string | null;
  created_at: string;
};

export type DealWithStage = {
  id: number;
  title: string;
  value_cents: number | null;
  status: string | null;
  stage_id: number | null;
  expected_close: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  created_at: string;
  updated_at: string;
  crm_stages: { id: number; key: string; label: string; is_won: boolean; is_lost: boolean } | null;
};

export type MessageItem = {
  id: number;
  contact_id: number | null;
  channel: "sms" | "email" | string;
  direction: "outbound" | "inbound" | string;
  to_addr: string | null;
  from_addr: string | null;
  body: string | null;
  status: string;
  error: string | null;
  created_at: string;
  status_updated_at: string | null;
};

export type SubmissionItem = {
  id: number;
  form_id: string;
  data: Record<string, unknown>;
  source_url: string | null;
  created_at: string;
  forms: { slug: string; name: string } | null;
};

export type BookingItem = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  notes: string | null;
  created_at: string;
};

export type EnrollmentItem = {
  id: string;
  sequence_id: string;
  email: string;
  current_step: number;
  status: string;
  next_send_at: string | null;
  enrolled_at: string;
  sequences: { name: string } | null;
};

export type RunLogEntry = { step_order: number; action_type: string; ok: boolean; note: string; at: string };

export type RunItem = {
  id: number;
  workflow_id: string;
  event_id: number;
  status: "running" | "done" | "failed" | "skipped" | string;
  log: RunLogEntry[] | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  workflows: { name: string } | null;
};

export type EventItem = {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
  occurred_at: string;
  processed_at: string | null;
};

export type ContactListName =
  | "tags" | "tasks" | "deals" | "activities" | "messages"
  | "submissions" | "bookings" | "enrollments" | "runs" | "events";

export type ContactDetailPayload = {
  ok?: boolean;
  error?: string;
  message?: string;
  contact?: ContactFull | null;
  tags?: TagRow[] | null;
  tasks?: TaskItem[] | null;
  deals?: DealWithStage[] | null;
  activities?: Activity[] | null;
  messages?: MessageItem[] | null;
  submissions?: SubmissionItem[] | null;
  bookings?: BookingItem[] | null;
  enrollments?: EnrollmentItem[] | null;
  runs?: RunItem[] | null;
  events?: EventItem[] | null;
  timeline?: TimelineItem[] | null;
  // Which lists hit their cap, so the UI can offer "load more" honestly.
  capped?: Partial<Record<ContactListName, boolean>>;
  errors?: { list: ContactListName; message: string }[];
};

// ── Unified timeline ──────────────────────────────────────────────────────
// One chronological list. `group` is what the filter pills key on; `kind`
// keeps the finer type so the renderer can pick a colour.
export type TimelineGroup = "messages" | "automations" | "notes" | "other";
export type TimelineKind =
  | "message" | "automation" | "trigger" | "note" | "call" | "meeting"
  | "email_log" | "sms_log" | "stage" | "form" | "booking";

export type TimelineItem = {
  id: string;
  at: string | null;
  group: TimelineGroup;
  kind: TimelineKind;
  line: string;
  detail: string | null;
  tone: "ok" | "warn" | "bad" | "muted" | "plain";
};

export const TIMELINE_FILTERS: { key: "all" | TimelineGroup; label: string }[] = [
  { key: "all", label: "All" },
  { key: "messages", label: "Messages" },
  { key: "automations", label: "Automations" },
  { key: "notes", label: "Notes and calls" },
];

// Plain-English names for automation trigger events. Kept here (not imported
// from lib/automations) so this file stays free of server-side modules.
const EVENT_WORDS: Record<string, string> = {
  "form.submitted": "A website form was filled out",
  "contact.created": "This contact was added",
  "booking.created": "They booked a call",
  "sms.received": "A text message came in",
  "call.missed": "A call was missed",
  "call.logged": "A cold call was logged",
  "deal.stage_changed": "A deal moved to a new stage",
  "task.completed": "A task was marked done",
  "manual.trigger": "An automation was run by hand",
};

function channelWord(ch: string): string {
  return ch === "sms" ? "Text" : ch === "email" ? "Email" : `${ch} message`;
}

function messageLine(m: MessageItem): { line: string; tone: TimelineItem["tone"] } {
  const w = channelWord(m.channel);
  if (m.direction === "inbound") return { line: `${w} received`, tone: "ok" };
  const s = (m.status || "").toLowerCase();
  if (s === "draft") {
    return { line: `${w} drafted, not sent: ${m.error || "reason not recorded"}`, tone: "warn" };
  }
  if (s === "failed" || s === "undelivered") {
    return { line: `${w} failed${m.error ? `: ${m.error}` : ""}`, tone: "bad" };
  }
  if (s === "queued") return { line: `${w} queued, not sent yet`, tone: "muted" };
  if (s === "sent" || s === "delivered" || s === "accepted") {
    return { line: `${w} sent (${s})`, tone: "ok" };
  }
  return { line: `${w} sent (${m.status || "status unknown"})`, tone: "plain" };
}

function activityItem(a: Activity): TimelineItem {
  const base = { id: `act-${a.id}`, at: a.occurred_at ?? null, detail: a.body ?? null };
  switch (a.kind) {
    case "stage_change": {
      const parts = (a.body || "").split("->").map((s) => s.trim());
      const line = parts.length === 2 && parts[0] && parts[1]
        ? `Stage moved: ${parts[0]} to ${parts[1]}`
        : `Stage moved${a.body ? `: ${a.body}` : ""}`;
      return { ...base, group: "notes", kind: "stage", line, detail: null, tone: "plain" };
    }
    case "call":
      return {
        ...base, group: "notes", kind: "call",
        line: a.outcome ? `Call logged: ${a.outcome}` : "Call logged, no outcome recorded",
        tone: "plain",
      };
    case "note":
      return {
        ...base, group: "notes", kind: "note",
        line: a.body ? `Note: ${a.body}` : "Note added with no text",
        detail: null, tone: "plain",
      };
    case "meeting":
      return { ...base, group: "notes", kind: "meeting", line: "Meeting logged", tone: "plain" };
    case "email":
      return { ...base, group: "notes", kind: "email_log", line: "Email logged by hand", tone: "plain" };
    case "sms":
      return { ...base, group: "notes", kind: "sms_log", line: "Text logged by hand", tone: "plain" };
    default:
      return { ...base, group: "notes", kind: "note", line: `${a.kind} logged`, tone: "plain" };
  }
}

function runItem(r: RunItem): TimelineItem {
  const name = r.workflows?.name ? `'${r.workflows.name}'` : "(name unknown)";
  const log = Array.isArray(r.log) ? r.log : [];
  const failed = log.filter((s) => !s.ok).length;
  let line: string;
  let tone: TimelineItem["tone"] = "ok";
  if (r.status === "done") {
    line = `Automation ${name} ran: ${log.length} ${log.length === 1 ? "step" : "steps"}, ${failed ? `${failed} failed` : "all fine"}`;
    if (failed) tone = "warn";
  } else if (r.status === "failed") {
    line = `Automation ${name} failed${r.error ? `: ${r.error}` : ""}`;
    tone = "bad";
  } else if (r.status === "skipped") {
    line = `Automation ${name} skipped${r.error ? `: ${r.error}` : ""}`;
    tone = "muted";
  } else if (r.status === "running") {
    line = `Automation ${name} is still running`;
    tone = "muted";
  } else {
    line = `Automation ${name}: ${r.status || "status unknown"}`;
    tone = "plain";
  }
  const detail = log.length
    ? log.map((s) => `${s.ok ? "ok" : "failed"}: ${s.note}`).join("\n")
    : null;
  return { id: `run-${r.id}`, at: r.started_at, group: "automations", kind: "automation", line, detail, tone };
}

export function buildTimeline(p: {
  activities?: Activity[] | null;
  messages?: MessageItem[] | null;
  submissions?: SubmissionItem[] | null;
  bookings?: BookingItem[] | null;
  runs?: RunItem[] | null;
  events?: EventItem[] | null;
}): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const a of p.activities ?? []) out.push(activityItem(a));
  for (const m of p.messages ?? []) {
    const { line, tone } = messageLine(m);
    out.push({ id: `msg-${m.id}`, at: m.created_at, group: "messages", kind: "message", line, detail: m.body, tone });
  }
  for (const s of p.submissions ?? []) {
    const name = s.forms?.name || (s.forms?.slug ? `'${s.forms.slug}'` : "a website form");
    const detail = s.data && typeof s.data === "object"
      ? Object.entries(s.data).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")
      : null;
    out.push({ id: `sub-${s.id}`, at: s.created_at, group: "other", kind: "form", line: `Filled out the ${name} form`, detail, tone: "ok" });
  }
  for (const b of p.bookings ?? []) {
    const when = whenText(b.starts_at);
    const st = (b.status || "").toLowerCase();
    let line = `Booked a call for ${when}`;
    let tone: TimelineItem["tone"] = "ok";
    if (st === "cancelled") { line = `Call for ${when} was cancelled`; tone = "muted"; }
    else if (st === "no_show") { line = `Did not show for the call on ${when}`; tone = "warn"; }
    else if (st === "completed") { line = `Call on ${when} took place`; }
    out.push({ id: `bk-${b.id}`, at: b.created_at, group: "other", kind: "booking", line, detail: b.notes, tone });
  }
  for (const r of p.runs ?? []) out.push(runItem(r));
  for (const e of p.events ?? []) {
    const words = EVENT_WORDS[e.type] ?? `Event '${e.type}'`;
    out.push({
      id: `ev-${e.id}`, at: e.occurred_at, group: "automations", kind: "trigger",
      line: `Trigger: ${words}${e.processed_at ? "" : " (automations have not picked it up yet)"}`,
      detail: null, tone: "muted",
    });
  }
  // Newest first. Undated items sink to the bottom rather than being invented
  // a date.
  out.sort((a, b) => {
    const ta = a.at ? Date.parse(a.at) : NaN;
    const tb = b.at ? Date.parse(b.at) : NaN;
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
  return out;
}
