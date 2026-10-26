import Link from "next/link";
import { listEvents, calendarId } from "@/lib/command/calendar";
import { loadClients } from "@/lib/command/clients";
import { withStore } from "@/lib/command/db";
import { seoForClients } from "@/lib/command/seo";
import { personName } from "@/lib/command/team";
import { addDays, ago, ctStartIso, dayCT, fmtWhen, weekStart } from "@/lib/command/time";
import { Empty, HealthTag, Problems, Stat } from "../_ui/bits";

export const dynamic = "force-dynamic";

// Home: today at a glance. Every number links to the screen that owns it.
export default async function CommandHome() {
  const today = dayCT();
  const wk = weekStart(today);
  const [{ clients, errors }, store, cal] = await Promise.all([
    loadClients(),
    withStore(async (sql) => {
      const [problems, due, made] = await Promise.all([
        sql<{ id: number; client_slug: string | null; body: string; urgency: string; status: string; owner: string | null; created_at: string }[]>`
          select id::int, client_slug, body, urgency, status, owner, created_at::text from cc_problems
           where status <> 'fixed' order by (urgency = 'urgent') desc, created_at asc limit 6`,
        sql<{ n: number }[]>`select count(*)::int as n from cc_prospects
           where not archived and coalesce(last_outcome, '') <> 'meeting' and (next_call_date is null or next_call_date <= ${today})`,
        sql<{ n: number; meetings: number }[]>`select count(*)::int as n, count(*) filter (where outcome = 'meeting')::int as meetings
           from cc_call_outcomes where (created_at at time zone 'America/Chicago')::date = ${today}`,
      ]);
      const [open] = await sql<{ n: number }[]>`select count(*)::int as n from cc_problems where status <> 'fixed'`;
      return { problems, openCount: open.n, due: due[0].n, made: made[0] };
    }),
    listEvents(ctStartIso(today), ctStartIso(addDays(wk, 7))),
  ]);
  const seo = await seoForClients(clients);

  const counts = { red: 0, yellow: 0, green: 0, unknown: 0 };
  for (const c of clients) counts[c.health]++;
  const staleN = clients.filter((c) => c.stale).length;
  const overdue = clients.filter((c) => c.isRoofer && c.touchOverdue);
  const atRisk = clients.filter((c) => c.atRisk.length);
  const seoWeek = seo.reduce((n, s) => n + s.thisWeek.length, 0);
  const todays = cal.ok ? cal.events.filter((e) => dayCT(e.start) === today) : [];
  const week = cal.ok ? cal.events.filter((e) => dayCT(e.start) !== today) : [];
  const s = store.ok ? store.data : null;

  return (
    <>
      <h1 className="cc-h1">Today</h1>
      <p className="cc-lede">
        {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago" })}
      </p>
      <Problems errors={[...errors, store.ok ? null : store.reason]} />

      <div className="cc-grid four">
        <Stat
          l="Open problems"
          n={s ? s.openCount : "?"}
          s={s ? `${s.problems.filter((p) => p.urgency === "urgent").length} urgent` : "Storage not set up"}
          href="/command/problems"
          tone={s && s.openCount ? "bad" : undefined}
        />
        <Stat
          l="Check-ins overdue"
          n={overdue.length}
          s={overdue.length ? overdue.slice(0, 3).map((c) => c.name).join(", ") : "Every roofer is current"}
          href="/command/roofers"
          tone={overdue.length ? "bad" : undefined}
        />
        <Stat
          l="Calls to make today"
          n={s ? s.due : "?"}
          s={s ? `${s.made.n} made today, ${s.made.meetings} meeting${s.made.meetings === 1 ? "" : "s"}` : undefined}
          href="/command/calls"
        />
        <Stat l="New or changed SEO pages" n={seoWeek} s="This week, from client sitemaps" href="/command/seo" />
      </div>

      <h2 className="cc-h2">
        Client health <span className="cc-count">{clients.length} clients</span>
        <Link href="/command/checks">Daily checks</Link>
      </h2>
      <div className="cc-grid four">
        <Stat l="Red" n={counts.red} tone={counts.red ? "bad" : undefined} href="/command/checks" />
        <Stat l="Yellow" n={counts.yellow} tone={counts.yellow ? "warn" : undefined} href="/command/checks" />
        <Stat l="Green" n={counts.green} href="/command/checks" />
        <Stat l="Missing or stale check" n={staleN} s="No check in 36h" tone={staleN ? "warn" : undefined} href="/command/checks" />
      </div>

      {atRisk.length ? (
        <>
          <h2 className="cc-h2">At risk <span className="cc-count">{atRisk.length}</span></h2>
          <div className="cc-grid two">
            {atRisk.map((c) => (
              <Link key={c.slug} href={`/command/clients/${c.slug}`} className="cc-card edge-red" style={{ textDecoration: "none", color: "inherit" }}>
                <div className="cc-spread"><h3>{c.name}</h3><HealthTag h={c.health} /></div>
                <div className="cc-sub">{c.atRisk.join(". ")}</div>
              </Link>
            ))}
          </div>
        </>
      ) : null}

      <h2 className="cc-h2">Open problems <Link href="/command/problems">Report or see all</Link></h2>
      {!s ? (
        <Empty>Problems show here once storage is set up.</Empty>
      ) : s.problems.length ? (
        <div className="cc-card">
          <ul className="cc-list">
            {s.problems.map((p) => (
              <li key={p.id}>
                <div className="cc-row">
                  {p.urgency === "urgent" ? <span className="cc-tag red">Urgent</span> : null}
                  <span className="cc-tag">{p.status === "working" ? "Working" : "Open"}</span>
                  <strong>{p.client_slug ?? "Wing"}</strong>
                </div>
                <Link href={`/command/problems#p${p.id}`} style={{ color: "inherit", textDecoration: "none" }}>{p.body.slice(0, 140)}</Link>
                <div className="cc-muted">{p.owner ? `${personName(p.owner)} has it` : "Nobody has it yet"}, opened {ago(p.created_at)}</div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Empty>No open problems.</Empty>
      )}

      <h2 className="cc-h2">Calendar <Link href="/command/calendar">Open calendar</Link></h2>
      {cal.ok ? (
        <div className="cc-grid two">
          <div className="cc-card">
            <h3>Today</h3>
            {todays.length ? (
              <ul className="cc-list">{todays.map((e) => <li key={e.id}><strong>{e.allDay ? "All day" : fmtWhen(e.start).split(", ").pop()}</strong> {e.title}</li>)}</ul>
            ) : <p className="cc-sub">Nothing on the calendar today.</p>}
          </div>
          <div className="cc-card">
            <h3>Rest of this week</h3>
            {week.length ? (
              <ul className="cc-list">{week.slice(0, 8).map((e) => <li key={e.id}><strong>{fmtWhen(e.start)}</strong> {e.title}</li>)}</ul>
            ) : <p className="cc-sub">Nothing else this week.</p>}
          </div>
        </div>
      ) : (
        <Empty>
          {calendarId()
            ? cal.reason === "not-configured"
              ? "Today's events list here once the Google Calendar service account is added. The calendar itself is on the Calendar screen."
              : cal.reason
            : "The shared team calendar is not connected yet. See Setup."}
        </Empty>
      )}
    </>
  );
}
