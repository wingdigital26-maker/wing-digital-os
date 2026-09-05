// /api/potential-clients -- "drop a website in, start a potential client".
//
// GET    ?status=&q=            list newest first (cap 200) plus counts per status
// POST   {url}                  add a site, research it inline, return the row
// POST   {id, action:"research"}  re-run the research on an existing row
// POST   {id, action:"convert"}   create a crm_contacts row + a deal, link them
// PATCH  {id, status|notes|name|phone|email|city|state|trade}
// DELETE ?id=
//
// The research is the OS itself fetching the public site (lib/siteResearch.ts).
// No paid API, no scraping service, no model. Unknown stays NULL.
//
// SSRF: the URL is normalized and its host must be a public DNS name. IP
// literals, localhost, .local/.internal names are refused before any fetch.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbPost,
  sbPatch,
  sbDelete,
  errorResponse,
  badRequest,
  nullableText,
  esc,
} from "../pipeline/_lib";
import { normalizePhone } from "@/lib/phone";
import { emitEvent } from "@/lib/automations/emit";
import { researchSite, normalizeUrl, domainOf, isPublicHost } from "@/lib/siteResearch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STATUSES = ["new", "researched", "contacted", "proposal", "won", "lost"] as const;
type Status = (typeof STATUSES)[number];

const SELECT =
  "id,domain,website,name,phone,email,city,state,trade,services,socials,signals,summary," +
  "status,notes,crm_contact_id,researched_at,research_error,created_at,updated_at";

type Row = {
  id: number;
  domain: string;
  website: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  status: Status;
  crm_contact_id: number | null;
  research_error: string | null;
};

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Run the research and write the outcome onto the row. Never throws: a failed
// research is recorded on the row (research_error) and the row is returned.
async function researchInto(id: number, website: string, wasNew: boolean): Promise<Row> {
  let patch: Record<string, unknown>;
  try {
    const r = await researchSite(website);
    patch = {
      website: r.website,
      name: r.name,
      phone: r.phone,
      email: r.email,
      city: r.city,
      state: r.state,
      trade: r.trade,
      services: r.services,
      socials: r.socials,
      signals: r.signals,
      summary: r.summary,
      researched_at: new Date().toISOString(),
      research_error: null,
    };
    if (wasNew) patch.status = "researched";
  } catch (e) {
    patch = {
      research_error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
    };
  }
  const rows = await sbPatch<Row>("potential_clients", `id=eq.${id}&select=${encodeURIComponent(SELECT)}`, patch);
  if (!rows.length) throw new Error("Update matched no rows.");
  return rows[0];
}

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const sp = new URL(req.url).searchParams;
  const status = nullableText(sp.get("status"));
  const q = nullableText(sp.get("q"));
  if (status && !STATUSES.includes(status as Status)) return badRequest("Unknown status.");

  try {
    const filters: string[] = [];
    if (status) filters.push(`status=eq.${status}`);
    if (q) {
      const like = `*${esc(q)}*`;
      filters.push(`or=(name.ilike.${like},domain.ilike.${like},city.ilike.${like},trade.ilike.${like},email.ilike.${like})`);
    }
    const rows = await sbGet<Row>(
      "potential_clients",
      SELECT,
      [...filters, "order=created_at.desc", "limit=200"].join("&")
    );
    const all = await sbGet<{ status: Status }>("potential_clients", "status", "limit=5000");
    const counts: Record<string, number> = { all: all.length };
    for (const s of STATUSES) counts[s] = 0;
    for (const r of all) counts[r.status] = (counts[r.status] || 0) + 1;
    return NextResponse.json({ ok: true, rows, counts, filters: { status, q } });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const body = await readJson(req);
  if (!body) return badRequest("Body must be JSON.");

  // ── actions on an existing row ───────────────────────────────────────────
  if (body.id !== undefined) {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) return badRequest("id must be a positive integer.");
    const action = nullableText(body.action);
    try {
      const existing = await sbGet<Row>("potential_clients", SELECT, `id=eq.${id}`);
      if (!existing.length) return badRequest(`No potential client with id ${id}.`);
      const row = existing[0];

      if (action === "research") {
        const updated = await researchInto(id, row.website, row.status === "new");
        return NextResponse.json({ ok: !updated.research_error, row: updated });
      }

      if (action === "convert") {
        if (row.crm_contact_id) {
          return NextResponse.json(
            { error: "already_converted", message: "Already in the CRM.", contact_id: row.crm_contact_id, row },
            { status: 409 }
          );
        }
        const phoneNorm = normalizePhone(row.phone);
        const contact = await sbPost<{ id: number }>("crm_contacts", {
          business_name: row.name || row.domain,
          email: row.email ? row.email.toLowerCase() : null,
          phone: phoneNorm.e164 ?? phoneNorm.value,
          website: row.website,
          city: row.city,
          state: row.state,
          trade: row.trade,
          source: "potential_client",
          source_ref: row.domain,
          owner_id: auth.userId,
        });
        // First stage by sort, same rule as /api/pipeline/deals.
        const first = await sbGet<{ id: number; is_won: boolean; is_lost: boolean }>(
          "crm_stages",
          "id,is_won,is_lost",
          "order=sort.asc&limit=1"
        );
        let deal: { id: number } | null = null;
        let dealError: string | null = null;
        if (first.length) {
          try {
            deal = await sbPost<{ id: number }>("crm_deals", {
              contact_id: contact.id,
              stage_id: first[0].id,
              title: `${row.name || row.domain} website / marketing`,
              value_cents: null,
              status: "open",
              owner_id: auth.userId,
            });
          } catch (e) {
            dealError = String(e).slice(0, 300);
          }
        } else {
          dealError = "No pipeline stages are configured, so no deal was created.";
        }
        const patch: Record<string, unknown> = { crm_contact_id: contact.id };
        if (row.status === "new" || row.status === "researched") patch.status = "contacted";
        const updated = await sbPatch<Row>("potential_clients", `id=eq.${id}&select=${encodeURIComponent(SELECT)}`, patch);
        try {
          await emitEvent({ type: "contact.created", contact_id: contact.id, payload: { source: "potential_client", domain: row.domain } });
        } catch {
          // The contact exists; the automation cron will catch up.
        }
        return NextResponse.json({ ok: true, row: updated[0] ?? row, contact_id: contact.id, deal_id: deal?.id ?? null, deal_error: dealError }, { status: 201 });
      }

      return badRequest('action must be "research" or "convert".');
    } catch (e) {
      return errorResponse(e);
    }
  }

  // ── add a new site ───────────────────────────────────────────────────────
  const raw = nullableText(body.url);
  if (!raw) return badRequest("Paste a website address.");
  const u = normalizeUrl(raw);
  if (!u) return badRequest("That is not a web address we can open. Try something like acmeroofing.com.");
  if (!isPublicHost(u.hostname)) return badRequest("That address points at a private or internal host, which we will not open.");
  const domain = domainOf(u);

  try {
    const dupe = await sbGet<Row>("potential_clients", SELECT, `domain=eq.${esc(domain)}`);
    if (dupe.length) {
      return NextResponse.json(
        { error: "duplicate", message: "Already on the list, opened it for you.", row: dupe[0] },
        { status: 409 }
      );
    }
    const created = await sbPost<Row>("potential_clients", {
      domain,
      website: u.href,
      status: "new",
    });
    const row = await researchInto(created.id, u.href, true);
    return NextResponse.json({ ok: !row.research_error, row }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const body = await readJson(req);
  if (!body) return badRequest("Body must be JSON.");
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return badRequest("id must be a positive integer.");

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) {
    const s = nullableText(body.status);
    if (!s || !STATUSES.includes(s as Status)) return badRequest(`status must be one of ${STATUSES.join(", ")}.`);
    patch.status = s;
  }
  for (const k of ["notes", "name", "email", "city", "state", "trade"] as const) {
    if (body[k] !== undefined) patch[k] = nullableText(body[k]);
  }
  if (body.phone !== undefined) {
    const n = normalizePhone(nullableText(body.phone));
    patch.phone = n.e164 ?? n.value;
  }
  if (typeof patch.email === "string") patch.email = (patch.email as string).toLowerCase();
  if (typeof patch.state === "string") patch.state = (patch.state as string).toUpperCase().slice(0, 2);
  if (!Object.keys(patch).length) return badRequest("Nothing to update.");

  try {
    const rows = await sbPatch<Row>("potential_clients", `id=eq.${id}&select=${encodeURIComponent(SELECT)}`, patch);
    if (!rows.length) return badRequest(`No potential client with id ${id}.`);
    return NextResponse.json({ ok: true, row: rows[0] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return badRequest("id must be a positive integer.");
  try {
    const gone = await sbDelete<{ id: number }>("potential_clients", `id=eq.${id}`);
    if (!gone.length) return badRequest(`No potential client with id ${id}.`);
    return NextResponse.json({ ok: true, deleted: gone[0].id });
  } catch (e) {
    return errorResponse(e);
  }
}
