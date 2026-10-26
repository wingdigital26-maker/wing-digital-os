import { body, day, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Billing status per client: paid / due / late. Manual for now; a Stripe
// webhook can write the same row later without changing any screen.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const key = text(b.client_key, 120);
  const status = ["paid", "due", "late"].includes(String(b.status)) ? String(b.status) : null;
  if (!key || !status) return fail("Pick a client and paid, due or late.");
  const amount = b.amount === "" || b.amount == null ? null : Number(b.amount);
  if (amount != null && !Number.isFinite(amount)) return fail("Amount must be a number.");
  const r = await withStore((sql) =>
    sql`insert into cc_billing (client_key, status, amount, due_date, note, updated_by)
        values (${key}, ${status}, ${amount}, ${day(b.due_date)}, ${text(b.note, 300)}, ${u.id})
        on conflict (client_key) do update set status = excluded.status, amount = excluded.amount,
          due_date = excluded.due_date, note = excluded.note, updated_by = excluded.updated_by, updated_at = now()`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}
