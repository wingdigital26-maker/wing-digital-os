import { calendarApiReady, calendarId, embedUrl, listEvents } from "@/lib/command/calendar";
import { addDays, ctStartIso, dayCT, fmtWhen, weekStart } from "@/lib/command/time";
import { Empty } from "../../_ui/bits";
import AddEvent from "../../_ui/AddEvent";

export const dynamic = "force-dynamic";

// Calendar: one shared team calendar on the wingdigital26 Google account.
export default async function CalendarPage() {
  const id = calendarId();
  const today = dayCT();
  const wk = weekStart(today);
  const ev = await listEvents(ctStartIso(wk), ctStartIso(addDays(wk, 14)));
  const embed = embedUrl("WEEK");

  return (
    <>
      <h1 className="cc-h1">Calendar</h1>
      <p className="cc-lede">One shared Wing team calendar. Meetings Dylan books, client calls, site due dates: all of it goes here.</p>
      {!id ? (
        <div className="cc-note">
          <strong>Not connected yet.</strong> Jack creates a calendar named Wing Team on the wingdigital26 Google account and adds its ID as COMMAND_CALENDAR_ID. Steps are on the Setup screen.
        </div>
      ) : null}
      <AddEvent direct={calendarApiReady()} />
      {ev.ok ? (
        <>
          <h2 className="cc-h2">This week and next</h2>
          {ev.events.length ? (
            <div className="cc-card">
              <ul className="cc-list">
                {ev.events.map((e) => (
                  <li key={e.id}>
                    <strong>{e.allDay ? `${fmtWhen(`${e.start}T12:00:00Z`).split(",")[0]}, all day` : fmtWhen(e.start)}</strong> {e.title}
                    {e.where ? <div className="cc-muted">{e.where}</div> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : <Empty>Nothing on the calendar for the next two weeks.</Empty>}
        </>
      ) : id && ev.reason !== "not-configured" ? <div className="cc-note err">{ev.reason}</div> : null}
      {embed ? (
        <>
          <h2 className="cc-h2">Calendar view <a href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(id!)}`} target="_blank" rel="noreferrer">Open in Google Calendar</a></h2>
          <iframe className="cc-embed" src={embed} title="Wing team calendar" />
          <p className="cc-muted">The embed shows events to anyone signed in to a Google account the calendar is shared with.</p>
        </>
      ) : null}
    </>
  );
}
