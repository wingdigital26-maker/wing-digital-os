import { fail, json, machineAuthorized } from "@/lib/command/api";
import { currentUser } from "@/lib/command/auth";
import { currentChecks, problemLines, recordChecks } from "@/lib/command/checks";
import { notifyTeam } from "@/lib/command/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  (signed-in teammate or machine key): the latest check per client, with
//      missing / stale (> 36h) flags. Read-only.
// POST (machine key: the daily routine, or Jack): records today's snapshot for
//      the history view and, when any client is missing, stale or red, texts
//      the team one summary. ?quiet=1 records without texting.
export async function GET(req: Request) {
  if (!machineAuthorized(req) && !(await currentUser())) return fail("Not allowed.", 401);
  const c = await currentChecks();
  return json({ ok: true, ...c, flagged: problemLines(c.rows) });
}

export async function POST(req: Request) {
  const machine = machineAuthorized(req);
  if (!machine && !(await currentUser())?.admin) return fail("Not allowed.", 401);
  const c = await currentChecks();
  if (!c.rows.length) return fail(c.errors.join(" ") || "No clients found in the vault.", 503);
  const saved = await recordChecks(c.rows);
  const flagged = problemLines(c.rows);
  let notify = null;
  if (flagged.length && new URL(req.url).searchParams.get("quiet") !== "1") {
    notify = await notifyTeam(
      "daily-check",
      `Daily client check: ${flagged.length} need a look`,
      `${flagged.join("\n")}\n${new URL(req.url).origin}/command/checks`
    );
  }
  return json({
    ok: true,
    clients: c.rows.length,
    recorded: saved.ok ? saved.data : 0,
    storeError: saved.ok ? null : saved.reason,
    flagged,
    notify,
  });
}
