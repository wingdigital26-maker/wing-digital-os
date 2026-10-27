import { body, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { addEvent, addLink, calendarApiReady } from "@/lib/command/calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add an event to the shared team calendar. With the Google API configured it
// is written directly; otherwise the response carries a pre-filled Google
// Calendar link the person taps to save it themselves.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const title = text(b.title, 200);
  const date = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null;
  if (!title || !date) return fail("Add a title and a date.");
  const startT = typeof b.start === "string" && /^\d{2}:\d{2}$/.test(b.start) ? b.start : null;
  const mins = Math.min(Math.max(Number(b.minutes) || 30, 5), 600);
  const allDay = !startT;
  let start: string, end: string;
  if (allDay) {
    start = date;
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    end = d.toISOString().slice(0, 10);
  } else {
    // Wall-clock Central time; Google applies the timeZone we send.
    start = `${date}T${startT}:00`;
    const [h, m] = startT!.split(":").map(Number);
    const total = h * 60 + m + mins;
    const endDay = new Date(`${date}T12:00:00Z`);
    endDay.setUTCDate(endDay.getUTCDate() + Math.floor(total / 1440));
    const t = total % 1440;
    end = `${endDay.toISOString().slice(0, 10)}T${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`;
  }
  const ev = { title, start, end, details: text(b.details, 2000) ?? `Added by ${u.id} from the Wing Command Center`, where: text(b.where, 200) ?? undefined, allDay };
  if (!calendarApiReady()) {
    return json({ ok: true, written: false, link: addLink({ ...ev, start: allDay ? start.replace(/-/g, "") : start, end: allDay ? end.replace(/-/g, "") : end }) });
  }
  try {
    const link = await addEvent(ev);
    return json({ ok: true, written: true, link });
  } catch (e) {
    return fail(`Google Calendar refused it: ${e instanceof Error ? e.message : e}`, 502);
  }
}
