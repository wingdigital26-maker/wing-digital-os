// Shared plumbing for the workflow CRUD routes under /api/automations
// (route.ts, [id]/route.ts, actions/route.ts, seed/route.ts).
//
// The engine (lib/automations/engine.ts) and the run/runs/tasks/tags routes
// are owned elsewhere; this file only knows how to read and write the
// workflows + workflow_actions tables honestly and validate what a staff
// member typed against the shared vocabulary in lib/automations/types.ts.
//
// Nothing in here sends anything. Activating a workflow flips a status column.
import {
  ACTION_DEFS,
  ACTION_TYPES,
  EVENT_TYPES,
  type ActionType,
  type EventType,
  type WorkflowActionRow,
  type WorkflowRow,
  type WorkflowRunRow,
} from "@/lib/automations/types";

export {
  requireStaff,
  isAuthFailure,
  errorResponse,
  badRequest,
  nullableText,
  sbGet,
  sbPost,
  sbPatch,
  SbError,
} from "@/app/api/pipeline/_lib";
export { sbDelete } from "@/app/api/sequences/_lib";

export type { WorkflowRow, WorkflowActionRow, WorkflowRunRow };

export const WORKFLOW_STATUSES = ["draft", "active", "paused"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export function isWorkflowStatus(v: unknown): v is WorkflowStatus {
  return typeof v === "string" && (WORKFLOW_STATUSES as readonly string[]).includes(v);
}

export function isEventType(v: unknown): v is EventType {
  return typeof v === "string" && (EVENT_TYPES as readonly string[]).includes(v);
}

export function isActionType(v: unknown): v is ActionType {
  return typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v);
}

// A trigger filter is a flat object of string values. Blank values mean "any"
// and are dropped so the stored filter only carries real narrowing.
export function cleanTriggerFilter(v: unknown): Record<string, string> | null {
  if (v === null || v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const t = raw.trim();
    if (t) out[k] = t;
  }
  return out;
}

// Longest a wait step may pause: 60 days. Anything longer is almost certainly
// a typo (hours typed as minutes) and would hold a run for months.
export const MAX_WAIT_HOURS = 24 * 60;
// The event payload key a wait_until reads, e.g. starts_at. Lowercase letters
// and underscores only, so it can never be a path or an expression.
export const WAIT_FIELD_RE = /^[a-z_]{1,40}$/;

// Validate and normalise an action's config against ACTION_DEFS. Returns the
// cleaned config or a plain-English problem the UI can show verbatim.
export function cleanActionConfig(
  type: ActionType,
  raw: unknown
): { ok: true; config: Record<string, unknown> } | { ok: false; message: string } {
  const def = ACTION_DEFS[type];
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const config: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = src[f.key];
    if (f.kind === "number") {
      if (v === undefined || v === null || v === "") {
        if (f.required) return { ok: false, message: `${f.label} is required for "${def.label}".` };
        continue;
      }
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) {
        return { ok: false, message: `${f.label} must be a number.` };
      }
      // wait: hours must be positive and no longer than 60 days.
      if (type === "wait" && f.key === "hours") {
        if (n <= 0) return { ok: false, message: "Hours must be more than zero for a wait." };
        if (n > MAX_WAIT_HOURS) return { ok: false, message: `Hours must be ${MAX_WAIT_HOURS} (60 days) or less for a wait.` };
        config[f.key] = n;
        continue;
      }
      // wait_until: the offset may be negative (before) or positive (after).
      if (type === "wait_until" && f.key === "offset_hours") {
        if (Math.abs(n) > MAX_WAIT_HOURS) return { ok: false, message: `Offset must be within ${MAX_WAIT_HOURS} hours (60 days) either way.` };
        config[f.key] = n;
        continue;
      }
      if (n < 0) {
        return { ok: false, message: `${f.label} must be a number of zero or more.` };
      }
      config[f.key] = n;
      continue;
    }
    if (type === "wait_until" && f.key === "field") {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) return { ok: false, message: `${f.label} is required for "${def.label}".` };
      if (!WAIT_FIELD_RE.test(s)) {
        return { ok: false, message: "The event time field must be a short name in lowercase letters and underscores, like starts_at." };
      }
      config[f.key] = s;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
    if (!s) {
      if (f.required) return { ok: false, message: `${f.label} is required for "${def.label}".` };
      continue;
    }
    if (f.kind === "url" && !/^https:\/\/\S+$/i.test(s)) {
      return { ok: false, message: `${f.label} must start with https://` };
    }
    config[f.key] = s;
  }
  return { ok: true, config };
}
