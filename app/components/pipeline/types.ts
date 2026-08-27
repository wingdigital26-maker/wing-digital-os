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
