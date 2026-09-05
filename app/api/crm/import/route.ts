// POST /api/crm/import   staff: import a client's PAST CUSTOMERS from a pasted
// CSV (or JSON rows) into crm_contacts, tagged to that client so they can later
// be sent review requests / texts / emails.
//
// Idempotent and deduped. Every imported person gets a stable source_ref of
// `import:<client_slug>:<email-or-phone>`, and the table's unique(source,
// source_ref) index means re-importing the same list UPDATES the same rows
// instead of duplicating them. Processing is row-by-row: a row whose key was
// already inserted earlier in the SAME batch is found on lookup and counted as
// an update, so a list with an internal duplicate collapses correctly.
//
// Contact fields on a do_not_contact = true row are never overwritten, and
// do_not_contact is never cleared.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbPost,
  sbPatch,
  errorResponse,
  badRequest,
  nullableText,
} from "../../pipeline/_lib";
import { parseCsv } from "../../../lib/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z0-9-]{2,60}$/;
const MAX_ROWS = 20000;

type RawRow = Record<string, unknown>;

// One normalized customer, ready to upsert. Null means "not given".
type Candidate = {
  sourceRef: string;
  businessName: string;
  contactName: string | null;
  email: string | null;
  phone: string | null; // display form
  city: string | null;
  state: string | null;
};

// Header aliases -> canonical field. Matched case-insensitively after the CSV
// parser has already lowercased the header row.
function pick(row: RawRow, keys: string[]): string | null {
  for (const k of keys) {
    if (k in row) {
      const v = nullableText(row[k]);
      if (v) return v;
    }
  }
  return null;
}

function normalizeEmail(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim().toLowerCase();
  // A bare, plausible email. We are not RFC-validating, just refusing junk that
  // would make a useless source_ref.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? t : null;
}

// Digits only, used for both the key and (light) validation.
function phoneDigits(v: string | null): string | null {
  if (!v) return null;
  const d = v.replace(/\D+/g, "");
  return d.length >= 7 ? d : null;
}

// Turn one raw row (from CSV or the rows array) into a Candidate, or null when
// it has neither a usable email nor a usable phone.
function toCandidate(row: RawRow, clientSlug: string): Candidate | null {
  const first = pick(row, ["first_name", "first", "first name", "given name"]);
  const last = pick(row, ["last_name", "last", "last name", "surname", "family name"]);
  const full = pick(row, ["name", "full name", "fullname", "contact", "contact name", "customer", "customer name"]);
  const joined = [first, last].filter(Boolean).join(" ").trim();
  const contactName = full ?? (joined || null);

  const company = pick(row, ["company", "business", "business name", "organization", "org"]);
  const email = normalizeEmail(pick(row, ["email", "e-mail", "email address"]));
  const phoneRaw = pick(row, ["phone", "phone number", "mobile", "cell", "telephone", "tel"]);
  const digits = phoneDigits(phoneRaw);

  // Nothing to ever contact them on: skip.
  if (!email && !digits) return null;

  const city = pick(row, ["city", "town"]);
  const state = pick(row, ["state", "province", "region", "st"]);

  const businessName = company || contactName || "Unknown customer";
  const keyPart = email ?? digits!;
  const sourceRef = `import:${clientSlug}:${keyPart}`;

  return {
    sourceRef,
    businessName: businessName.slice(0, 300),
    contactName: contactName ? contactName.slice(0, 200) : null,
    email,
    phone: phoneRaw ? phoneRaw.trim().slice(0, 60) : null,
    city: city ? city.slice(0, 120) : null,
    state: state ? state.slice(0, 120) : null,
  };
}

type ExistingContact = {
  id: number;
  do_not_contact: boolean | null;
};

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return badRequest("Body must be JSON.");
  }

  const clientSlug = nullableText(body.client_slug)?.toLowerCase() ?? null;
  if (!clientSlug || !SLUG_RE.test(clientSlug)) {
    return badRequest("client_slug must be 2 to 60 characters: lowercase letters, digits, and dashes only.");
  }

  // Assemble raw rows from either a CSV string or a rows array. Not both.
  let rawRows: RawRow[] = [];
  if (typeof body.csv === "string" && body.csv.trim() !== "") {
    rawRows = parseCsv(body.csv) as RawRow[];
  } else if (Array.isArray(body.rows)) {
    rawRows = body.rows.filter((r): r is RawRow => r !== null && typeof r === "object");
  } else {
    return badRequest("Provide either a non-empty `csv` string or a `rows` array.");
  }

  if (!rawRows.length) return badRequest("No data rows found to import.");
  if (rawRows.length > MAX_ROWS) {
    return badRequest(`Too many rows (${rawRows.length}). Import at most ${MAX_ROWS} at a time.`);
  }

  const total = rawRows.length;
  let added = 0;
  let updated = 0;
  let skipped = 0;

  try {
    // Row-by-row so that a duplicate key appearing later in the SAME batch is
    // found on lookup (it was inserted moments ago) and counted as an update,
    // never as a second contact.
    for (const raw of rawRows) {
      const cand = toCandidate(raw, clientSlug);
      if (!cand) {
        skipped++;
        continue;
      }

      const existing = await sbGet<ExistingContact>(
        "crm_contacts",
        "id,do_not_contact",
        `source=eq.import&source_ref=eq.${encodeURIComponent(cand.sourceRef)}&limit=1`
      );

      if (!existing.length) {
        await sbPost("crm_contacts", {
          business_name: cand.businessName,
          contact_name: cand.contactName,
          email: cand.email,
          phone: cand.phone,
          city: cand.city,
          state: cand.state,
          client_slug: clientSlug,
          source: "import",
          source_ref: cand.sourceRef,
        });
        added++;
        continue;
      }

      // The row already exists. Protect do_not_contact = true rows: never touch
      // their contact fields and never clear the flag. We still count it as an
      // update (it matched an existing person), we just refuse to overwrite.
      const row = existing[0];
      if (row.do_not_contact === true) {
        updated++;
        continue;
      }

      // Merge fresh values in, but never blank an existing field with a null
      // from this import: only set columns we actually have a value for. Always
      // re-tag the client_slug. do_not_contact is deliberately never in the patch.
      const patch: Record<string, unknown> = { client_slug: clientSlug };
      if (cand.businessName) patch.business_name = cand.businessName;
      if (cand.contactName) patch.contact_name = cand.contactName;
      if (cand.email) patch.email = cand.email;
      if (cand.phone) patch.phone = cand.phone;
      if (cand.city) patch.city = cand.city;
      if (cand.state) patch.state = cand.state;

      await sbPatch("crm_contacts", `id=eq.${row.id}`, patch);
      updated++;
    }

    return NextResponse.json({ ok: true, added, updated, skipped, total });
  } catch (e) {
    return errorResponse(e);
  }
}
