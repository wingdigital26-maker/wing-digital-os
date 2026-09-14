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

// The only two resolutions this endpoint may write. Anything else used to be
// stored verbatim into item.status, and since GET only returns items whose
// status is "open", a typo'd or hostile value silently buried the item with no
// way to get it back from the UI.
const RESOLUTIONS = new Set(["approved", "dismissed"]);

export async function POST(req: Request) {
  // Resolve a Needs Jack item: { id, resolution: "approved" | "dismissed" }
  // Bad input answers 400. A 500 here used to mean "you sent an empty body",
  // and it echoed the raw exception text (including the absolute queue-file
  // path on ENOENT) straight back to the caller.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, resolution } = (body ?? {}) as { id?: unknown; resolution?: unknown };
  if (id === undefined || id === null || id === "") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  if (typeof resolution !== "string" || !RESOLUTIONS.has(resolution)) {
    return NextResponse.json(
      { error: `resolution must be one of: ${[...RESOLUTIONS].join(", ")}` },
      { status: 400 }
    );
  }

  let queue: any[];
  try {
    queue = JSON.parse(await readFile(QUEUE_FILE, "utf-8"));
  } catch {
    // No queue file (or unreadable/corrupt) is a host condition, not a bad
    // request. Say so honestly instead of leaking the path in a 500.
    return NextResponse.json(
      { error: "the Needs Jack queue is not readable on this host" },
      { status: 503 }
    );
  }
  if (!Array.isArray(queue)) {
    return NextResponse.json(
      { error: "the Needs Jack queue is not readable on this host" },
      { status: 503 }
    );
  }

  const item = queue.find((q: any) => q?.id === id);
  if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
  item.status = resolution;
  item.resolved = new Date().toISOString();
  try {
    await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2), "utf-8");
  } catch {
    return NextResponse.json(
      { error: "the Needs Jack queue could not be written on this host" },
      { status: 503 }
    );
  }
  return NextResponse.json({ ok: true });
}
