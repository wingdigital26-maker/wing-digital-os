import Link from "next/link";
import { loadClients, TOUCH_EVERY_DAYS } from "@/lib/command/clients";
import { withStore } from "@/lib/command/db";
import { personName } from "@/lib/command/team";
import { ago, dayCT, daysBetween, fmtWhen, weekStart } from "@/lib/command/time";
import { Empty, Problems, Stat } from "../../_ui/bits";
import TouchForm from "../../_ui/TouchForm";

export const dynamic = "force-dynamic";

// Roofer check-ins (Dylan): one touch a week per signed roofer. Overdue is red.
export default async function RoofersPage() {
  const { clients, errors } = await loadClients();
  const roofers = clients.filter((c) => c.isRoofer).sort((a, b) => Number(b.touchOverdue) - Number(a.touchOverdue));
  const today = dayCT();
  const recent = await withStore((sql) =>
    sql<{ client_slug: string; channel: string; mood: string; problems: string | null; note: string | null; by_user: string; created_at: string }[]>`
      select client_slug, channel, mood, problems, note, by_user, created_at::text from cc_roofer_touches order by created_at desc limit 15`
  );
  const names = new Map(clients.map((c) => [c.slug, c.name]));
  const doneThisWeek = recent.ok ? new Set(recent.data.filter((t) => dayCT(t.created_at) >= weekStart(today)).map((t) => t.client_slug)).size : 0;

  return (
    <>
      <h1 className="cc-h1">Roofer check-ins</h1>
      <p className="cc-lede">Every signed roofer gets a call or text each week. Red means it has been {TOUCH_EVERY_DAYS} days or more. A problem they raise opens a Problem and texts the team.</p>
      <Problems errors={[...errors, recent.ok ? null : recent.reason]} />
      <div className="cc-grid three">
        <Stat l="Roofers" n={roofers.length} />
        <Stat l="Overdue" n={roofers.filter((r) => r.touchOverdue).length} tone={roofers.some((r) => r.touchOverdue) ? "bad" : undefined} />
        <Stat l="Done this week" n={doneThisWeek} />
      </div>
      <h2 className="cc-h2">Roofers</h2>
      {roofers.length ? (
        <div className="cc-grid two">
          {roofers.map((r) => {
            const since = r.lastTouch ? daysBetween(dayCT(r.lastTouch.at), today) : null;
            return (
              <div key={r.slug} className={`cc-card ${r.touchOverdue ? "edge-red" : "edge-green"}`}>
                <div className="cc-spread">
                  <h3><Link href={`/command/clients/${r.slug}`}>{r.name}</Link></h3>
                  {r.touchOverdue ? <span className="cc-tag red">Overdue</span> : <span className="cc-tag green">Done</span>}
                </div>
                <div className="cc-sub">
                  {r.lastTouch ? `Last: ${ago(r.lastTouch.at)} by ${personName(r.lastTouch.by)}, ${r.lastTouch.mood}` : "Never checked in"}
                  {since != null && r.touchOverdue ? `. ${since} days.` : ""}
                </div>
                {r.atRisk.length ? <div className="cc-sub" style={{ color: "var(--red)" }}>{r.atRisk.join(". ")}</div> : null}
                <div className="cc-row" style={{ margin: "12px 0" }}>
                  {r.contactPhone ? <a className="cc-btn cc-call" href={`tel:${r.contactPhone.replace(/[^\d+]/g, "")}`}>Call {r.contactName ?? ""}</a> : null}
                  {r.contactPhone ? <a className="cc-btn" href={`sms:${r.contactPhone.replace(/[^\d+]/g, "")}`}>Text</a> : null}
                  {!r.contactPhone ? <Link className="cc-btn small" href={`/command/clients/${r.slug}`}>Add a phone number</Link> : null}
                </div>
                <TouchForm slug={r.slug} name={r.name} />
              </div>
            );
          })}
        </div>
      ) : (
        <Empty>No roofers yet. A client counts as a roofer when the vault says roofing, Roof Command lists them, or the team ticks Roofer on the client page.</Empty>
      )}

      <h2 className="cc-h2">Latest check-ins</h2>
      {recent.ok && recent.data.length ? (
        <div className="cc-card">
          <ul className="cc-list">
            {recent.data.map((t, i) => (
              <li key={i}>
                <strong>{names.get(t.client_slug) ?? t.client_slug}</strong>, {t.channel} by {personName(t.by_user)}, {fmtWhen(t.created_at)}.{" "}
                <span className={`cc-tag ${t.mood === "unhappy" ? "red" : t.mood === "happy" ? "green" : ""}`}>{t.mood}</span>
                {t.problems ? <div className="cc-sub">Problem: {t.problems}</div> : null}
                {t.note ? <div className="cc-sub">{t.note}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : <Empty>No check-ins logged yet.</Empty>}
    </>
  );
}
