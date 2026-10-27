import Link from "next/link";
import { withStore } from "@/lib/command/db";
import { dayCT, weekStart } from "@/lib/command/time";
import { Empty, Problems, Stat } from "../../_ui/bits";
import CallCard, { type CallProspect } from "../../_ui/CallCard";
import CsvUpload from "../../_ui/CsvUpload";

export const dynamic = "force-dynamic";

const VIEWS = [
  ["due", "Due today"],
  ["new", "Never called"],
  ["callback", "Call backs"],
  ["meetings", "Meetings"],
  ["all", "All"],
] as const;

// Cold calls (Dylan): the list, tap to call, one tap per outcome.
export default async function CallsPage({ searchParams }: { searchParams: Promise<{ v?: string; q?: string }> }) {
  const sp = await searchParams;
  const v = VIEWS.some(([k]) => k === sp.v) ? sp.v! : "due";
  const q = (sp.q ?? "").trim().slice(0, 80);
  const today = dayCT();
  const wk = weekStart(today);

  const r = await withStore(async (sql) => {
    const where =
      v === "due" ? sql`not archived and coalesce(last_outcome, '') <> 'meeting' and (next_call_date is null or next_call_date <= ${today})`
      : v === "new" ? sql`not archived and last_outcome is null`
      : v === "callback" ? sql`not archived and last_outcome = 'call_back'`
      : v === "meetings" ? sql`last_outcome = 'meeting'`
      : sql`true`;
    const search = q ? sql`and (business ilike ${"%" + q + "%"} or city ilike ${"%" + q + "%"} or phone ilike ${"%" + q + "%"})` : sql``;
    const [rows, total, stats] = await Promise.all([
      sql<CallProspect[]>`
        select p.id, p.business, p.contact, p.phone, p.email, p.website, p.city, p.niche, p.hook, p.last_outcome,
               p.last_called_at::text, p.next_call_date::text, p.notes,
               (select count(*)::int from cc_call_outcomes o where o.prospect_id = p.id) as calls
          from cc_prospects p where ${where} ${search}
         order by p.next_call_date nulls first, p.last_called_at nulls first, p.business limit 40`,
      sql<{ n: number }[]>`select count(*)::int as n from cc_prospects where ${where} ${search}`,
      sql<{ today: number; week: number; meetings: number }[]>`
        select count(*) filter (where (created_at at time zone 'America/Chicago')::date = ${today})::int as today,
               count(*) filter (where (created_at at time zone 'America/Chicago')::date >= ${wk})::int as week,
               count(*) filter (where outcome = 'meeting' and (created_at at time zone 'America/Chicago')::date >= ${wk})::int as meetings
          from cc_call_outcomes`,
    ]);
    return { rows, total: total[0].n, stats: stats[0] };
  });

  return (
    <>
      <h1 className="cc-h1">Cold calls</h1>
      <p className="cc-lede">Tap a number to call, then tap what happened. The next call date fills itself in. Outcomes live here in the cloud; the laptop list is never changed.</p>
      <Problems errors={[r.ok ? null : r.reason]} />
      {r.ok ? (
        <>
          <div className="cc-grid three">
            <Stat l="Calls today" n={r.data.stats.today} />
            <Stat l="Calls this week" n={r.data.stats.week} />
            <Stat l="Meetings this week" n={r.data.stats.meetings} href="/command/pipeline" />
          </div>
          <div className="cc-seg" style={{ marginTop: 16 }}>
            {VIEWS.map(([k, l]) => (
              <Link key={k} href={`/command/calls?v=${k}`} aria-current={v === k ? "true" : undefined}>{l}</Link>
            ))}
          </div>
          <form className="cc-row" style={{ marginBottom: 14 }}>
            <input type="hidden" name="v" value={v} />
            <input className="cc-input" style={{ flex: 1, minWidth: 180 }} name="q" defaultValue={q} placeholder="Search business, city or phone" />
            <button className="cc-btn">Search</button>
          </form>
          <p className="cc-muted">{r.data.total > r.data.rows.length ? `Showing ${r.data.rows.length} of ${r.data.total}.` : `${r.data.total} in this list.`}</p>
          {r.data.rows.length ? (
            <div className="cc-grid two">{r.data.rows.map((p) => <CallCard key={p.id} p={p} />)}</div>
          ) : (
            <Empty>{v === "due" ? "Nobody is due today. Upload a list or sync from Jack's laptop." : "Nobody here."}</Empty>
          )}
          <div style={{ marginTop: 18 }}><CsvUpload /></div>
        </>
      ) : null}
    </>
  );
}
