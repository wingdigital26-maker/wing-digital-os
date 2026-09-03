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
      if (!Number.isFinite(n) || n < 0) {
        return { ok: false, message: `${f.label} must be a number of zero or more.` };
      }
      config[f.key] = n;
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
