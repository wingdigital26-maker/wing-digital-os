import Link from "next/link";
import { withStore } from "@/lib/command/db";
import { DEAL_STAGES as STAGES, ONBOARDING } from "@/lib/command/onboarding";
import { money } from "@/lib/command/time";
import { Empty, Problems, Stat } from "../../_ui/bits";
import { Checklist, DealCard, NewDeal, type Deal } from "../../_ui/Deals";

export const dynamic = "force-dynamic";

// Sales pipeline: lead > meeting > proposal > signed > onboarding > live.
// Signing a deal starts its day 0 to 14 onboarding checklist; Live makes it a client.
export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ s?: string }> }) {
  const s = (await searchParams).s ?? "open";
  const r = await withStore(async (sql) => {
    const deals = await sql<Deal[]>`
      select id::int, business, contact, phone, stage, product, value_monthly::float as value_monthly, owner, notes,
             floor(extract(epoch from now() - stage_changed_at) / 86400)::int as days_in_stage
        from cc_deals order by stage_changed_at desc limit 300`;
    const ticks = await sql<{ deal_id: number; item_key: string; done: boolean }[]>`select deal_id::int, item_key, done from cc_onboarding`;
    return { deals, ticks };
  });
  const deals = r.ok ? r.data.deals : [];
  const done = new Map<number, Record<string, boolean>>();
  for (const t of r.ok ? r.data.ticks : []) {
    const m = done.get(t.deal_id) ?? {};
    m[t.item_key] = t.done;
    done.set(t.deal_id, m);
  }
  const open = deals.filter((d) => ["lead", "meeting", "proposal"].includes(d.stage));
  const onboarding = deals.filter((d) => d.stage === "onboarding");
  const shown = s === "open" ? open : deals.filter((d) => d.stage === s);

  return (
    <>
      <h1 className="cc-h1">Pipeline</h1>
      <p className="cc-lede">Every deal from first call to live client. A meeting Dylan books on the call list lands here on its own. Mark a deal Signed and its 14 day onboarding starts.</p>
      <Problems errors={[r.ok ? null : r.reason]} />
      <div className="cc-grid four">
        {STAGES.slice(0, 3).map(([k, l]) => <Stat key={k} l={l} n={deals.filter((d) => d.stage === k).length} href={`/command/pipeline?s=${k}`} />)}
        <Stat l="Open pipeline" n={money(open.reduce((n, d) => n + (d.value_monthly ?? 0), 0))} s="per month, not revenue" />
      </div>
      <div style={{ marginTop: 16 }}><NewDeal /></div>

      <h2 className="cc-h2">Onboarding <span className="cc-count">{onboarding.length}</span></h2>
      {onboarding.length ? (
        <div className="cc-grid two">
          {onboarding.map((d) => {
            const ticks = done.get(d.id) ?? {};
            const n = ONBOARDING.filter((i) => ticks[i.key]).length;
            return (
              <div key={d.id} className="cc-card">
                <div className="cc-spread"><h3>{d.business}</h3><span className="cc-tag blue">Day {d.days_in_stage}</span></div>
                <div className="cc-sub">{n} of {ONBOARDING.length} done.</div>
                <Checklist dealId={d.id} items={ONBOARDING} done={ticks} day={d.days_in_stage} />
                <DealCard d={d} />
              </div>
            );
          })}
        </div>
      ) : <Empty>Nobody is onboarding right now.</Empty>}

      <h2 className="cc-h2">Deals</h2>
      <div className="cc-seg">
        <Link href="/command/pipeline" aria-current={s === "open" ? "true" : undefined}>Open {open.length}</Link>
        {STAGES.map(([k, l]) => (
          <Link key={k} href={`/command/pipeline?s=${k}`} aria-current={s === k ? "true" : undefined}>{l} {deals.filter((d) => d.stage === k).length}</Link>
        ))}
      </div>
      {shown.length ? <div className="cc-grid two">{shown.map((d) => <DealCard key={d.id} d={d} />)}</div> : <Empty>No deals here.</Empty>}
    </>
  );
}
