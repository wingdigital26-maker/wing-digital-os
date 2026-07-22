import { NextResponse } from "next/server";
import { readFile } from "fs/promises";

const BRIEF = "C:\\Users\\wjack\\ghl-cli\\agent_runs\\dispatch_brief.json";

export async function GET() {
  try {
    const brief = JSON.parse(await readFile(BRIEF, "utf-8"));
    return NextResponse.json({ brief });
  } catch {
    return NextResponse.json({ brief: null });
  }
}
