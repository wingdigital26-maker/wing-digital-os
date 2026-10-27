import { body, fail, isResponse, json, requireUser } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { upsertProspects, type ProspectIn } from "@/lib/command/prospects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CSV upload from the Cold calls screen. The browser parses the file and posts
// rows already mapped to { business, contact, phone, email, website, city, niche }.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body<{ rows?: ProspectIn[] }>(req);
  if (!Array.isArray(b.rows) || !b.rows.length) return fail("No rows in that file.");
  if (b.rows.length > 5000) return fail("Up to 5,000 rows per upload.");
  const r = await withStore((sql) => upsertProspects(sql, b.rows!, `csv:${u.id}`));
  return r.ok ? json({ ok: true, ...r.data }) : fail(r.reason, 503);
}
