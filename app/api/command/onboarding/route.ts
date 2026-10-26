import { body, fail, isResponse, json, requireUser } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { ONBOARDING } from "@/lib/command/onboarding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Tick or untick one onboarding step for a deal.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const id = Number(b.deal_id);
  const item = ONBOARDING.find((i) => i.key === b.item_key);
  if (!Number.isInteger(id) || !item) return fail("Which step?");
  const done = b.done === true;
  const r = await withStore((sql) =>
    sql`insert into cc_onboarding (deal_id, item_key, done, done_by, done_at)
        values (${id}, ${item.key}, ${done}, ${done ? u.id : null}, ${done ? sql`now()` : null})
        on conflict (deal_id, item_key) do update set done = excluded.done, done_by = excluded.done_by, done_at = excluded.done_at`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}
