// ───────────────────────────────────────────────────────────────────────────
// Shared iCal (RFC 5545) parsing — one parser, so every lane that reads a
// Google Calendar feed agrees on exactly what "busy" means.
//
// This was the private parser inside app/api/calendar/route.ts's google lane.
// The booking engine needs the same busy events to stop offering a slot Jack
// already has a meeting in, so the parser now lives here and both import it.
// Behavior is unchanged from the original: nothing is invented, cancelled
// events are dropped, and a floating or TZID-qualified local time is emitted
// without an offset so the reader interprets it in the calendar's own zone.
// ───────────────────────────────────────────────────────────────────────────

/** A parsed calendar event. Structurally a subset of the calendar route's
 *  CalendarEvent (source pinned to "google"), so it stays assignable there. */
export type IcsEvent = {
  id: string;
  source: "google";
  title: string;
  /** ISO instant (…Z = UTC, no offset = floating local), or YYYY-MM-DD all-day. */
  start: string;
  end: string | null;
  allDay: boolean;
  detail: string | null;
  url: string | null;
  external: boolean;
  status: string | null;
};

// Unfold RFC 5545 continuation lines (a leading space or tab continues the
// previous line) before anything is parsed out of them.
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

export function unescapeText(v: string): string {
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

export type IcsTime = { value: string; allDay: boolean } | null;

// DTSTART / DTEND to either a YYYY-MM-DD (all-day) or an ISO instant.
// A trailing Z is UTC. A floating or TZID-qualified local time is emitted
// without an offset so the browser reads it in its own zone, which is the
// zone Jack is in and the zone the calendar was authored in.
export function icsTime(params: string, value: string): IcsTime {
  const v = value.trim();
  if (/VALUE=DATE(?![-A-Z])/i.test(params) || /^\d{8}$/.test(v)) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    return m ? { value: `${m[1]}-${m[2]}-${m[3]}`, allDay: true } : null;
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  const base = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return { value: m[7] ? `${base}Z` : base, allDay: false };
}

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let cur: Record<string, { params: string; value: string }> | null = null;

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const start = cur.DTSTART ? icsTime(cur.DTSTART.params, cur.DTSTART.value) : null;
        if (start) {
          const end = cur.DTEND ? icsTime(cur.DTEND.params, cur.DTEND.value) : null;
          const uid = cur.UID?.value ?? `${start.value}-${events.length}`;
          const status = cur.STATUS?.value ? cur.STATUS.value.toLowerCase() : null;
          // The link is used ONLY when the feed actually carries one. Google's
          // iCal export supplies URL:…/calendar/event?eid=…; when it does not,
          // the event simply has no link rather than a guessed one.
          const url = cur.URL?.value?.trim() || null;
          if (status !== "cancelled") {
            events.push({
              id: `google:${uid}`,
              source: "google",
              title: unescapeText(cur.SUMMARY?.value ?? "(no title)"),
              start: start.value,
              end: end ? end.value : null,
              allDay: start.allDay,
              detail: cur.LOCATION?.value ? unescapeText(cur.LOCATION.value) : null,
              url: url && /^https?:\/\//i.test(url) ? url : null,
              external: true,
              status,
            });
          }
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const left = line.slice(0, colon);
    const semi = left.indexOf(";");
    const name = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
    cur[name] = { params: semi < 0 ? "" : left.slice(semi + 1), value: line.slice(colon + 1) };
  }
  return events;
}
