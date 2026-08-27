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

export async function GET() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  try {
    const stages = await sbGet<StageRow>(
      "crm_stages",
      "id,key,label,sort,is_won,is_lost",
      "order=sort.asc"
    );

    // One read for every open deal, then bucket in memory. At Wing's volume
    // this is a single small query; per-stage fan-out would be N round trips
    // for no benefit.
    const deals = await sbGet<DealRow>(
      "crm_deals",
      DEAL_SELECT,
      "status=eq.open&order=updated_at.desc"
    );

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

    const quotedAll = deals.filter((d) => typeof d.value_cents === "number");
    return NextResponse.json({
      ok: true,
      board,
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
