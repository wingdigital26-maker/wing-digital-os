import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const RUNS_DIR = "C:\\Users\\wjack\\ghl-cli\\agent_runs";

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, file), "utf-8"));
  } catch {
    return null;
  }
}

export async function GET() {
  const ledger = readJson("trust_ledger.json") ?? {};
  const budget = readJson("budget.json") ?? {};

  const WINDOW = 20;
  const tasks = Object.values(ledger).map((e: any) => {
    const last = (e.outcomes ?? []).slice(-WINDOW);
    const passes = last.filter((o: any) => o.r === "pass").length;
    return {
      agent: e.agent,
      task: e.task,
      state: e.state,
      runs: (e.outcomes ?? []).length,
      windowSize: last.length,
      passRate: last.length ? passes / last.length : 0,
      consecFails: e.consec_fails ?? 0,
      lastOutcome: (e.outcomes ?? []).slice(-1)[0] ?? null,
    };
  });

  return NextResponse.json({
    tasks,
    budget: {
      day: budget.day ?? null,
      cost: budget.cost ?? 0,
      runs: budget.runs ?? {},
      totalRuns: Object.values(budget.runs ?? {}).reduce(
        (s: number, n: any) => s + n,
        0
      ),
      limits: budget.limits ?? {
        max_runs_per_agent: 10,
        max_runs_total: 40,
        max_cost_total: 15,
      },
      denials: budget.denials ?? [],
    },
  });
}
