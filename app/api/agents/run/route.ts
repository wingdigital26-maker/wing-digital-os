import { NextResponse } from "next/server";
import { spawn } from "child_process";

// This route is the link between the OS "run agent" button and the real
// Wing Digital agent scripts. It runs the underlying Python for each agent
// via child_process and returns stdout/stderr + exit code.
//
// Guarded: only the 4 known keeper agents are allowed. Anything else is 400.

const GHL_CLI = "C:\\Users\\wjack\\ghl-cli";

// Map each allowed agent to the concrete command that drives it.
// outreach + chronicler have single-script entrypoints. dispatch runs its
// briefing script chain. prospector is a heavy skill-driven scan, so from the
// OS we only kick off its script-backed piece and otherwise report that it is
// skill-driven (a full run belongs in a Claude session, not a web request).
const AGENTS: Record<string, { args: string[]; env?: Record<string, string>; note?: string }> = {
  outreach: {
    // 8am-8pm window + 100/day cap are enforced inside the script itself.
    args: ["daily_outreach.py"],
  },
  chronicler: {
    args: ["chronicler.py", "--minutes", "90", "--since-watermark"],
    env: { PYTHONIOENCODING: "utf-8" },
  },
  dispatch: {
    // Regenerate data then write the briefing (the OS Command Center card reads
    // agent_runs/dispatch_brief.json which dispatch_briefing.py produces).
    args: ["dispatch_briefing.py"],
  },
  prospector: {
    // Prospector's discovery is a heavy WebSearch/BBB skill run that must happen
    // in a Claude session. From the OS we only refresh its audit PDFs from the DB.
    args: ["audit_pdf_generator.py", "--from-db"],
    note: "Prospector is skill-driven (t1-lead-find). This endpoint only refreshes audit PDFs from the DB; run the full scan from a Claude session.",
  },
};

const ALLOWED = new Set(Object.keys(AGENTS));

function runPython(args: string[], extraEnv?: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python", args, {
      cwd: GHL_CLI,
      env: { ...process.env, ...(extraEnv || {}) },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    // Safety timeout so a hung script can't wedge the request forever.
    setTimeout(() => {
      child.kill();
      resolve({ code: -2, stdout, stderr: stderr + "\n[timeout: killed after 120s]" });
    }, 120_000);
  });
}

export async function POST(req: Request) {
  let agent: string;
  let dryRun = false;
  try {
    const body = await req.json();
    agent = String(body?.agent || "").trim();
    dryRun = body?.dryRun === true;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!ALLOWED.has(agent)) {
    return NextResponse.json(
      { error: `unknown agent '${agent}'. Allowed: ${[...ALLOWED].join(", ")}` },
      { status: 400 }
    );
  }

  const cfg = AGENTS[agent];
  const args = [...cfg.args];
  // Let the caller preview without side effects for the scripts that support it.
  if (dryRun && (agent === "outreach" || agent === "chronicler")) {
    args.push("--dry-run");
  }

  const result = await runPython(args, cfg.env);

  return NextResponse.json({
    agent,
    dryRun,
    command: `python ${args.join(" ")}`,
    exitCode: result.code,
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
    note: cfg.note,
  });
}
