import { body, fail, json, machineAuthorized } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { upsertProspects, type ProspectIn } from "@/lib/command/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Jack's laptop pushes prospects.db up here (scripts/command_center/sync_prospects.py).
// Machine key only (Bearer COMMAND_MACHINE_KEY). Upserts on the prospects.db id;
// call outcomes and notes are never overwritten, and nothing flows back down.
export async function POST(req: Request) {
  if (!machineAuthorized(req)) return fail("Not allowed.", 401);
  const b = await body<{ rows?: ProspectIn[]; source?: string }>(req);
  if (!Array.isArray(b.rows)) return fail("Send { rows: [...] }.");
  if (b.rows.length > 5000) return fail("Up to 5,000 rows per request; the script batches.");
  const r = await withStore((sql) => upsertProspects(sql, b.rows!, "laptop-sync"));
  return r.ok ? json({ ok: true, ...r.data }) : fail(r.reason, 503);
}
