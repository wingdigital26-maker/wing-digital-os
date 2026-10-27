import { fail, json, machineAuthorized } from "@/lib/command/api";
import { currentUser } from "@/lib/command/auth";
import { loadClients } from "@/lib/command/clients";
import { notifyTeam } from "@/lib/command/notify";
import { digestText } from "@/lib/command/problems";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Morning digest: texts the team every open problem plus overdue roofer
// check-ins. Called by the daily routine (Bearer COMMAND_MACHINE_KEY) or by
// Jack from the Problems screen. GET only previews the text; POST sends it.
async function run(req: Request, send: boolean) {
  const machine = machineAuthorized(req);
  const user = machine ? null : await currentUser();
  if (!machine && !user?.admin) return fail("Not allowed.", 401);
  const d = await digestText();
  if (!d.ok) return fail(d.reason, 503);
  const { clients } = await loadClients();
  const overdue = clients.filter((c) => c.isRoofer && c.touchOverdue).map((c) => c.name);
  const risk = clients.filter((c) => c.atRisk.length).map((c) => `${c.name} (${c.atRisk[0]})`);
  const parts = [d.data.text];
  if (overdue.length) parts.push(`Roofer check-ins due: ${overdue.join(", ")}`);
  if (risk.length) parts.push(`At risk: ${risk.join("; ")}`);
  const msg = parts.join("\n\n");
  if (!send) return json({ ok: true, text: msg, sent: false });
  const n = await notifyTeam("digest", "Wing morning digest", msg);
  return json({ ok: true, text: msg, notify: n });
}

export const GET = (req: Request) => run(req, false);
export const POST = (req: Request) => run(req, true);
