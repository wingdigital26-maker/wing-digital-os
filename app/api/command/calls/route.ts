import { body, day, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { OUTCOMES } from "@/lib/command/prospects";
import { addDays, dayCT } from "@/lib/command/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Log a call outcome. Stored in the cloud only, never in prospects.db.
// "Meeting booked" also drops the business into the sales pipeline at Meeting.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const id = text(b.prospect_id, 120);
  const o = OUTCOMES.find((x) => x.key === b.outcome);
  if (!id) return fail("Which prospect?");
  const note = text(b.note, 2000);
  // Notes alone (no outcome) just update the prospect's notes.
  const next = day(b.next_call_date) ?? (o?.days != null ? addDays(dayCT(), o.days) : null);
  const r = await withStore(async (sql) => {
    const [p] = await sql<{ business: string; contact: string | null; phone: string | null; email: string | null }[]>`
      select business, contact, phone, email from cc_prospects where id = ${id}`;
    if (!p) return null;
    if (o) {
      await sql`insert into cc_call_outcomes (prospect_id, outcome, note, next_call_date, by_user)
                values (${id}, ${o.key}, ${note}, ${next}, ${u.id})`;
      await sql`update cc_prospects set last_outcome = ${o.key}, last_called_at = now(), next_call_date = ${next},
                notes = coalesce(${note}, notes), archived = ${o.key === "not_interested"}, updated_at = now()
                where id = ${id}`;
      if (o.key === "meeting") {
        await sql`insert into cc_deals (business, contact, phone, email, stage, owner, prospect_id, notes)
                  select ${p.business}, ${p.contact}, ${p.phone}, ${p.email}, 'meeting', ${u.id}, ${id}, ${note}
                   where not exists (select 1 from cc_deals where prospect_id = ${id})`;
      }
    } else {
      await sql`update cc_prospects set notes = ${note},
                next_call_date = coalesce(${day(b.next_call_date)}::date, next_call_date), updated_at = now() where id = ${id}`;
    }
    return true;
  });
  if (!r.ok) return fail(r.reason, 503);
  if (!r.data) return fail("That prospect is not on the list.", 404);
  return json({ ok: true, next_call_date: next });
}
