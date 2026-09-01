// ───────────────────────────────────────────────────────────────────────────
// Shared plumbing for /api/sequences/** — the workflow engine that replaced
// GoHighLevel workflows. Reuses the pipeline helpers (same Supabase project,
// same staff gate, same throw-on-failure honesty rules) and adds the two
// things the sequence engine needs that the pipeline never did: DELETE, and
// merge-tag rendering shared by the due export and nothing else.
//
// THE ONE SAFETY RULE OF THIS MODULE: nothing in /api/sequences ever sends an
// email. Activating a sequence flips a status column. Enrolling a person
// writes a row with a due date. The only thing that ever contacts a human is
// the EXTERNAL sender polling /api/sequences/due — see docs/SEQUENCES-CONTRACT.md.
// ───────────────────────────────────────────────────────────────────────────
import { sbUrl, sbService } from "@/lib/osSupabase";
import { SbError } from "@/app/api/pipeline/_lib";

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

// DELETE rows matching a PostgREST filter. Throws SbError on failure, same
// contract as the pipeline helpers. Returns the deleted rows so callers can
// tell "deleted 0 rows" (bad id) apart from success.
export async function sbDelete<T = unknown>(table: string, query: string): Promise<T[]> {
  const url = sbUrl();
  const key = sbService();
  if (!url || !key) {
    throw new SbError("Sequence database is not configured on this deployment.", 503);
  }
  let r: Response;
  try {
    r = await fetch(`${url}/rest/v1/${table}?${query}`, {
      method: "DELETE",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "return=representation",
      },
      cache: "no-store",
    });
  } catch (e) {
    throw new SbError("Could not reach the sequence database.", 502, String(e));
  }
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new SbError(`Sequence delete failed (${r.status}).`, 502, body.slice(0, 500) || null);
  }
  return (await r.json()) as T[];
}

// ── Row shapes (mirror supabase/migrations/0017_bookings_sequences.sql) ────
export type SequenceRow = {
  id: string;
  name: string;
  client_slug: string | null;
  status: string; // draft | active | paused
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type StepRow = {
  id: string;
  sequence_id: string;
  step_order: number;
  wait_days: number;
  channel: string;
  subject: string | null;
  body: string;
  created_at: string;
};

export type EnrollmentRow = {
  id: string;
  sequence_id: string;
  email: string;
  name: string | null;
  company: string | null;
  current_step: number; // last step COMPLETED; 0 = nothing sent yet
  status: string; // active | paused | completed | replied | unsubscribed | bounced
  next_send_at: string | null;
  enrolled_at: string;
  updated_at: string;
};

export const SEQUENCE_STATUSES = ["draft", "active", "paused"] as const;
export const MERGE_TAGS = ["{{first_name}}", "{{company}}", "{{city}}"] as const;

// ── Merge-tag rendering ────────────────────────────────────────────────────
// {{first_name}} falls back to "there" (safe in every template we seed).
// {{company}} and {{city}} have NO safe fallback — inventing one would put a
// fabricated word in a real email. When the data is missing the tag is left
// in place and reported in unresolved_tags so the sender can hold the send.
const TAG_RE = /\{\{[a-z_]+\}\}/g;

export function firstNameOf(name: string | null): string {
  const n = (name || "").trim();
  if (!n) return "there";
  const first = n.split(/\s+/)[0];
  const bad = new Set(["", "none", "there", "info", "sales", "team", "owner", "contact"]);
  return bad.has(first.toLowerCase()) ? "there" : first;
}

export function renderMergeTags(
  text: string,
  enrollment: Pick<EnrollmentRow, "name" | "company">
): { text: string; unresolved: string[] } {
  let out = text.replaceAll("{{first_name}}", firstNameOf(enrollment.name));
  const company = (enrollment.company || "").trim();
  if (company) out = out.replaceAll("{{company}}", company);
  const unresolved = Array.from(new Set(out.match(TAG_RE) || []));
  return { text: out, unresolved };
}

// next_send_at for a step that becomes due wait_days days from "now".
export function dueDateFrom(now: Date, waitDays: number): string {
  return new Date(now.getTime() + waitDays * 24 * 60 * 60 * 1000).toISOString();
}

// Same fail-closed machine-key check as app/api/outbound/export/route.ts:
// unset key means NOBODY is authorized. Accepts the Bearer header (preferred,
// documented in SEQUENCES-CONTRACT.md) or ?k= for a browser spot-check.
export function exportKeyOk(req: Request): boolean {
  const key = process.env.OUTBOUND_EXPORT_KEY;
  if (!key) return false;
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (bearer && bearer === key) return true;
  const provided = new URL(req.url).searchParams.get("k");
  return provided === key;
}
