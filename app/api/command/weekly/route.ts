import { body, day, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { weekStart } from "@/lib/command/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Numbers the software cannot count itself yet (Grant's Instantly and Twilio
// outreach). Each person enters their own; Jack can enter anyone's.
const METRICS: Record<string, string[]> = { grant: ["emails_sent", "replies", "meetings"] };

export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const person = text(b.person, 20) ?? "";
  const metric = text(b.metric, 40) ?? "";
  if (!METRICS[person]?.includes(metric)) return fail("Unknown number.");
  if (person !== u.id && !u.admin) return fail("You can only enter your own numbers.", 403);
  const value = Number(b.value);
  if (!Number.isFinite(value) || value < 0) return fail("Enter a number.");
  const week = weekStart(day(b.week) ?? undefined);
  const r = await withStore((sql) =>
    sql`insert into cc_weekly_numbers (week_start, person, metric, value, updated_by)
        values (${week}, ${person}, ${metric}, ${value}, ${u.id})
        on conflict (week_start, person, metric) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}
