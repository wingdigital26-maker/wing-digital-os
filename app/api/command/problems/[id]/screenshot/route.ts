import { fail, isResponse, requireUser } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The problem's screenshot, behind the Command Center login. Never cached publicly.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return fail("Unknown problem.", 404);
  const r = await withStore((sql) => sql<{ screenshot: string | null }[]>`select screenshot from cc_problems where id = ${id}`);
  if (!r.ok) return fail(r.reason, 503);
  const shot = r.data[0]?.screenshot;
  const m = shot?.match(/^data:(image\/[a-z+]+);base64,(.*)$/);
  if (!m) return fail("No screenshot.", 404);
  return new Response(Buffer.from(m[2], "base64"), {
    headers: { "Content-Type": m[1], "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
