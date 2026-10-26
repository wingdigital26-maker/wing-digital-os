import { body, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { notifyTeam } from "@/lib/command/notify";
import { personName, TEAM } from "@/lib/command/team";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function idOf(ctx: Ctx): Promise<number | null> {
  const n = Number((await ctx.params).id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function GET(_req: Request, ctx: Ctx) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const id = await idOf(ctx);
  if (!id) return fail("Unknown problem.", 404);
  const r = await withStore((sql) =>
    sql`select id::int, by_user, body, created_at::text from cc_problem_comments where problem_id = ${id} order by created_at`
  );
  return r.ok ? json({ ok: true, comments: r.data }) : fail(r.reason, 503);
}

// Change status / owner, or add a comment.
export async function PATCH(req: Request, ctx: Ctx) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const id = await idOf(ctx);
  if (!id) return fail("Unknown problem.", 404);
  const b = await body(req);
  const status = ["open", "working", "fixed"].includes(String(b.status)) ? String(b.status) : null;
  const owner =
    b.owner === "" ? "" : TEAM.some((p) => p.id === b.owner) ? String(b.owner) : null;
  const comment = text(b.comment, 2000);
  if (!status && owner === null && !comment) return fail("Nothing to change.");

  const r = await withStore(async (sql) => {
    const [p] = await sql<{ id: number; status: string; client_slug: string | null; body: string }[]>`
      select id::int, status, client_slug, body from cc_problems where id = ${id}`;
    if (!p) return null;
    if (status) {
      await sql`update cc_problems set status = ${status}, updated_at = now(),
                fixed_at = ${status === "fixed" ? sql`now()` : null} where id = ${id}`;
    }
    if (owner !== null) {
      await sql`update cc_problems set owner = ${owner || null}, updated_at = now() where id = ${id}`;
    }
    if (comment) {
      await sql`insert into cc_problem_comments (problem_id, by_user, body) values (${id}, ${u.id}, ${comment})`;
      await sql`update cc_problems set updated_at = now() where id = ${id}`;
    }
    return p;
  });
  if (!r.ok) return fail(r.reason, 503);
  if (!r.data) return fail("Unknown problem.", 404);
  // Tell the team when something gets fixed, so the reporter knows.
  if (status === "fixed" && r.data.status !== "fixed") {
    await notifyTeam("problem-fixed", `Fixed: ${r.data.client_slug ?? "Wing"}`,
      `${personName(u.id)} marked #${id} fixed: ${r.data.body.slice(0, 160)}`);
  }
  return json({ ok: true });
}
