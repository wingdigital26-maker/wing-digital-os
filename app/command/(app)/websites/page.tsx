import Link from "next/link";
import { withStore } from "@/lib/command/db";
import { dayCT, money } from "@/lib/command/time";
import { Empty, Problems, Stat } from "../../_ui/bits";
import { JobCard, NewJob, type Job } from "../../_ui/WebsiteJobs";

export const dynamic = "force-dynamic";

// Websites (Pansh): every redesign job, its brief, due date, delivery and pay.
export default async function WebsitesPage() {
  const today = dayCT();
  const r = await withStore((sql) =>
    sql<Omit<Job, "late">[]>`
      select id::int, client, brief_url, status, due_date::text, delivered_url, delivered_at::text, paid, price::float as price, notes
        from cc_website_jobs order by (status in ('delivered','cancelled')), due_date nulls last, created_at desc`
  );
  const jobs: Job[] = (r.ok ? r.data : []).map((j) => ({
    ...j,
    late: Boolean(j.due_date && (j.status === "delivered" ? (j.delivered_at ?? today) > j.due_date : !["cancelled"].includes(j.status) && j.due_date < today)),
  }));
  const active = jobs.filter((j) => !["delivered", "cancelled"].includes(j.status));
  const done = jobs.filter((j) => j.status === "delivered");
  const owed = jobs.filter((j) => j.status === "delivered" && !j.paid).reduce((n, j) => n + (j.price ?? 0), 0);

  return (
    <>
      <h1 className="cc-h1">Websites</h1>
      <p className="cc-lede">Site builds sent to Pansh, paid per site. Every delivery is checked against the <Link href="/command/websites/standard">website handoff standard</Link> before it goes to a client.</p>
      <Problems errors={[r.ok ? null : r.reason]} />
      <div className="cc-grid three">
        <Stat l="In progress" n={active.length} s={`${active.filter((j) => j.late).length} late`} tone={active.some((j) => j.late) ? "bad" : undefined} />
        <Stat l="Delivered" n={done.length} s={`${done.filter((j) => !j.late).length} on time`} />
        <Stat l="Owed to Pansh" n={money(owed)} s="Delivered, not yet paid" />
      </div>
      <div style={{ marginTop: 16 }}><NewJob /></div>
      <h2 className="cc-h2">In progress <span className="cc-count">{active.length}</span></h2>
      {active.length ? <div className="cc-grid two">{active.map((j) => <JobCard key={j.id} j={j} />)}</div> : <Empty>No sites in progress.</Empty>}
      <h2 className="cc-h2">Delivered and cancelled</h2>
      {jobs.length - active.length ? <div className="cc-grid two">{jobs.filter((j) => !active.includes(j)).map((j) => <JobCard key={j.id} j={j} />)}</div> : <Empty>Nothing delivered yet.</Empty>}
    </>
  );
}
