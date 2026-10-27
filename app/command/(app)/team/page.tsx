import { Fragment } from "react";
import { currentUser } from "@/lib/command/auth";
import { loadClients } from "@/lib/command/clients";
import { withStore } from "@/lib/command/db";
import { TEAM } from "@/lib/command/team";
import { addDays, dayCT, fmtDay, weekStart } from "@/lib/command/time";
import { Problems } from "../../_ui/bits";
import WeeklyInput from "../../_ui/WeeklyInput";

export const dynamic = "force-dynamic";

// Team: who does what, and this week's numbers per person. Counted from the
// Command Center's own records wherever it can; Grant's outreach numbers are
// typed in until Instantly and Twilio report here directly.
export default async function TeamPage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const w = (await searchParams).w;
  const wk = weekStart(w && /^\d{4}-\d{2}-\d{2}$/.test(w) ? w : dayCT());
  const end = addDays(wk, 7);
  const [user, { clients }, r] = await Promise.all([
    currentUser(),
    loadClients(),
    withStore(async (sql) => {
      const local = (col: string) => sql`(${sql(col)} at time zone 'America/Chicago')::date`;
      const [calls, touches, sites, fixed, manual, moved] = await Promise.all([
        sql<{ by_user: string; calls: number; meetings: number }[]>`
          select by_user, count(*)::int as calls, count(*) filter (where outcome = 'meeting')::int as meetings
            from cc_call_outcomes where ${local("created_at")} >= ${wk} and ${local("created_at")} < ${end} group by by_user`,
        sql<{ by_user: string; n: number }[]>`
          select by_user, count(distinct client_slug)::int as n from cc_roofer_touches
           where ${local("created_at")} >= ${wk} and ${local("created_at")} < ${end} group by by_user`,
        sql<{ delivered: number; on_time: number }[]>`
          select count(*)::int as delivered, count(*) filter (where due_date is null or delivered_at <= due_date)::int as on_time
            from cc_website_jobs where status = 'delivered' and delivered_at >= ${wk} and delivered_at < ${end}`,
        sql<{ owner: string | null; n: number }[]>`
          select owner, count(*)::int as n from cc_problems where status = 'fixed'
             and ${local("fixed_at")} >= ${wk} and ${local("fixed_at")} < ${end} group by owner`,
        sql<{ person: string; metric: string; value: number }[]>`
          select person, metric, value::float as value from cc_weekly_numbers where week_start = ${wk}`,
        sql<{ n: number }[]>`select count(*)::int as n from cc_deals where ${local("stage_changed_at")} >= ${wk} and ${local("stage_changed_at")} < ${end}`,
      ]);
      return { calls, touches, sites: sites[0], fixed, manual, moved: moved[0].n };
    }),
  ]);
  const d = r.ok ? r.data : null;
  const manual = (p: string, m: string) => d?.manual.find((x) => x.person === p && x.metric === m)?.value ?? null;
  const dylanCalls = d?.calls.find((c) => c.by_user === "dylan");
  const atRiskRoofers = clients.filter((c) => c.isRoofer && c.atRisk.length).length;
  const canEditGrant = user?.id === "grant" || user?.admin;

  const numbers: Record<string, [string, React.ReactNode][]> = {
    jack: [["Problems fixed", d ? d.fixed.find((f) => f.owner === "jack")?.n ?? 0 : "?"], ["Deals moved (team)", d ? d.moved : "?"]],
    grant: [["Emails sent", manual("grant", "emails_sent") ?? "Not entered"], ["Replies", manual("grant", "replies") ?? "Not entered"], ["Meetings booked", manual("grant", "meetings") ?? "Not entered"]],
    dylan: [["Calls made", d ? dylanCalls?.calls ?? 0 : "?"], ["Meetings booked", d ? dylanCalls?.meetings ?? 0 : "?"], ["Check-ins done", d ? d.touches.find((t) => t.by_user === "dylan")?.n ?? 0 : "?"], ["At-risk roofers", atRiskRoofers]],
    pansh: [["Sites delivered", d ? d.sites.delivered : "?"], ["Delivered on time", d ? d.sites.on_time : "?"]],
  };

  return (
    <>
      <h1 className="cc-h1">Team</h1>
      <p className="cc-lede">Who does what at Wing, and the numbers for the week of {fmtDay(wk)}.</p>
      <div className="cc-seg">
        <a href={`/command/team?w=${addDays(wk, -7)}`}>Previous week</a>
        <a href="/command/team" aria-current={wk === weekStart() ? "true" : undefined}>This week</a>
      </div>
      <Problems errors={[r.ok ? null : r.reason]} />
      <div className="cc-grid two">
        {TEAM.map((p) => (
          <div key={p.id} className="cc-card">
            <div className="cc-spread"><h3>{p.name}</h3><span className="cc-tag">{p.role === "admin" ? "Admin" : p.role === "member" ? "Team" : "Paid per site"}</span></div>
            <ul className="cc-list">{p.does.map((x) => <li key={x}>{x}</li>)}</ul>
            <dl className="cc-kv">{numbers[p.id].map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd><strong>{v}</strong></dd></Fragment>))}</dl>
            {p.id === "grant" && canEditGrant && wk === weekStart() ? (
              <details className="cc-more-info" style={{ marginTop: 8 }}>
                <summary>Enter this week&apos;s outreach numbers</summary>
                <WeeklyInput person="grant" metric="emails_sent" label="Emails sent" value={manual("grant", "emails_sent")} />
                <WeeklyInput person="grant" metric="replies" label="Replies" value={manual("grant", "replies")} />
                <WeeklyInput person="grant" metric="meetings" label="Meetings booked" value={manual("grant", "meetings")} />
              </details>
            ) : null}
          </div>
        ))}
        <div className="cc-card">
          <div className="cc-spread"><h3>Agents</h3><span className="cc-tag">Automated</span></div>
          <ul className="cc-list">
            <li>Sentinel: checks every client each morning and writes a health page (Daily checks screen).</li>
            <li>Content engines: write and publish SEO posts for each client (SEO screen).</li>
          </ul>
        </div>
      </div>
    </>
  );
}
