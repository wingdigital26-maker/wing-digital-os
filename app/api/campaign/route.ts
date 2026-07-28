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
    const snap = await readVaultFile("wiki/state/cloud/campaign.json");
    if (snap) {
      try {
        return NextResponse.json(JSON.parse(snap));
      } catch {
        /* fall through */
      }
    }
    return NextResponse.json({ ...PC_REQUIRED_BODY, cities: [], prospects: [] });
  }
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
