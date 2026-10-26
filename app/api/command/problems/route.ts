import { body, fail, isResponse, json, requireUser, text } from "@/lib/command/api";
import { createProblem, listProblems, validScreenshot } from "@/lib/command/problems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const r = await listProblems();
  return r.ok ? json({ ok: true, problems: r.data }) : fail(r.reason, 503);
}

// Report a problem. Texts Jack, Grant and Dylan on save.
export async function POST(req: Request) {
  const u = await requireUser();
  if (isResponse(u)) return u;
  const b = await body(req);
  const problem = text(b.body, 4000);
  if (!problem) return fail("Say what the problem is.");
  const urgency = b.urgency === "urgent" || b.urgency === "low" ? b.urgency : "normal";
  const shot = b.screenshot ? validScreenshot(b.screenshot) : null;
  if (b.screenshot && !shot) return fail("The screenshot must be an image under 1.5 MB.");
  const r = await createProblem({
    client_slug: text(b.client_slug, 120),
    client_name: text(b.client_name, 200),
    reported_by: u.id,
    urgency,
    body: problem,
    screenshot: shot,
    baseUrl: new URL(req.url).origin,
  });
  return r.ok ? json({ ok: true, id: r.data.id, notify: r.data.notify }) : fail(r.reason, 503);
}
