// ───────────────────────────────────────────────────────────────────────────
// The automation layer's shared vocabulary. Mirrors supabase/migrations/
// 0021_automations.sql. Every module (emitters, engine, UI, forms, voice)
// imports from here so the words a workflow is built from are one list.
//
// THE ONE SAFETY RULE OF THIS LAYER: an action that would contact a human
// (send_sms, send_email) is written as a DRAFT message in the ledger unless
// ALL of these hold: the workflow is active, AUTOMATION_SEND_ENABLED=1 is set
// on the deployment, the person has no do_not_contact flag, and no revoked
// consent row exists for that address. The engine enforces it; the UI says it.
// ───────────────────────────────────────────────────────────────────────────

export const EVENT_TYPES = [
  "form.submitted",
  "contact.created",
  "booking.created",
  "sms.received",
  "call.missed",
  "call.logged",
  "deal.stage_changed",
  "task.completed",
  "manual.trigger",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// Plain-English labels for the trigger picker. "Built for someone who is not
// Jack": no machine words on screen.
export const EVENT_LABELS: Record<EventType, { label: string; hint: string }> = {
  "form.submitted": { label: "A website form is filled out", hint: "Any form you created under Forms, or one specific form" },
  "contact.created": { label: "A new contact is added", hint: "From a form, a call, a text, a booking, or by hand" },
  "booking.created": { label: "Someone books a call", hint: "Through the public booking page" },
  "sms.received": { label: "A text message comes in", hint: "Any inbound text that is not STOP or HELP" },
  "call.missed": { label: "A call is missed", hint: "Someone called a tracked number and nobody picked up" },
  "call.logged": { label: "A cold call is logged", hint: "A caller marks an outcome in the Call Room" },
  "deal.stage_changed": { label: "A deal moves to a stage", hint: "Any stage, or one specific stage" },
  "task.completed": { label: "A task is marked done", hint: "" },
  "manual.trigger": { label: "Run by hand", hint: "Only when you press Run on a contact" },
};

// Trigger filters: which payload keys a workflow may narrow on, per event.
export const TRIGGER_FILTER_KEYS: Partial<Record<EventType, { key: string; label: string }[]>> = {
  "form.submitted": [{ key: "form_slug", label: "Only this form (slug)" }],
  "call.logged": [{ key: "outcome", label: "Only this outcome (booked, callback, not_interested, no_answer)" }],
  "deal.stage_changed": [{ key: "stage_key", label: "Only when it lands in this stage (key)" }],
  "sms.received": [{ key: "contains", label: "Only if the text contains this word" }],
};

export const ACTION_TYPES = [
  "add_tag",
  "add_note",
  "create_deal",
  "move_stage",
  "enroll_sequence",
  "send_sms",
  "send_email",
  "notify_push",
  "create_task",
  "webhook",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type ActionConfigField = { key: string; label: string; kind: "text" | "textarea" | "number" | "sequence" | "stage" | "url"; required?: boolean; hint?: string };

export const ACTION_DEFS: Record<ActionType, { label: string; hint: string; fields: ActionConfigField[]; contacts_human: boolean }> = {
  add_tag: { label: "Add a tag to the contact", hint: "", contacts_human: false, fields: [{ key: "tag", label: "Tag", kind: "text", required: true }] },
  add_note: { label: "Add a note to the contact", hint: "Shows on the contact timeline", contacts_human: false, fields: [{ key: "body", label: "Note", kind: "textarea", required: true }] },
  create_deal: { label: "Create a deal in the pipeline", hint: "Skipped if the contact already has an open deal", contacts_human: false, fields: [{ key: "title", label: "Deal title", kind: "text", required: true, hint: "Merge tags allowed: {{first_name}} {{company}}" }, { key: "stage_key", label: "Starting stage", kind: "stage", required: true }] },
  move_stage: { label: "Move the contact's open deal to a stage", hint: "Does nothing if there is no open deal", contacts_human: false, fields: [{ key: "stage_key", label: "Stage", kind: "stage", required: true }] },
  enroll_sequence: { label: "Add the contact to an email sequence", hint: "Needs an email on the contact. Nothing sends from here; the sender picks it up.", contacts_human: true, fields: [{ key: "sequence_id", label: "Sequence", kind: "sequence", required: true }] },
  send_sms: { label: "Send a text message", hint: "Drafted unless sending is switched on for this deployment", contacts_human: true, fields: [{ key: "body", label: "Message", kind: "textarea", required: true, hint: "Merge tags: {{first_name}} {{company}} {{business}}" }] },
  send_email: { label: "Send an email", hint: "Drafted until a sending domain exists", contacts_human: true, fields: [{ key: "subject", label: "Subject", kind: "text", required: true }, { key: "body", label: "Body", kind: "textarea", required: true }] },
  notify_push: { label: "Push a notification to Jack's phone", hint: "", contacts_human: false, fields: [{ key: "title", label: "Title", kind: "text", required: true }, { key: "body", label: "Body", kind: "text" }] },
  create_task: { label: "Create a follow-up task", hint: "", contacts_human: false, fields: [{ key: "title", label: "Task", kind: "text", required: true }, { key: "due_in_hours", label: "Due in (hours)", kind: "number" }] },
  webhook: { label: "Call a webhook URL", hint: "POSTs the event and contact as JSON. https only.", contacts_human: false, fields: [{ key: "url", label: "URL", kind: "url", required: true }] },
};

export const MERGE_TAGS = ["{{first_name}}", "{{company}}", "{{business}}", "{{phone}}", "{{email}}", "{{city}}"] as const;

// ── Row shapes ────────────────────────────────────────────────────────────
export type EventRow = {
  id: number;
  type: EventType | string;
  client_slug: string | null;
  contact_id: number | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  processed_at: string | null;
  created_at: string;
};

export type WorkflowRow = {
  id: string;
  name: string;
  client_slug: string | null;
  status: "draft" | "active" | "paused";
  trigger_type: EventType | string;
  trigger_filter: Record<string, unknown>;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type WorkflowActionRow = {
  id: string;
  workflow_id: string;
  step_order: number;
  action_type: ActionType | string;
  config: Record<string, unknown>;
  created_at: string;
};

export type WorkflowRunLogEntry = { step_order: number; action_type: string; ok: boolean; note: string; at: string };

export type WorkflowRunRow = {
  id: number;
  workflow_id: string;
  event_id: number;
  contact_id: number | null;
  status: "running" | "done" | "failed" | "skipped";
  log: WorkflowRunLogEntry[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

export type FormRow = {
  id: string;
  slug: string;
  name: string;
  client_slug: string | null;
  fields: { key: string; label: string; type: string; required?: boolean }[];
  redirect_url: string | null;
  status: "active" | "paused";
  submissions: number;
  created_at: string;
  updated_at: string;
};

export type TaskRow = {
  id: number;
  contact_id: number | null;
  deal_id: number | null;
  client_slug: string | null;
  title: string;
  body: string | null;
  due_at: string | null;
  done_at: string | null;
  assigned_email: string | null;
  source: string | null;
  created_at: string;
};

export type ContactLite = {
  id: number;
  business_name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  do_not_contact: boolean;
};

// The payload an emitter passes in. contact_id is optional: when absent the
// engine resolves (or creates) the contact from email / phone / business_name
// in the payload, which is how a Call Room outcome or a form finally reaches
// the CRM without every emitter knowing the contacts table.
export type EmitInput = {
  type: EventType;
  client_slug?: string | null;
  contact_id?: number | null;
  payload?: Record<string, unknown> & {
    email?: string | null;
    phone?: string | null;
    first_name?: string | null;
    name?: string | null;
    business_name?: string | null;
    city?: string | null;
  };
  occurred_at?: string;
};
