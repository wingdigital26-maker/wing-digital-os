import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GHL_CLI = "C:\\Users\\wjack\\ghl-cli";

export async function GET() {
  try {
    const { stdout } = await execFileAsync(
      "python",
      ["dump_campaign_json.py"],
      { cwd: GHL_CLI, maxBuffer: 10 * 1024 * 1024 }
    );
    return NextResponse.json(JSON.parse(stdout));
  } catch (e: any) {
    // Local-only data source (python + prospects.db on Jack's laptop). On a
    // serverless host (Vercel) this is absent — degrade cleanly instead of 500.
    return NextResponse.json(
      { source: "local-db-unavailable", error: e.message, cities: [], prospects: [] },
      { status: 200 }
    );
  }
}
