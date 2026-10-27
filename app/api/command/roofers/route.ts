import { body, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";
import { createProblem } from "@/lib/command/problems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Log Dylan's weekly touch with a signed roofer. Any problem raised becomes a
// Problem (and texts the team), linked back to this check-in.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const slug = text(b.client_slug, 120);
  if (!slug) return fail("Which roofer?");
  const channel = ["call", "text", "visit"].includes(String(b.channel)) ? String(b.channel) : null;
  const mood = ["happy", "ok", "unhappy"].includes(String(b.mood)) ? String(b.mood) : null;
  if (!channel || !mood) return fail("Pick call or text, and how they felt.");
  const problems = text(b.problems, 2000);
  const note = text(b.note, 2000);

  let problemId: number | null = null;
  let notify = null;
  if (problems) {
    const p = await createProblem({
      client_slug: slug,
      client_name: text(b.client_name, 200),
      reported_by: u.id,
      urgency: mood === "unhappy" ? "urgent" : "normal",
      body: `From the weekly check-in: ${problems}`,
      source: "roofer-checkin",
      baseUrl: new URL(req.url).origin,
    });
    if (!p.ok) return fail(p.reason, 503);
    problemId = p.data.id;
    notify = p.data.notify;
  }
  const r = await withStore((sql) =>
    sql`insert into cc_roofer_touches (client_slug, channel, mood, problems, note, problem_id, by_user)
        values (${slug}, ${channel}, ${mood}, ${problems}, ${note}, ${problemId}, ${u.id})`
  );
  return r.ok ? json({ ok: true, problem_id: problemId, notify }) : fail(r.reason, 503);
}
