import { NextResponse } from "next/server";
import { readFile, readdir, writeFile } from "fs/promises";
import path from "path";

const RUNS_DIR = "C:\\Users\\wjack\\ghl-cli\\agent_runs";
const QUEUE_FILE = path.join(RUNS_DIR, "needs_jack.json");

export async function GET() {
  let runs: any[] = [];
  let queue: any[] = [];
  try {
    const files = (await readdir(RUNS_DIR))
      .filter(f => f.endsWith(".json") && f !== "needs_jack.json")
      .sort()
      .reverse()
      .slice(0, 60);
    runs = await Promise.all(
      files.map(async f => JSON.parse(await readFile(path.join(RUNS_DIR, f), "utf-8")))
    );
  } catch { /* no runs yet */ }
  try {
    queue = JSON.parse(await readFile(QUEUE_FILE, "utf-8"));
  } catch { /* no queue yet */ }
  return NextResponse.json({ runs, queue: queue.filter((q: any) => q.status === "open") });
}

export async function POST(req: Request) {
  // Resolve a Needs Jack item: { id, resolution: "approved" | "dismissed" }
  try {
    const { id, resolution } = await req.json();
    const queue = JSON.parse(await readFile(QUEUE_FILE, "utf-8"));
    const item = queue.find((q: any) => q.id === id);
    if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
    item.status = resolution;
    item.resolved = new Date().toISOString();
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf-8");
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
