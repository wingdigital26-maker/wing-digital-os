import { body, fail, json, machineAuthorized, text } from "@/lib/command/api";
import { withStore } from "@/lib/command/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Content agents report each run here so the SEO screen shows a real last-run
// time and status. Machine key only. Body:
//   { agent: "jackson-content-weekly", client: "jackson-roofing",
//     status: "ok" | "failed" | "skipped", published: 2, note: "..." }
export async function POST(req: Request) {
  if (!machineAuthorized(req)) return fail("Not allowed.", 401);
  const b = await body(req);
  const agent = text(b.agent, 80);
  const status = ["ok", "failed", "skipped"].includes(String(b.status)) ? String(b.status) : null;
  if (!agent || !status) return fail("Send agent and status (ok, failed or skipped).");
  const published = Number.isInteger(b.published) ? Number(b.published) : null;
  const r = await withStore((sql) =>
    sql`insert into cc_agent_runs (agent, client_slug, status, published, note)
        values (${agent}, ${text(b.client, 120)}, ${status}, ${published}, ${text(b.note, 500)})`
  );
  return r.ok ? json({ ok: true }) : fail(r.reason, 503);
}
