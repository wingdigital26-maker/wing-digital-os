import { body, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The team's own fields on a client card: plan, MRR, CRM/app link, next action,
// roofer contact. Vault data is never written from here.
export async function PATCH(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const slug = text(b.slug, 120);
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return fail("Which client?");
  const mrrRaw = b.mrr === "" || b.mrr == null ? null : Number(b.mrr);
  if (mrrRaw != null && !(Number.isFinite(mrrRaw) && mrrRaw >= 0)) return fail("MRR must be a number.");
  const crm = text(b.crm_url, 500);
  if (crm && !/^https?:\/\//.test(crm)) return fail("The CRM link must start with https://");
  const r = await withStore((sql) =>
    sql`insert into cc_client_meta (slug, display_name, plan, mrr, crm_url, next_action, is_roofer, roofer_contact, roofer_phone, active, updated_by)
        values (${slug}, ${text(b.display_name, 200)}, ${text(b.plan, 120)}, ${mrrRaw}, ${crm}, ${text(b.next_action, 500)},
                ${typeof b.is_roofer === "boolean" ? b.is_roofer : null}, ${text(b.roofer_contact, 120)}, ${text(b.roofer_phone, 40)},
                ${b.active === false ? false : true}, ${u.id})
        on conflict (slug) do update set
          display_name = excluded.display_name, plan = excluded.plan, mrr = excluded.mrr, crm_url = excluded.crm_url,
          next_action = excluded.next_action, is_roofer = excluded.is_roofer, roofer_contact = excluded.roofer_contact,
          roofer_phone = excluded.roofer_phone, active = excluded.active, updated_by = excluded.updated_by, updated_at = now()`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}
