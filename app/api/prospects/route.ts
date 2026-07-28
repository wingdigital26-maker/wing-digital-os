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
  try {
    const { id, status, notes } = await req.json();
    if (!id || !status) {
      return NextResponse.json({ error: "id and status required" }, { status: 400 });
    }
    const args = ["call_log.py", String(id), status];
    if (notes) args.push(notes);
    const { stdout } = await execFileAsync("python", args, { cwd: GHL_CLI });
    await execFileAsync("python", ["generate_call_sheet.py"], { cwd: GHL_CLI });
    return NextResponse.json({ ok: true, message: stdout.trim() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
