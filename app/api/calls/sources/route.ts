// Lead provenance for the Cold Call Room: where every lead in the room came
// from, and — more usefully — which leads the quality audit threw out and why.
//
// READ ONLY. This route never writes. It exists so "why aren't we calling X?"
// is answerable from the screen instead of by re-running the importer.
//
// Everything here is derived from rows that actually exist in
// public.call_leads and public.call_lead_batches. Nothing is estimated,
// projected, or filled in. If a field is null in the database it is reported
// as unknown, not guessed.
import { NextResponse } from "next/server";
import { requireCallUser, sbGet, sbConfigured } from "../_guard";

export const dynamic = "force-dynamic";

type LeadRow = {
  id: string;
  company: string | null;
  city: string | null;
  state: string | null;
  vertical: string | null;
  source: string | null;
  status: string | null;
  phone: string | null;
  website: string | null;
  excluded: boolean | null;
  excluded_reason: string | null;
};

type BatchRow = {
  id: number | string;
  source: string | null;
  imported_at: string | null;
  total: number | null;
  serviceable: number | null;
  excluded: number | null;
  note: string | null;
};

const UNKNOWN = "Unknown";

function bump(m: Map<string, number>, k: string) {
  m.set(k, (m.get(k) ?? 0) + 1);
}

function toSorted(m: Map<string, number>) {
  return [...m.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export async function GET() {
  const user = await requireCallUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!sbConfigured()) {
    return NextResponse.json(
      {
        error:
          "Supabase is not configured on this deployment, so lead sources cannot be read.",
      },
      { status: 503 }
    );
  }

  const [leads, batches] = await Promise.all([
    sbGet<LeadRow>(
      "call_leads",
      "select=id,company,city,state,vertical,source,status,phone,website,excluded,excluded_reason&limit=5000"
    ),
    sbGet<BatchRow>(
      "call_lead_batches",
      "select=id,source,imported_at,total,serviceable,excluded,note&order=imported_at.desc"
    ),
  ]);

  if (!leads) {
    return NextResponse.json(
      { error: "Could not read call_leads from Supabase." },
      { status: 502 }
    );
  }

  // ---- per-source breakdown -------------------------------------------------
  type SourceAgg = {
    source: string;
    total: number;
    dialable: number;
    excluded: number;
    statuses: Map<string, number>;
  };
  const sources = new Map<string, SourceAgg>();

  const verticals = new Map<string, number>();
  const cities = new Map<string, number>();
  const statusAll = new Map<string, number>();
  const reasons = new Map<string, { count: number; companies: string[] }>();

  let dialable = 0;
  let excludedCount = 0;
  let noPhone = 0;
  let excludedNoReason = 0;

  for (const l of leads) {
    const src = l.source?.trim() || UNKNOWN;
    let agg = sources.get(src);
    if (!agg) {
      agg = { source: src, total: 0, dialable: 0, excluded: 0, statuses: new Map() };
      sources.set(src, agg);
    }
    agg.total += 1;
    const st = l.status?.trim() || UNKNOWN;
    bump(agg.statuses, st);
    bump(statusAll, st);

    if (l.excluded) {
      agg.excluded += 1;
      excludedCount += 1;
      const reason = l.excluded_reason?.trim();
      if (!reason) excludedNoReason += 1;
      const key = reason || "No reason recorded";
      const r = reasons.get(key) ?? { count: 0, companies: [] };
      r.count += 1;
      r.companies.push(l.company?.trim() || "(unnamed company)");
      reasons.set(key, r);
    } else {
      agg.dialable += 1;
      dialable += 1;
      bump(verticals, l.vertical?.trim() || UNKNOWN);
      bump(cities, l.city?.trim() || UNKNOWN);
      if (!l.phone?.trim()) noPhone += 1;
    }
  }

  const sourceList = [...sources.values()]
    .map((s) => ({
      source: s.source,
      total: s.total,
      dialable: s.dialable,
      excluded: s.excluded,
      statuses: toSorted(s.statuses),
    }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));

  const rejectionGroups = [...reasons.entries()]
    .map(([reason, v]) => ({
      reason,
      count: v.count,
      companies: v.companies.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  return NextResponse.json({
    me: { email: user.email, role: user.role, isAdmin: user.isAdmin },
    totals: {
      leads: leads.length,
      dialable,
      excluded: excludedCount,
      dialableWithoutPhone: noPhone,
      excludedWithoutReason: excludedNoReason,
      distinctSources: sourceList.length,
    },
    // Batches are the import ledger. If the table is empty we say so rather
    // than inventing a batch from the lead rows.
    batches: (batches ?? []).map((b) => ({
      id: String(b.id),
      source: b.source ?? UNKNOWN,
      imported_at: b.imported_at,
      total: b.total,
      serviceable: b.serviceable,
      excluded: b.excluded,
      note: b.note,
    })),
    batchesReadable: batches !== null,
    sources: sourceList,
    statuses: toSorted(statusAll),
    coverage: {
      verticals: toSorted(verticals),
      cities: toSorted(cities),
    },
    rejectionGroups,
    // Stated once, in the data, so the UI cannot drift from the truth.
    importNote:
      "New leads are imported by running `python scripts/import_call_leads.py --source <tag> --commit` on Jack's PC. That script reads the local prospects.db, which the deployed app cannot reach. Importing is a PC-side action and cannot be triggered from this screen.",
  });
}
