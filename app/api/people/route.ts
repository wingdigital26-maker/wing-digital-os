import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { isCloud, PC_REQUIRED_BODY } from "@/lib/runtime";
import { readVaultFile } from "@/lib/vaultSource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const GHL_CLI = "C:/Users/wjack/ghl-cli";

// Resolve the interpreter instead of trusting PATH. A thin PATH (a service
// account, a sandboxed shell, a task launched without the user profile) makes
// a bare "python" fail with ENOENT, which reads as "the database is empty"
// unless the route is explicit about it. Try PATH first, then the installs
// that are actually on this machine.
const PYTHON_CANDIDATES = [
  process.env.OS_PYTHON,
  "python",
  "C:/Python314/python.exe",
  "C:/Python313/python.exe",
  "C:/Python312/python.exe",
].filter(Boolean) as string[];

async function runPython(args: string[]) {
  let last: unknown = null;
  for (const exe of PYTHON_CANDIDATES) {
    try {
      return await execFileAsync(exe, args, { cwd: GHL_CLI, maxBuffer: 20 * 1024 * 1024 });
    } catch (e: any) {
      last = e;
      // Only keep hunting when the interpreter itself was missing. A script
      // that ran and failed is a real error and must surface as one.
      if (e?.code !== "ENOENT") throw e;
    }
  }
  throw last;
}

// CRM > People (2026-09-22). The email half of the book: every prospect that
// has an address, ordered by how good that address is. Same shape local and
// cloud so the board never branches on where it is running.
//
// Mirrors /api/prospects: python + prospects.db on Jack's PC, a vault snapshot
// in the cloud, and an honest "not reachable" body if neither answers. It never
// returns a bare empty list as if that were the truth.
export async function GET(req: Request) {
  const limit = Number(new URL(req.url).searchParams.get("limit")) || 3000;

  if (isCloud()) {
    const snap = await readVaultFile("wiki/state/cloud/people.json");
    if (snap) {
      try {
        return NextResponse.json(JSON.parse(snap));
      } catch {
        /* fall through to the PC-required body */
      }
    }
    return NextResponse.json({ ...PC_REQUIRED_BODY, people: [], total: null });
  }

  try {
    const { stdout } = await runPython(["dump_people_json.py", String(limit)]);
    return NextResponse.json(JSON.parse(stdout));
  } catch (e: any) {
    // The list is local-only. Say so rather than serving [] as a fact -- an
    // empty book and an unreachable database must never look identical.
    return NextResponse.json(
      {
        source: "local-db-unavailable",
        error: e?.message ?? "prospects.db did not answer",
        people: [],
        total: null,
      },
      { status: 200 }
    );
  }
}
