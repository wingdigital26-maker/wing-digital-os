// GET /api/pipeline — the board.
//
// Stages in sort order, each carrying its OPEN deals joined to the contact, plus
// per-stage totals. Money stays integer cents end to end.
//
// TOTALS AND UNKNOWNS: `value_cents` totals sum only the deals that actually
// carry a quote. A deal with NULL value_cents is counted in `deals` and in
// `unquoted`, and contributes nothing to `value_cents` — because summing it as
// zero would silently report a pipeline smaller than it is, and there is no
// honest number to add. `value_cents` is itself null when NOTHING in the stage
// is quoted, so the UI can say "not quoted" instead of printing $0.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  sbGetPaged,
  errorResponse,
} from "./_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StageRow = {
  id: number;
  key: string;
  label: string;
  sort: number;
  is_won: boolean;
  is_lost: boolean;
};

type DealRow = {
  id: number;
  contact_id: number;
  stage_id: number;
  title: string;
  value_cents: number | null;
  status: string;
  expected_close: string | null;
  won_at: string | null;
  lost_at: string | null;
  lost_reason: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
  crm_contacts: {
    id: number;
    business_name: string;
    contact_name: string | null;
    title: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    city: string | null;
    state: string | null;
    trade: string | null;
    do_not_contact: boolean;
  } | null;
};

const DEAL_SELECT =
  "id,contact_id,stage_id,title,value_cents,status,expected_close,won_at,lost_at,lost_reason,owner_id,created_at,updated_at," +
  "crm_contacts(id,business_name,contact_name,title,email,phone,website,city,state,trade,do_not_contact)";

// Every column crm_contacts carries. Named in full because the unified CRM view
// folded the Pipeline tab away, and a contact book inherited from a retired
// GoHighLevel is the one dataset in this repo with no upstream to re-derive it
// from. Dropping a column here would quietly destroy data.
const CONTACT_SELECT =
  "id,business_name,contact_name,title,email,phone,website,city,state,trade," +
  "source,source_ref,verified_at,do_not_contact,dnc_reason,notes,owner_id,created_at,updated_at";

type ContactRow = {
  id: number;
  business_name: string;
  contact_name: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  source: string | null;
  source_ref: string | null;
  verified_at: string | null;
  do_not_contact: boolean | null;
  dnc_reason: string | null;
  notes: string | null;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  try {
    const stages = await sbGet<StageRow>(
      "crm_stages",
      "id,key,label,sort,is_won,is_lost",
      "order=sort.asc"
    );

    // EVERY deal, not just the open ones. The board below still shows open
    // deals only (unchanged), but the unified CRM view has to be able to show a
    // won or lost deal too — those are the records that say what actually
    // happened, and hiding them behind a status filter is how history gets lost.
    const allDeals = await sbGet<DealRow>(
      "crm_deals",
      DEAL_SELECT,
      "order=updated_at.desc"
    );
    const deals = allDeals.filter((d) => d.status === "open");

    // The whole contact book. A contact with no deal attached is still a real
    // record Wing owns; the stage board could never show it, which is precisely
    // the data that would have gone missing when the Pipeline tab was folded in.
    //
    // PAGED, NOT a single select. An unbounded PostgREST select silently stops
    // at 1000 rows and says nothing — the first run of this code returned
    // exactly 1000 contacts, which is the signature of that cap, not a count.
    // Page against the authoritative Content-Range total and report a short
    // read instead of letting it pass as the whole book.
    const CONTACT_PAGE = 1000;
    const contacts: ContactRow[] = [];
    let contactsTotal: number | null = null;
    let contactsNote: string | null = null;
    {
      const first = await sbGetPaged<ContactRow>(
        "crm_contacts", CONTACT_SELECT, "order=updated_at.desc", 0, CONTACT_PAGE
      );
      contacts.push(...first.rows);
      contactsTotal = first.total;
      if (contactsTotal == null) {
        contactsNote =
          "PostgREST returned no Content-Range total for crm_contacts, so how many " +
          "contacts exist is unknown. The list below is what one page returned, not " +
          "a confirmed complete book.";
      } else {
        for (let offset = contacts.length; offset < contactsTotal; offset += CONTACT_PAGE) {
          const page = await sbGetPaged<ContactRow>(
            "crm_contacts", CONTACT_SELECT, "order=updated_at.desc", offset, CONTACT_PAGE
          );
          if (!page.rows.length) break;
          contacts.push(...page.rows);
        }
        if (contacts.length !== contactsTotal) {
          contactsNote =
            `Read ${contacts.length} contacts but the database says there are ` +
            `${contactsTotal}. ${contactsTotal - contacts.length} are missing from this ` +
            `view, so treat the contact counts below as a floor, not a total.`;
        }
      }
    }

    const byStage = new Map<number, DealRow[]>();
    for (const d of deals) {
      const list = byStage.get(d.stage_id);
      if (list) list.push(d);
      else byStage.set(d.stage_id, [d]);
    }

    const board = stages.map((s) => {
      const rows = byStage.get(s.id) ?? [];
      let sum = 0;
      let quoted = 0;
      for (const d of rows) {
        if (typeof d.value_cents === "number") {
          sum += d.value_cents;
          quoted += 1;
        }
      }
      return {
        stage: s,
        deals: rows.map((d) => ({
          id: d.id,
          title: d.title,
          // NULL survives as null. The UI decides how to render "not quoted".
          value_cents: d.value_cents ?? null,
          status: d.status,
          expected_close: d.expected_close,
          owner_id: d.owner_id,
          created_at: d.created_at,
          updated_at: d.updated_at,
          contact: d.crm_contacts,
        })),
        totals: {
          deals: rows.length,
          quoted,
          unquoted: rows.length - quoted,
          // null, not 0, when the stage has no quoted deal at all.
          value_cents: quoted > 0 ? sum : null,
        },
      };
    });

    // Deals whose stage_id no longer matches a stage row would vanish silently
    // from the board. Report the count instead of hiding it.
    const known = new Set(stages.map((s) => s.id));
    const orphans = deals.filter((d) => !known.has(d.stage_id)).length;

    // `stages` is the SAME data as `board`, reshaped to the Stage type the
    // pipeline UI components declare in app/components/pipeline/types.ts. The
    // route only ever returned `board`, while PipelineBoard read `data.stages`
    // and therefore rendered "the response carried no stages" against a
    // perfectly healthy database. Both keys ship now so neither contract lies.
    const stagesOut = board.map((b) => ({
      id: b.stage.id,
      key: b.stage.key,
      label: b.stage.label,
      sort: b.stage.sort,
      is_won: b.stage.is_won,
      is_lost: b.stage.is_lost,
      deals: b.deals,
      deal_count: b.totals.deals,
      value_cents_total: b.totals.value_cents,
    }));

    const stageById = new Map(stages.map((s) => [s.id, s]));
    const dealCountByContact = new Map<number, number>();
    for (const d of allDeals) {
      dealCountByContact.set(d.contact_id, (dealCountByContact.get(d.contact_id) ?? 0) + 1);
    }

    // ── Unified records ──────────────────────────────────────────────────────
    // Flat rows for the one CRM list. Two record types, kept distinct: a
    // `contact` is a business/person Wing knows, a `deal` is a specific piece of
    // money in a stage. They are NOT merged into one another — a contact with
    // three deals is four records, because that is four different things a human
    // can act on. Every column read above survives onto the record under `raw`,
    // so folding the Pipeline tab away drops no field.
    const contactRecords = contacts.map((c) => ({
      recordId: `contact:${c.id}`,
      recordType: "contact" as const,
      id: c.id,
      name: c.business_name,
      person: c.contact_name,
      title: c.title,
      email: c.email,
      phone: c.phone,
      website: c.website,
      where: [c.city, c.state].filter(Boolean).join(", ") || null,
      trade: c.trade,
      source: c.source,
      sourceRef: c.source_ref,
      verifiedAt: c.verified_at,
      doNotContact: c.do_not_contact === true,
      dncReason: c.dnc_reason,
      notes: c.notes,
      dealCount: dealCountByContact.get(c.id) ?? 0,
      ownerId: c.owner_id,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));

    const dealRecords = allDeals.map((d) => {
      const st = stageById.get(d.stage_id) ?? null;
      const c = d.crm_contacts;
      return {
        recordId: `deal:${d.id}`,
        recordType: "deal" as const,
        id: d.id,
        name: d.title,
        contactId: d.contact_id,
        business: c?.business_name ?? null,
        person: c?.contact_name ?? null,
        email: c?.email ?? null,
        phone: c?.phone ?? null,
        website: c?.website ?? null,
        where: [c?.city, c?.state].filter(Boolean).join(", ") || null,
        trade: c?.trade ?? null,
        doNotContact: c?.do_not_contact === true,
        // null survives as null all the way out. "not quoted" is not $0.
        valueCents: d.value_cents ?? null,
        status: d.status,
        stageKey: st?.key ?? null,
        // A deal pointing at a deleted stage is named as such rather than
        // silently rendering with a blank stage.
        stageLabel: st?.label ?? (d.stage_id ? `stage #${d.stage_id} no longer exists` : null),
        expectedClose: d.expected_close,
        wonAt: d.won_at,
        lostAt: d.lost_at,
        lostReason: d.lost_reason,
        ownerId: d.owner_id,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
      };
    });

    const quotedAll = deals.filter((d) => typeof d.value_cents === "number");
    return NextResponse.json({
      ok: true,
      board,
      stages: stagesOut,
      records: { contacts: contactRecords, deals: dealRecords },
      contactsMeta: {
        returned: contacts.length,
        total: contactsTotal,
        complete: contactsTotal != null && contacts.length === contactsTotal,
        note: contactsNote,
      },
      counts: {
        contacts: contacts.length,
        contactsDoNotContact: contacts.filter((c) => c.do_not_contact === true).length,
        contactsWithoutDeal: contacts.filter((c) => !dealCountByContact.has(c.id)).length,
        deals: allDeals.length,
        dealsOpen: deals.length,
        dealsWon: allDeals.filter((d) => d.status === "won").length,
        dealsLost: allDeals.filter((d) => d.status === "lost").length,
      },
      totals: {
        deals: deals.length,
        quoted: quotedAll.length,
        unquoted: deals.length - quotedAll.length,
        value_cents: quotedAll.length
          ? quotedAll.reduce((a, d) => a + (d.value_cents as number), 0)
          : null,
      },
      ...(orphans ? { warning: `${orphans} open deal(s) reference a stage that no longer exists.` } : {}),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
