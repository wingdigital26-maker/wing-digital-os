// ───────────────────────────────────────────────────────────────────────────
// Triage: Nimbus looks into a problem himself before he brings it to Jack.
//
// The watch says what is wrong. This says what is ACTUALLY wrong, and fixes it
// when fixing it is safe. Jack's words: "when there is a problem I want it to
// research it and see if it can't fix it itself and then come back to me."
//
// HOW: one Claude Code run per problem, on this PC, with a scoped prompt and a
// hard rule list. It reports back as structured JSON, which is the only thing
// this module will accept as a receipt.
//
// WHAT IT MAY DO
//   Investigate freely: read files, query the databases, run read-only checks.
//   Apply a fix only when the fix is reversible and local.
//
// WHAT IT MAY NEVER DO, whatever it concludes
//   Send an email, a text or any message to a real person.
//   Arm or unpause anything that sends: unpausing the cold email sender is not
//   a config change, it is a decision to start contacting real people.
//   Spend money.
//   Delete or truncate data.
//   git push, deploy, or promote anything to production.
//   Change credentials, or touch a client's live site.
// Those are Jack's calls, not an agent's. When the right fix is one of them the
// status is needs_you and the exact command comes back for him to approve.
//
// HONESTY: "fixed" requires structured evidence of what changed. Unparseable
// output is a FAILURE, not a receipt. A timeout is a failure. Nothing here ever
// reports a success it cannot show.
// ───────────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { spawn, execFileSync } from "child_process";
import { isCloud } from "@/lib/runtime";
import { VAULT_PATH } from "@/lib/vaultSource";
import type { Check } from "@/lib/nimbusWatch";

export type TriageStep = {
  at: string;
  kind: "looked" | "ran" | "fixed" | "blocked";
  text: string;
};

export type TriageResult = {
  /** Stable for this run. */
  id: string;
  problemId: string;
  problemLabel: string;
  startedAt: string;
  finishedAt: string | null;
  status: "investigating" | "fixed" | "needs_you" | "failed";
  /** One or two plain sentences: what he actually found. */
  summary: string;
  steps: TriageStep[];
  /** The exact next action for Jack when this needs him. */
  nextStep: string | null;
  /** A command he could run, when there is one. */
  proposedCommand: string | null;
};

const MAX_MS = 300_000; // one triage never runs longer than five minutes
const MAX_CONCURRENT = 2;
const LEDGER = path.join(VAULT_PATH, "wiki", "nimbus", "triage-log.jsonl");

// Survive dev hot reloads: a triage in flight must not be forgotten mid-run.
type Store = { runs: Map<string, TriageResult>; running: Set<string> };
const g = globalThis as unknown as { __nimbusTriage?: Store };
const store: Store = (g.__nimbusTriage ??= { runs: new Map(), running: new Set() });

function nowIso() {
  return new Date().toISOString();
}

let cachedCli: string | null | undefined;
function findClaudeCli(): string | null {
  if (isCloud()) return null;
  if (cachedCli !== undefined) return cachedCli;
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    path.join(process.env.USERPROFILE ?? "C:\\Users\\wjack", ".local", "bin", "claude.exe"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return (cachedCli = c);
    } catch {
      /* keep looking */
    }
  }
  try {
    const out = execFileSync("where", ["claude"], { encoding: "utf-8", timeout: 5000 });
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l && fs.existsSync(l));
    if (first) return (cachedCli = first);
  } catch {
    /* not on PATH */
  }
  return (cachedCli = null);
}

const RULES = `You are Nimbus, triaging one problem on Jack Wing's own machine for Wing Digital.

WHAT YOU ARE DOING
Find out what is ACTUALLY wrong, and fix it if fixing it is safe. Jack should
only hear about the parts you could not settle yourself.

YOU MAY
Read anything, query the databases, run read-only commands, and apply a fix
that is reversible and local to Wing's own machine or Wing's own repos.

YOU MAY NEVER, whatever you conclude
- Send an email, a text, or any message to a real person.
- ARM OR UNPAUSE ANYTHING THAT SENDS. Setting outreach_state.paused to false,
  enabling a sequence, flipping an AUTOMATION_SEND or send-enabled flag, or
  re-arming a scheduled sender all mean real messages reach real people the
  moment you do it. That is Jack's decision every time, even when it is
  obviously the right fix. Report it as needs_you with the exact command.
- Spend money or trigger anything that costs money.
- Delete or truncate data.
- git push, deploy, or promote anything to production.
- Change credentials, or read a .env file.
- Touch a client's live site.
If the right fix is one of those, do NOT do it. Report status "needs_you" and
put the exact command or step in "proposedCommand".

HONESTY
Never claim a fix you did not make and cannot show. If you could not work it
out, say so: "needs_you" with what you learned is a good outcome. Guessing is
not. Do not invent file paths, counts or causes.

ANSWER FORMAT
Your FINAL message must be exactly one JSON object and nothing else:
{"status":"fixed"|"needs_you"|"failed",
 "summary":"one or two plain sentences about what was actually wrong",
 "steps":[{"kind":"looked"|"ran"|"fixed"|"blocked","text":"what you did"}],
 "nextStep":"the exact next action for Jack, or null",
 "proposedCommand":"a command he can run, or null",
 "evidence":"what proves the fix worked, required when status is fixed"}
No prose outside the JSON. No em dashes.`;

function promptFor(p: Check): string {
  return [
    `PROBLEM: ${p.label}`,
    `DETAIL: ${p.detail}`,
    p.fix ? `THE WATCH SUGGESTS: ${p.fix}` : "",
    "",
    "Work out whether that is really the cause. Fix it if it is safe under your rules.",
    "Then answer with the JSON object and nothing else.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pull the final JSON object out of the CLI's output. No object means no receipt. */
function parseVerdict(text: string): Record<string, unknown> | null {
  const start = text.lastIndexOf("{");
  if (start < 0) return null;
  // Walk back through candidate objects: the last complete one wins.
  for (let i = start; i >= 0; i = text.lastIndexOf("{", i - 1)) {
    const slice = text.slice(i);
    try {
      const parsed = JSON.parse(slice.slice(0, slice.lastIndexOf("}") + 1));
      if (parsed && typeof parsed === "object" && "status" in parsed) return parsed as Record<string, unknown>;
    } catch {
      /* try an earlier brace */
    }
    if (i === 0) break;
  }
  return null;
}

function appendLedger(r: TriageResult) {
  try {
    fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(r) + "\n", "utf-8");
  } catch {
    /* the ledger is a record, not a dependency */
  }
}

function finish(r: TriageResult, patch: Partial<TriageResult>) {
  Object.assign(r, patch, { finishedAt: nowIso() });
  store.running.delete(r.problemId);
  appendLedger(r);
}

/**
 * Start looking into one problem. Returns immediately with status
 * "investigating"; poll getTriage(problemId) for the outcome.
 */
export async function startTriage(problem: Check): Promise<TriageResult> {
  const existing = store.runs.get(problem.id);
  if (existing && existing.status === "investigating") return existing;

  const result: TriageResult = {
    id: `${problem.id}:${Date.now()}`,
    problemId: problem.id,
    problemLabel: problem.label,
    startedAt: nowIso(),
    finishedAt: null,
    status: "investigating",
    summary: "Looking into it.",
    steps: [],
    nextStep: null,
    proposedCommand: null,
  };
  store.runs.set(problem.id, result);

  if (isCloud()) {
    finish(result, {
      status: "failed",
      summary: "Triage needs Jack's PC. This is the cloud copy of the OS, so there is no agent here to investigate with.",
      nextStep: "Open the Nimbus window on the PC and try again there.",
    });
    return result;
  }
  if (store.running.size >= MAX_CONCURRENT) {
    finish(result, {
      status: "failed",
      summary: `Already looking into ${store.running.size} other problems. Try this one when those finish.`,
    });
    return result;
  }
  const cli = findClaudeCli();
  if (!cli) {
    finish(result, {
      status: "failed",
      summary: "I could not start the Claude Code CLI on this PC, so I could not investigate.",
      nextStep: "Check that claude is installed and on PATH, or set CLAUDE_CLI_PATH.",
    });
    return result;
  }

  store.running.add(problem.id);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    RULES,
    promptFor(problem),
  ];

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(cli, args, { cwd: VAULT_PATH, windowsHide: true, env: process.env });
  } catch (e) {
    finish(result, {
      status: "failed",
      summary: `The investigation could not start: ${e instanceof Error ? e.message : String(e)}`,
    });
    return result;
  }

  let out = "";
  let buffer = "";
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    if (result.status === "investigating") {
      finish(result, {
        status: "failed",
        summary: "I ran out of time looking into this one, so I stopped rather than leave it running.",
        nextStep: problem.fix ?? null,
      });
    }
  }, MAX_MS);

  child.stdout?.on("data", (d: Buffer) => {
    buffer += d.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as Record<string, unknown>;
        // Record the tools it used, so Jack can see the work rather than a verdict.
        if (ev.type === "assistant") {
          const msg = ev.message as { content?: { type: string; name?: string; text?: string }[] } | undefined;
          for (const block of msg?.content ?? []) {
            if (block.type === "tool_use" && block.name) {
              result.steps.push({ at: nowIso(), kind: block.name === "Bash" ? "ran" : "looked", text: String(block.name) });
            }
          }
        }
        if (ev.type === "result" && typeof ev.result === "string") out += ev.result;
      } catch {
        /* not a JSON line: ignore, the verdict comes from the result event */
      }
    }
  });

  child.on("close", () => {
    clearTimeout(timer);
    if (result.status !== "investigating") return;
    const verdict = parseVerdict(out);
    if (!verdict) {
      // No structured answer means no receipt. This is a failure, never a fix.
      finish(result, {
        status: "failed",
        summary: "I looked into it but did not get a clear answer back, so I am not going to claim anything.",
        nextStep: problem.fix ?? null,
      });
      return;
    }
    const status = String(verdict.status);
    const evidence = typeof verdict.evidence === "string" ? verdict.evidence.trim() : "";
    const steps = Array.isArray(verdict.steps)
      ? (verdict.steps as { kind?: string; text?: string }[])
          .filter((s) => s && typeof s.text === "string")
          .map((s) => ({
            at: nowIso(),
            kind: (["looked", "ran", "fixed", "blocked"].includes(String(s.kind)) ? s.kind : "looked") as TriageStep["kind"],
            text: String(s.text).slice(0, 300),
          }))
      : [];
    // A claimed fix with no evidence is downgraded, not trusted.
    const claimedFix = status === "fixed";
    const proven = claimedFix && evidence.length > 0;
    finish(result, {
      status: proven ? "fixed" : claimedFix ? "needs_you" : status === "needs_you" ? "needs_you" : "failed",
      summary:
        (typeof verdict.summary === "string" && verdict.summary.trim()
          ? verdict.summary.trim()
          : "No summary came back.") +
        (claimedFix && !proven ? " I could not show evidence that the fix worked, so this still needs your eyes." : ""),
      steps: steps.length ? steps : result.steps,
      nextStep: typeof verdict.nextStep === "string" ? verdict.nextStep : problem.fix ?? null,
      proposedCommand: typeof verdict.proposedCommand === "string" ? verdict.proposedCommand : null,
    });
  });

  return result;
}

export function getTriage(problemId: string): TriageResult | null {
  return store.runs.get(problemId) ?? null;
}

export function listTriage(): TriageResult[] {
  return [...store.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
