import { loadClients } from "@/lib/command/clients";
import { agentRuns, seoForClients } from "@/lib/command/seo";
import { ago, fmtDay } from "@/lib/command/time";
import { Empty, Problems, Stat } from "../../_ui/bits";

export const dynamic = "force-dynamic";

// SEO: what is live on each client site, what changed this week and month, and
// when each content agent last ran.
export default async function SeoPage() {
  const { clients, errors } = await loadClients();
  const [seo, agents] = await Promise.all([seoForClients(clients), agentRuns()]);
  const week = seo.reduce((n, s) => n + s.thisWeek.length, 0);
  const month = seo.reduce((n, s) => n + s.thisMonth, 0);
  const noSite = clients.filter((c) => !c.liveSite);

  return (
    <>
      <h1 className="cc-h1">SEO</h1>
      <p className="cc-lede">
        Read from each client site&apos;s own sitemap. A sitemap date is when a page last changed, so these counts are new or updated pages.
        The client dashboards date each post exactly.
      </p>
      <Problems errors={[...errors, agents.error]} />
      <div className="cc-grid three">
        <Stat l="This week" n={week} s="New or updated pages" />
        <Stat l="This month" n={month} s="New or updated pages" />
        <Stat l="Live pages" n={seo.reduce((n, s) => n + s.total, 0)} s={`${seo.length} client sites`} />
      </div>

      <h2 className="cc-h2">Content agents</h2>
      {agents.runs.length ? (
        <div className="cc-card cc-scroll">
          <table className="cc-table">
            <thead><tr><th>Agent</th><th>Last run</th><th>Status</th><th>Detail</th></tr></thead>
            <tbody>
              {agents.runs.map((r) => (
                <tr key={r.agent}>
                  <td><strong>{r.agent}</strong>{r.client ? <div className="cc-muted">{r.client}</div> : null}</td>
                  <td>{r.at ? ago(r.at) : "Unknown"}</td>
                  <td><span className={`cc-tag ${r.status === "ok" ? "green" : r.status === "failed" ? "red" : ""}`}>{r.status}</span></td>
                  <td className="cc-sub">{r.published != null ? `${r.published} published. ` : ""}{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No content agent runs recorded yet. Agents report here by calling /api/command/agent-run.</Empty>
      )}

      <h2 className="cc-h2">By client</h2>
      {seo.length ? (
        <div className="cc-grid two">
          {seo.map((s) => (
            <div key={s.slug} id={s.slug} className="cc-card">
              <div className="cc-spread">
                <h3>{s.name}</h3>
                <a href={s.site} target="_blank" rel="noreferrer" className="cc-muted">{s.site.replace(/^https?:\/\//, "")}</a>
              </div>
              {s.ok ? (
                <>
                  <dl className="cc-kv">
                    <dt>Live pages</dt><dd>{s.total} ({s.posts} posts, {s.servicePages} other pages)</dd>
                    <dt>This week</dt><dd>{s.thisWeek.length}</dd>
                    <dt>This month</dt><dd>{s.thisMonth}</dd>
                    {s.undated ? (<><dt>Undated</dt><dd>{s.undated} pages carry no date</dd></>) : null}
                  </dl>
                  {s.thisWeek.length ? (
                    <ul className="cc-list" style={{ marginTop: 8 }}>
                      {s.thisWeek.slice(0, 12).map((p) => (
                        <li key={p.url}>
                          <a href={p.url} target="_blank" rel="noreferrer">{decodeURIComponent(p.url.replace(/^https?:\/\/[^/]+/, "")) || "/"}</a>
                          <div className="cc-muted">{p.kind === "post" ? "Post" : "Page"}, {fmtDay(p.lastmod)}</div>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="cc-sub">Nothing new or changed this week.</p>}
                </>
              ) : <p className="cc-sub" style={{ color: "var(--red)" }}>{s.error}.</p>}
              {s.dashboard ? <a className="cc-btn small" style={{ marginTop: 10 }} href={s.dashboard}>Client dashboard</a> : null}
            </div>
          ))}
        </div>
      ) : <Empty>No client has a live site recorded in the vault yet.</Empty>}
      {noSite.length ? <p className="cc-muted" style={{ marginTop: 12 }}>No live site on file for: {noSite.map((c) => c.name).join(", ")}.</p> : null}
    </>
  );
}
