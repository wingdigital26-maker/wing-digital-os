import { body, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { slugify } from "@/lib/command/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STAGES = ["lead", "meeting", "proposal", "signed", "onboarding", "live", "lost"];

// Sales pipeline. A deal marked Signed moves straight into Onboarding (its day
// 0 to 14 checklist starts); a deal marked Live becomes a client card.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const business = text(b.business, 200);
  if (!business) return fail("Business name?");
  const value = b.value_monthly === "" || b.value_monthly == null ? null : Number(b.value_monthly);
  if (value != null && !Number.isFinite(value)) return fail("Value must be a number.");
  const stage = STAGES.includes(String(b.stage)) ? String(b.stage) : "lead";
  const r = await withStore((sql) =>
    sql`insert into cc_deals (business, contact, phone, email, stage, product, value_monthly, owner, notes)
        values (${business}, ${text(b.contact, 120)}, ${text(b.phone, 40)}, ${text(b.email, 200)}, ${stage === "signed" ? "onboarding" : stage},
                ${text(b.product, 80)}, ${value}, ${u.id}, ${text(b.notes, 2000)}) returning id::int`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}

export async function PATCH(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const id = Number(b.id);
  if (!Number.isInteger(id)) return fail("Which deal?");
  let stage = STAGES.includes(String(b.stage)) ? String(b.stage) : null;
  if (stage === "signed") stage = "onboarding";
  const r = await withStore(async (sql) => {
    const [d] = await sql<{ business: string; client_slug: string | null; value_monthly: string | null; product: string | null }[]>`
      select business, client_slug, value_monthly, product from cc_deals where id = ${id}`;
    if (!d) return false;
    if (stage) await sql`update cc_deals set stage = ${stage}, stage_changed_at = now(), updated_at = now() where id = ${id}`;
    if ("notes" in b) await sql`update cc_deals set notes = ${text(b.notes, 2000)}, updated_at = now() where id = ${id}`;
    if (stage === "live") {
      const slug = d.client_slug || slugify(d.business);
      await sql`update cc_deals set client_slug = ${slug} where id = ${id}`;
      await sql`insert into cc_client_meta (slug, display_name, mrr, plan, is_roofer, updated_by)
                values (${slug}, ${d.business}, ${d.value_monthly}, ${d.product}, ${/roof/i.test(`${d.product ?? ""} ${d.business}`)}, ${u.id})
                on conflict (slug) do update set active = true, updated_at = now()`;
    }
    return true;
  });
  if (!r.ok) return fail(r.reason, 503);
  return r.data ? json({ ok: true }) : fail("Unknown deal.", 404);
}
