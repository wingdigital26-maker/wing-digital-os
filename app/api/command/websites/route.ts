import { body, day, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["brief_sent", "building", "review", "delivered", "cancelled"];
const url = (v: unknown) => {
  const t = text(v, 500);
  return t && /^https?:\/\//.test(t) ? t : null;
};

// Website jobs sent to Pansh. POST creates, PATCH updates one by id.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const client = text(b.client, 200);
  if (!client) return fail("Which client is the site for?");
  const price = b.price === "" || b.price == null ? null : Number(b.price);
  if (price != null && !Number.isFinite(price)) return fail("Price must be a number.");
  const r = await withStore((sql) =>
    sql`insert into cc_website_jobs (client, brief_url, due_date, price, notes, created_by)
        values (${client}, ${url(b.brief_url)}, ${day(b.due_date)}, ${price}, ${text(b.notes, 2000)}, ${u.id})`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}

export async function PATCH(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const id = Number(b.id);
  if (!Number.isInteger(id)) return fail("Which job?");
  const status = STATUSES.includes(String(b.status)) ? String(b.status) : null;
  const r = await withStore(async (sql) => {
    const [job] = await sql`select id from cc_website_jobs where id = ${id}`;
    if (!job) return false;
    if (status) {
      await sql`update cc_website_jobs set status = ${status},
                delivered_at = case when ${status} = 'delivered' then coalesce(delivered_at, (now() at time zone 'America/Chicago')::date) else delivered_at end,
                updated_at = now() where id = ${id}`;
    }
    if (typeof b.paid === "boolean") await sql`update cc_website_jobs set paid = ${b.paid}, updated_at = now() where id = ${id}`;
    if ("delivered_url" in b) await sql`update cc_website_jobs set delivered_url = ${url(b.delivered_url)}, updated_at = now() where id = ${id}`;
    if ("due_date" in b) await sql`update cc_website_jobs set due_date = ${day(b.due_date)}, updated_at = now() where id = ${id}`;
    if ("price" in b) {
      const p = b.price === "" || b.price == null ? null : Number(b.price);
      if (p == null || Number.isFinite(p)) await sql`update cc_website_jobs set price = ${p}, updated_at = now() where id = ${id}`;
    }
    if ("brief_url" in b) await sql`update cc_website_jobs set brief_url = ${url(b.brief_url)}, updated_at = now() where id = ${id}`;
    return true;
  });
  if (!r.ok) return fail(r.reason, 503);
  return r.data ? json({ ok: true }) : fail("Unknown job.", 404);
}
