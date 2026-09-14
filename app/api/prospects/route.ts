import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { isCloud, PC_REQUIRED_BODY } from "@/lib/runtime";
import { readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const GHL_CLI = "C:\\Users\\wjack\\ghl-cli";

// Kept in sync with VALID in ghl-cli/call_log.py.
const VALID_STATUS = new Set([
  "no-answer", "voicemail", "not-interested", "callback", "booked",
  "emailed", "closed", "new", "called",
]);

export async function GET() {
  if (isCloud()) {
    // Local-only: reads prospects.db via python on Jack's PC. In the cloud we
    // serve the snapshot export_cloud_state.py pushed into the vault.
    const snap = await readVaultFile("wiki/state/cloud/prospects.json");
    if (snap) {
      try {
        return NextResponse.json(JSON.parse(snap));
      } catch {
        /* fall through */
      }
    }
    return NextResponse.json({ ...PC_REQUIRED_BODY, prospects: [] });
  }
  try {
    const { stdout } = await execFileAsync(
      "python",
      ["dump_prospects_json.py"],
      { cwd: GHL_CLI, maxBuffer: 10 * 1024 * 1024 }
    );
    const prospects = JSON.parse(stdout);
    return NextResponse.json({ prospects });
  } catch (e: any) {
    // Local-only data source (python + prospects.db on Jack's laptop). On a
    // serverless host (Vercel) this is absent — degrade cleanly instead of 500.
    return NextResponse.json(
      { source: "local-db-unavailable", error: e.message, prospects: [] },
      { status: 200 }
    );
  }
}

export async function POST(req: Request) {
  if (isCloud()) {
    return NextResponse.json(PC_REQUIRED_BODY, { status: 503 });
  }
  // An empty or malformed body is a bad request, not a server fault. It used
  // to land in the catch below and come back as a 500 whose body was the raw
  // parser text ("Unexpected end of JSON input").
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    const { id, status, notes } = (body ?? {}) as {
      id?: unknown;
      status?: unknown;
      notes?: unknown;
    };
    if (!id || !status) {
      return NextResponse.json({ error: "id and status required" }, { status: 400 });
    }
    // `id` lands in argv[1] of call_log.py, which dispatches on that slot: the
    // literals "list", "today", "note" and "callbacks" are subcommands, not ids.
    // A non-numeric id therefore picked a subcommand instead of a prospect --
    // "note" in particular reaches add_note() and writes arbitrary text onto a
    // row while skipping the status whitelist below. Pinning id to a positive
    // integer makes every subcommand name unreachable from here.
    const pid = typeof id === "number" ? id : Number(String(id).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return NextResponse.json({ error: "id must be a positive integer" }, { status: 400 });
    }
    // Mirrors VALID in call_log.py. The script prints its own rejection and
    // still exits 0, so without this check a rejected write came back as
    // 200 {"ok":true} and the board optimistically repainted a row for a call
    // that was never logged.
    if (typeof status !== "string" || !VALID_STATUS.has(status)) {
      return NextResponse.json(
        { error: `status must be one of: ${[...VALID_STATUS].sort().join(", ")}` },
        { status: 400 }
      );
    }
    if (notes !== undefined && notes !== null && typeof notes !== "string") {
      return NextResponse.json({ error: "notes must be a string" }, { status: 400 });
    }
    const args = ["call_log.py", String(pid), status];
    if (notes) args.push(notes);
    const { stdout } = await execFileAsync("python", args, { cwd: GHL_CLI });
    const message = stdout.trim();
    // call_log.py exits 0 even when it wrote nothing: log_call() returns early
    // and prints "No prospect with id N". The board treated that 200 as a win
    // and repainted the row for a call that was never logged.
    // Deliberately matched on the known FAILURE marker rather than on the
    // success format: this route writes to the live prospect DB, and keying off
    // success would turn any unanticipated stdout into a 404 on a write that
    // actually landed. Fail-safe direction -- only the proven miss is rejected.
    if (message.startsWith(`No prospect with id ${pid}`)) {
      return NextResponse.json({ ok: false, error: message }, { status: 404 });
    }
    await execFileAsync("python", ["generate_call_sheet.py"], { cwd: GHL_CLI });
    return NextResponse.json({ ok: true, message });
  } catch (e: any) {
    // e.message here is the child process failure, which carries the full
    // Python traceback including absolute paths under C:\Users. Log it, do not
    // ship it to the client.
    console.error("[api/prospects] call_log failed:", e?.message ?? e);
    return NextResponse.json({ error: "could not log the call" }, { status: 500 });
  }
}
