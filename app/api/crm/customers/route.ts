// GET /api/crm/customers?client_slug=<slug>&q=<search>
//
// A client's past customers: crm_contacts rows tagged with client_slug (added by
// migration 0031). This is the surface a client's review / text / email campaign
// runs from — staff pick a client, see that client's customers, and queue review
// requests to the selected ones. Read-only here; NOTHING is sent from this route.
//
// Honesty rules, same as every OS board: a missing column/table says exactly
// what to run, an empty result says what would fill it, and do_not_contact is
// carried through so the UI can flag and exclude opted-out contacts.
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  errorResponse,
  badRequest,
  nullableText,
  esc,
  SbError,
} from "../../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const LIMIT = 500;

const SELECT =
  "id,business_name,contact_name,email,phone,city,source,do_not_contact,created_at";

type CustomerRow = {
  id: number;
  business_name: string | null;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  source: string | null;
  do_not_contact: boolean | null;
  created_at: string;
};

// True when the failure smells like "the client_slug column does not exist yet"
// (migration 0031 not applied), so the UI can name the migration to run instead
// of showing a generic error.
function schemaMissing(e: unknown): boolean {
  if (!(e instanceof SbError)) return false;
  const d = (e.detail || "").toLowerCase();
  return (
    d.includes("client_slug") ||
    d.includes("42703") || // undefined column
    d.includes("42p01") || // undefined table
    d.includes("does not exist") ||
    d.includes("could not find")
  );
}

const MISSING_REASON =
  "The crm_contacts.client_slug column does not exist in the OS database yet. " +
  "Run migration supabase/migrations/0031, then a client's imported customers " +
  "will appear here.";

export async function GET(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const clientSlug = nullableText(req.nextUrl.searchParams.get("client_slug"))?.toLowerCase() ?? null;
  if (!clientSlug || !SLUG_RE.test(clientSlug)) {
    return badRequest("client_slug is required: lowercase letters, digits, and dashes.");
  }

  const q = nullableText(req.nextUrl.searchParams.get("q"));

  try {
    let query = `client_slug=eq.${esc(clientSlug)}&order=created_at.desc&limit=${LIMIT}`;
    if (q) {
      // Case-insensitive match on name, email, or phone. esc() strips the
      // PostgREST reserved characters (),  so a stray one cannot break the filter.
      const term = esc(q);
      query +=
        `&or=(business_name.ilike.*${term}*,contact_name.ilike.*${term}*,` +
        `email.ilike.*${term}*,phone.ilike.*${term}*)`;
    }

    const rows = await sbGet<CustomerRow>("crm_contacts", SELECT, query);

    return NextResponse.json({
      available: true,
      schemaMissing: false,
      reason: null,
      client_slug: clientSlug,
      customers: rows,
      count: rows.length,
      capped: rows.length >= LIMIT,
    });
  } catch (e) {
    if (schemaMissing(e)) {
      return NextResponse.json({
        available: false,
        schemaMissing: true,
        reason: MISSING_REASON,
        client_slug: clientSlug,
        customers: [],
        count: 0,
        capped: false,
      });
    }
    return errorResponse(e);
  }
}
