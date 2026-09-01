import { NextResponse } from "next/server";
import { sbUrl, sbService } from "@/lib/osSupabase";
import { twilioCreds, patchMessages } from "@/lib/sms";

// ───────────────────────────────────────────────────────────────────────────
// GET /api/messages — the unified sent-message tracking feed (SMS + email).
//
// Session-gated by middleware like every other /api/* route. Reads the
// `messages` ledger (migration 0014) and reports honestly:
//  * table missing            => "run the migration", not an empty list
//  * Supabase env unset       => configured:false with the reason
//  * Twilio env unset         => smsPipe.configured:false (env NAMES only)
//  * empty table              => "nothing has been logged yet", never zeros
//
// Query params: client (client_slug), channel (sms|email), limit.
// POST { action:"read", ids:[...] } marks inbound rows read. Nothing sends.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  id: number; contact_id: number | null; client_slug: string | null;
  channel: string; direction: string; to_addr: string | null;
  from_addr: string | null; body: string | null; status: string;
  provider_sid: string | null; error: string | null;
  created_at: string; status_updated_at: string | null; read_at: string | null;
};

async function pg(path: string, exact = false): Promise<{ rows: unknown[]; total: number | null; error: string | null; httpStatus: number | null }> {
  const url = sbUrl(); const key = sbService();
  if (!url || !key) {
    return { rows: [], total: null, httpStatus: null, error: "OS_SUPABASE_URL / OS_SUPABASE_SERVICE_KEY are not set on this deployment." };
  }
  try {
    const r = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, ...(exact ? { Prefer: "count=exact" } : {}) },
      cache: "no-store",
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { rows: [], total: null, httpStatus: r.status, error: `${path.split("?")[0]} returned HTTP ${r.status}: ${body.slice(0, 200)}` };
    }
    const n = Number((r.headers.get("content-range") || "").split("/").pop());
    return { rows: (await r.json()) as unknown[], total: Number.isFinite(n) ? n : null, error: null, httpStatus: r.status };
  } catch (e) {
    return { rows: [], total: null, httpStatus: null, error: `Could not reach ${path.split("?")[0]}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const LIMIT_DEFAULT = 400;

/** Last 10 digits of a phone-ish string, or the lowercased string for emails.
 *  Used ONLY for display-name matching, never for sending. */
function normAddr(a: string | null | undefined): string | null {
  if (!a) return null;
  const s = a.trim();
  if (!s) return null;
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : null;
}

type ContactLite = { id: number; business_name: string | null; contact_name: string | null; phone: string | null; email: string | null };

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const client = (searchParams.get("client") ?? "").trim();
  const channel = (searchParams.get("channel") ?? "").trim();
  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.min(2000, Math.max(1, Math.trunc(rawLimit))) : LIMIT_DEFAULT;

  const filters = [
    client ? `client_slug=eq.${encodeURIComponent(client)}` : "",
    channel === "sms" || channel === "email" ? `channel=eq.${channel}` : "",
  ].filter(Boolean).join("&");

  const q =
    "messages?select=id,contact_id,client_slug,channel,direction,to_addr,from_addr,body," +
    `status,provider_sid,error,created_at,status_updated_at,read_at` +
    `${filters ? `&${filters}` : ""}&order=created_at.desc&limit=${limit}`;
  const r = await pg(q, true);

  // A table that does not exist yet must say so, not render as an empty board.
  const tableMissing =
    r.error != null &&
    (r.httpStatus === 404 || /PGRST205|relation .* does not exist|Could not find the table/i.test(r.error));

  const rows = r.rows as Row[];

  // Distinct client slugs + per-client message counts across the whole table
  // (for the filter strip), read separately so filtering to one client does
  // not hide the others. Counts come from the same read; if the table ever
  // outgrows the 10k page the strip says so instead of undercounting quietly.
  const slugR = await pg("messages?select=client_slug&limit=10000", true);
  const slugRows = slugR.rows as { client_slug: string | null }[];
  const clientCounts: Record<string, number> = {};
  for (const x of slugRows) {
    if (x.client_slug) clientCounts[x.client_slug] = (clientCounts[x.client_slug] ?? 0) + 1;
  }
  const clientSlugs = Object.keys(clientCounts).sort();
  const clientCountsExact = slugR.error == null && (slugR.total == null || slugR.total <= slugRows.length);

  // Resolve contact identities so the board can show a real name instead of a
  // bare phone number. Two passes: rows that carry contact_id, then a match of
  // the counterpart address (last-10-digits phone / lowercased email) against
  // the CRM directory. Display-only — sending never uses this.
  const byId = new Map<number, ContactLite>();
  const byAddr = new Map<string, ContactLite>();
  let contactNote: string | null = null;
  if (rows.length) {
    const dirR = await pg("crm_contacts?select=id,business_name,contact_name,phone,email&limit=5000");
    if (dirR.error) {
      contactNote = `Names could not be resolved from crm_contacts: ${dirR.error}. Threads fall back to raw addresses.`;
    } else {
      for (const c of dirR.rows as ContactLite[]) {
        byId.set(c.id, c);
        const p = normAddr(c.phone); if (p && !byAddr.has(p)) byAddr.set(p, c);
        const e = normAddr(c.email); if (e && !byAddr.has(e)) byAddr.set(e, c);
      }
    }
  }
  const items = rows.map((m) => {
    const counterpartAddr = m.direction === "inbound" ? m.from_addr : m.to_addr;
    const c = (m.contact_id != null ? byId.get(m.contact_id) : undefined) ?? (() => {
      const k = normAddr(counterpartAddr);
      return k ? byAddr.get(k) : undefined;
    })();
    return {
      ...m,
      contact_name: c?.contact_name ?? null,
      contact_company: c?.business_name ?? null,
      resolved_contact_id: c?.id ?? m.contact_id ?? null,
    };
  });

  // Unread inbound across the WHOLE table, unaffected by the current filters,
  // so the badge never lies because of a filter.
  const unreadR = await pg("messages?select=id&direction=eq.inbound&read_at=is.null&limit=1", true);

  const twilio = twilioCreds();

  return NextResponse.json({
    available: !r.error,
    tableMissing,
    reason: tableMissing
      ? "The `messages` table does not exist in the OS Supabase project yet. Run migration " +
        "supabase/migrations/0014_messages_consent.sql — until then nothing has ever been logged, " +
        "and this board has no data source at all."
      : r.error,
    total: r.total,
    returned: rows.length,
    truncated: r.total != null && r.total > rows.length,
    items,
    clientSlugs,
    clientCounts,
    clientCountsExact,
    contactNote,
    unreadInbound: unreadR.error ? null : unreadR.total,
    unreadNote: unreadR.error ? `Unread count unavailable: ${unreadR.error}` : null,
    emptyNote:
      !r.error && rows.length === 0
        ? (filters
            ? "No message matches these filters. The ledger itself may still hold rows — clear the filters to check."
            : "The ledger is empty: no SMS or email has ever been logged into it. That is the true state, not a loading failure.")
        : null,
    smsPipe: {
      configured: Boolean(twilio),
      note: twilio
        ? "Twilio is configured on this deployment. Sends are manual only — nothing calls /api/sms/send automatically."
        : "Twilio is NOT configured: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER " +
          "are not all set on this deployment. The SMS pipe cannot send or receive until they are.",
    },
  });
}

export async function POST(req: Request) {
  const b = (await req.json().catch(() => null)) as { action?: string; ids?: unknown } | null;
  if (b?.action !== "read" || !Array.isArray(b.ids) || b.ids.length === 0) {
    return NextResponse.json({ ok: false, error: "expected { action:'read', ids:[...] }" }, { status: 400 });
  }
  const ids = b.ids.filter((n): n is number => typeof n === "number" && Number.isFinite(n)).slice(0, 500);
  if (!ids.length) return NextResponse.json({ ok: false, error: "no valid ids" }, { status: 400 });
  const err = await patchMessages(
    `id=in.(${ids.join(",")})&direction=eq.inbound&read_at=is.null`,
    { read_at: new Date().toISOString() }
  );
  if (err) return NextResponse.json({ ok: false, error: err }, { status: 502 });
  return NextResponse.json({ ok: true, marked: ids.length });
}
