// ───────────────────────────────────────────────────────────────────────────
// /api/replies — the Reply Inbox API over public.reply_triage (0016).
//
// GET  ?limit=&client=&classification=   -> triage rows, hot first, with the
//                                           inbound message + contact embedded.
// GET  ?thread=<address>&channel=<c>     -> full message history for one
//                                           address from public.messages (0014).
// PATCH { id, action, draft? }           -> save_draft | handled | dismiss.
//
// THIS ROUTE NEVER SENDS ANYTHING. "Mark handled" only flips reply_triage
// status to 'sent' (meaning: a human dealt with it); actual sending happens
// outside the OS entirely — see docs/SENDING-CONTRACT.md.
// ───────────────────────────────────────────────────────────────────────────
import { NextRequest, NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbGetPaged,
  sbPatch,
  errorResponse,
  badRequest,
  clampInt,
  nullableText,
  esc,
  SbError,
} from "../pipeline/_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hot first, then warm, cold, other — the sort Jack actually wants.
const CLASS_ORDER = ["hot", "warm", "cold", "other"] as const;
type Classification = (typeof CLASS_ORDER)[number];

type TriageRow = {
  id: number;
  message_id: number;
  contact_id: number | null;
  client_slug: string | null;
  channel: string | null;
  classification: Classification;
  classified_by: string;
  confidence: string | null;
  draft: string | null;
  draft_model: string | null;
  status: "none" | "draft" | "sent" | "dismissed";
  triaged_at: string;
  handled_at: string | null;
  notes: string | null;
  messages: {
    id: number;
    channel: string;
    direction: string;
    to_addr: string | null;
    from_addr: string | null;
    body: string | null;
    status: string;
    created_at: string;
    read_at: string | null;
  } | null;
  crm_contacts: {
    business_name: string | null;
    contact_name: string | null;
    email: string | null;
  } | null;
};

// True when the failure smells like "the reply_triage table does not exist
// yet" (migration 0016 not applied), so the UI can say exactly that instead
// of a generic error.
function tableMissing(e: unknown): boolean {
  if (!(e instanceof SbError)) return false;
  const d = (e.detail || "").toLowerCase();
  return d.includes("42p01") || d.includes("does not exist") || d.includes("could not find the table");
}

export async function GET(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const p = req.nextUrl.searchParams;

  // ── Thread lookup: every message ever exchanged with one address ──────────
  const thread = nullableText(p.get("thread"));
  if (thread) {
    const channel = nullableText(p.get("channel"));
    try {
      const addr = esc(thread);
      const chanFilter = channel ? `&channel=eq.${esc(channel)}` : "";
      // Newest 200 first so long threads keep their most recent messages,
      // then reversed so the UI still renders oldest-to-newest.
      const rows = await sbGet(
        "messages",
        "id,channel,direction,to_addr,from_addr,body,status,error,created_at",
        `or=(to_addr.eq.${addr},from_addr.eq.${addr})${chanFilter}&order=created_at.desc&limit=200`
      );
      rows.reverse();
      return NextResponse.json({ items: rows });
    } catch (e) {
      return errorResponse(e);
    }
  }

  // ── Triage list ───────────────────────────────────────────────────────────
  const limit = clampInt(p.get("limit"), 300, 1, 1000);
  const client = nullableText(p.get("client"));
  const classification = nullableText(p.get("classification"));

  const classFilter =
    classification && (CLASS_ORDER as readonly string[]).includes(classification)
      ? (classification as Classification)
      : null;

  // Filters shared by every triage query (everything except classification).
  const baseFilters: string[] = [];
  if (client) baseFilters.push(`client_slug=eq.${esc(client)}`);
  const base = baseFilters.length ? `&${baseFilters.join("&")}` : "";

  const SELECT =
    "*,messages(id,channel,direction,to_addr,from_addr,body,status,created_at,read_at),crm_contacts(business_name,contact_name,email)";

  try {
    // Hot rows are never dropped by the recency cap: they get their own query
    // with a far higher ceiling, and the recency cap only applies to the rest.
    const wantsHot = !classFilter || classFilter === "hot";
    const wantsRest = classFilter !== "hot";
    const restClass = classFilter ? `&classification=eq.${classFilter}` : `&classification=neq.hot`;

    const [hotRows, restRows, counted, allSlugRows] = await Promise.all([
      wantsHot
        ? sbGet<TriageRow>(
            "reply_triage",
            SELECT,
            `classification=eq.hot${base}&order=triaged_at.desc&limit=5000`
          )
        : Promise.resolve([] as TriageRow[]),
      wantsRest
        ? sbGet<TriageRow>(
            "reply_triage",
            SELECT,
            `order=triaged_at.desc&limit=${limit}${base}${restClass}`
          )
        : Promise.resolve([] as TriageRow[]),
      // Authoritative total for the current filters, so the board can say
      // "showing N of M" honestly instead of implying the page is everything.
      sbGetPaged<{ id: number }>(
        "reply_triage",
        "id",
        `${baseFilters.join("&")}${classFilter ? `${baseFilters.length ? "&" : ""}classification=eq.${classFilter}` : ""}`,
        0,
        1
      ),
      // Client pills come from an unfiltered lightweight query so filtering to
      // one client never makes the other pills disappear.
      sbGet<{ client_slug: string | null }>(
        "reply_triage",
        "client_slug",
        "limit=5000"
      ),
    ]);

    // Merge and dedupe (a row can only appear in one query, but stay safe).
    const seen = new Set<number>();
    const rows = [...hotRows, ...restRows].filter((r) => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    // Hot first, then warm/cold/other; newest first inside each group.
    rows.sort(
      (a, b) =>
        CLASS_ORDER.indexOf(a.classification) - CLASS_ORDER.indexOf(b.classification) ||
        Date.parse(b.triaged_at) - Date.parse(a.triaged_at)
    );
    return NextResponse.json({
      available: true,
      tableMissing: false,
      reason: null,
      items: rows,
      shownCount: rows.length,
      totalCount: counted.total,
      clientSlugs: Array.from(
        new Set(allSlugRows.map((r) => r.client_slug).filter(Boolean))
      ).sort() as string[],
    });
  } catch (e) {
    if (tableMissing(e)) {
      // Honest degraded response the board can render as a setup note,
      // not a scary failure.
      return NextResponse.json({
        available: false,
        tableMissing: true,
        reason:
          "The reply_triage table does not exist in the OS database yet. Run migration supabase/migrations/0016_reply_triage.sql, then replies will appear here.",
        items: [],
        shownCount: 0,
        totalCount: 0,
        clientSlugs: [],
      });
    }
    return errorResponse(e);
  }
}

// ── PATCH: the only writes the board makes. None of them send anything. ─────
const ACTIONS = new Set(["save_draft", "handled", "dismiss"]);

export async function PATCH(req: NextRequest) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  let body: { id?: unknown; action?: unknown; draft?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Body must be JSON.");
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("A valid triage row id is required.");
  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) {
    return badRequest("action must be save_draft, handled, or dismiss.");
  }

  const patch: Record<string, unknown> = {};
  if (action === "save_draft") {
    // Saving a draft never sends. It stores the edited text and keeps (or
    // moves) the row into 'draft' so it still shows as needing attention.
    if (typeof body.draft !== "string") return badRequest("save_draft requires a draft string.");
    patch.draft = body.draft;
    patch.status = "draft";
  } else if (action === "handled") {
    // 'sent' is the schema's word for "a human dealt with this". The OS did
    // not and cannot send it — see docs/SENDING-CONTRACT.md.
    patch.status = "sent";
    patch.handled_at = new Date().toISOString();
    if (typeof body.draft === "string") patch.draft = body.draft;
  } else {
    patch.status = "dismissed";
    patch.handled_at = new Date().toISOString();
  }

  try {
    const rows = await sbPatch<TriageRow>("reply_triage", `id=eq.${id}`, patch);
    if (!rows.length) {
      return NextResponse.json(
        { error: "not_found", message: `No triage row with id ${id}.` },
        { status: 404 }
      );
    }
    return NextResponse.json({ ok: true, row: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}
