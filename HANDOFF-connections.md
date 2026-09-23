# Handoff: data connections, 2026-09-22

Written by the connections pass on `ui/crm-email`. Everything below sits in a
file that pass does not own, so it is listed here instead of edited.

## 1. InvoicesBoard still draws $0 over an unreadable book

`app/api/invoices/route.ts` now answers with `unavailable: true` and a sentence
in `error` when the read is refused, instead of falling through to an empty
list. `app/components/InvoicesBoard.tsx` prints the sentence but still renders
the tiles underneath it: OUTSTANDING $0.00, PAID THIS MONTH $0.00, OVERDUE 0,
"No payments expected", "No invoices yet". Those numbers are not known to be
zero, so the money screen is still the least honest screen in the OS.

The fix is one early return, next to the existing `!data.configured` branch and
before `const t = data.totals`:

```tsx
  if (data.unavailable) {
    return (
      <div style={card}>
        <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>Invoices could not be read</p>
        <p style={{ margin: "6px 0 0", color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5 }}>
          {data.error}
        </p>
      </div>
    );
  }
```

and `unavailable?: boolean` added to the `Payload` type.

## 2. The booking surface can go entirely

Jack's call: the calendar is invoices and payments only. Checked and true:
nothing on the money side touches bookings. `/api/invoices` reads the Sonar
Supabase project's `invoices` table and imports nothing from `/api/booking`;
`app/page.tsx` already mounts `InvoicesBoard` as the whole calendar section, so
`BookingsAdmin` is on disk but unmounted and cannot raise its error any more.

Verdict: the booking DB error is attached ONLY to the availability feature, so
the answer is removal, not repair. It was not removed in this pass because the
removal set reaches four files this pass does not own, and cutting half of it
would leave a public page fetching a route that is gone. The whole set, in
dependency order:

1. `app/components/CalendarBoard.tsx` still does
   `dynamic(() => import("./BookingsAdmin"))` at line 7 and renders it at line
   626, so `BookingsAdmin.tsx` cannot be deleted before CalendarBoard is.
2. `app/components/CommandPalette.tsx` lines 43 to 51 copy `${origin}/book` as
   a palette action, so `app/book/` cannot be deleted before that action is.
3. `app/api/calls/schedule/route.ts` line 181 reads the `bookings` table for
   its own lane, and `app/api/calendar/route.ts` line 624 has a bookings lane
   that names the `/book` link in its empty-state note. Both need their
   bookings lane cut, not the whole file.
4. Only then: `app/book/`, `app/api/booking/`, `app/api/calendar/availability/`,
   `app/components/BookingsAdmin.tsx`.

`app/api/calendar/route.ts` itself must stay. Its school and blocks lanes are
the only working calendar data left; only the bookings lane inside it goes.

Until that happens the error at least names its real cause instead of blaming
configuration.

## 3. Routes still returning zeros for a refused read, outside this pass's files

- `app/api/intel/route.ts`: six `res.ok ? await res.json() : []` fallbacks, so
  the board shows `{ total: 0, new: 0, reviewed: 0 }` while Supabase is 402ing
  every table. Same shape of bug as the invoices one fixed here.
- `app/api/calls/leads/route.ts` and `app/api/calls/stats/route.ts` fail
  honestly (502) but the body is only `could not read leads`, which does not
  say the project is restricted. `sbFailureReason` in `lib/osSupabase.ts` is
  there to be reused.
- `app/api/blocks/route.ts` returns `Read failed (HTTP 402)`, which is true but bare.
- `app/api/sonar/route.ts` returns `error: "Supabase 402"`, which is true but bare.

## 4. Routes that shell out to python

`lib/python.ts` is new: `runPython()` tries `OS_PYTHON`, then `python`, then
`C:/Python314|313|312/python.exe`, retrying only on `ENOENT` so a script that
really ran and failed still surfaces. `app/api/prospects/route.ts` uses it and
now answers 503 with the reason instead of 200 with an empty list. Any other
route that spawns python should move onto the same helper.

## 5. The one dependency behind all of it

Both Supabase projects the OS reads are restricted for
`exceed_storage_size_quota`, which returns HTTP 402 on every table. Nothing in
this repo can fix that. Clearing the quota in the Supabase dashboard brings
social, reviews, forms, pipeline, bookings, invoices, intel, alerts, messages,
storms and the call room back at once.
