import Link from "next/link";
import { loadClients } from "@/lib/command/clients";
import { ago, money } from "@/lib/command/time";
import { Empty, HealthTag, Problems } from "../../_ui/bits";

export const dynamic = "force-dynamic";

// Clients: one card per active client, roofers on Roof Command plus every
// other Wing client the vault lists. Tap a card for its history.
export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const f = (await searchParams).f ?? "all";
  const { clients, errors } = await loadClients();
  const shown = clients.filter((c) =>
    f === "roofers" ? c.isRoofer : f === "risk" ? c.atRisk.length > 0 : f === "red" ? c.health === "red" : true
  );
  const filters = [
    ["all", `All ${clients.length}`],
    ["roofers", `Roofers ${clients.filter((c) => c.isRoofer).length}`],
    ["risk", `At risk ${clients.filter((c) => c.atRisk.length).length}`],
    ["red", `Red ${clients.filter((c) => c.health === "red").length}`],
  ];

  return (
    <>
      <h1 className="cc-h1">Clients</h1>
      <p className="cc-lede">Every active client, from the vault and Roof Command. Plan, MRR, CRM link and next action are the team&apos;s own notes; open a client to edit them.</p>
      <Problems errors={errors} />
      <div className="cc-seg">
        {filters.map(([k, label]) => (
          <Link key={k} href={k === "all" ? "/command/clients" : `/command/clients?f=${k}`} aria-current={f === k ? "true" : undefined}>{label}</Link>
        ))}
      </div>
      {shown.length ? (
        <div className="cc-grid two">
          {shown.map((c) => (
            <div key={c.slug} className={`cc-card edge-${c.health}`}>
              <div className="cc-spread">
                <h3><Link href={`/command/clients/${c.slug}`}>{c.name}</Link></h3>
                <HealthTag h={c.health} />
              </div>
              <div className="cc-row" style={{ marginTop: 4 }}>
                {c.isRoofer ? <span className="cc-tag blue">Roofer</span> : null}
                {c.onRoofCommand ? <span className="cc-tag blue">Roof Command</span> : null}
                {c.atRisk.length ? <span className="cc-tag red">At risk</span> : null}
                {c.billing ? <span className={`cc-tag ${c.billing.status === "late" ? "red" : c.billing.status === "due" ? "yellow" : "green"}`}>{c.billing.status === "paid" ? "Paid" : c.billing.status === "due" ? "Payment due" : "Payment late"}</span> : null}
              </div>
              <dl className="cc-kv">
                <dt>Last check</dt>
                <dd>{c.checkedAt ? `${ago(c.checkedAt)}${c.stale ? " (stale)" : ""}` : "No automated check"}</dd>
                <dt>Plan</dt>
                <dd>{c.plan ?? "Not recorded"}</dd>
                <dt>MRR</dt>
                <dd>{c.mrr != null ? `${money(c.mrr)}/mo` : c.mrrNote ?? "Not recorded"}</dd>
                <dt>Next</dt>
                <dd>{c.nextAction ?? (c.healthPage?.reds[0] ? `Fix: ${c.healthPage.reds[0].slice(0, 110)}` : "Not set")}</dd>
                {c.atRisk.length ? (<><dt>Risk</dt><dd>{c.atRisk.join(". ")}</dd></>) : null}
              </dl>
              <div className="cc-row" style={{ marginTop: 12 }}>
                <Link href={`/command/clients/${c.slug}`} className="cc-btn small">Open</Link>
                {c.crmUrl ? <a href={c.crmUrl} target="_blank" rel="noreferrer" className="cc-btn small">CRM / app</a> : null}
                <Link href={`/command/seo#${c.slug}`} className="cc-btn small">SEO posts</Link>
                {c.liveSite ? <a href={c.liveSite} target="_blank" rel="noreferrer" className="cc-btn small">Site</a> : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Empty>No clients match.</Empty>
      )}
    </>
  );
}
