import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GHL_CLI = "C:\\Users\\wjack\\ghl-cli";

export async function GET() {
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
