import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { isCloud, PC_REQUIRED_BODY } from "@/lib/runtime";
import { readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const GHL_CLI = "C:\\Users\\wjack\\ghl-cli";

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
    // Stringified at the boundary: these become argv for a child process, and
    // execFile rejects a non-string arg with a TypeError that surfaced as a 500.
    const args = ["call_log.py", String(id), String(status)];
    if (notes) args.push(String(notes));
    const { stdout } = await execFileAsync("python", args, { cwd: GHL_CLI });
    await execFileAsync("python", ["generate_call_sheet.py"], { cwd: GHL_CLI });
    return NextResponse.json({ ok: true, message: stdout.trim() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
