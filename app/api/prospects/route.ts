import { NextResponse } from "next/server";
import { isCloud, PC_REQUIRED_BODY } from "@/lib/runtime";
import { readVaultFile } from "@/lib/vaultSource";
import { runPython } from "@/lib/python";

export const runtime = "nodejs";

const GHL_CLI = "C:/Users/wjack/ghl-cli";

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
    const { stdout } = await runPython(["dump_prospects_json.py"], { cwd: GHL_CLI });
    const prospects = JSON.parse(stdout);
    return NextResponse.json({ prospects });
  } catch (e: any) {
    // This used to answer 200 with an empty list, so "the database could not be
    // opened" and "there are no prospects" arrived at the UI looking the same.
    // A source that could not be read is a 503 with the reason on it.
    return NextResponse.json(
      {
        source: "local-db-unavailable",
        error: `prospects.db could not be read on this machine: ${e?.message ?? String(e)}`,
        prospects: [],
      },
      { status: 503 }
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
    const { stdout } = await runPython(args, { cwd: GHL_CLI });
    await runPython(["generate_call_sheet.py"], { cwd: GHL_CLI });
    return NextResponse.json({ ok: true, message: stdout.trim() });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
