import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// Reads the live Windows Task Scheduler state for the Wing Digital agents so the
// Command Center can show whether they are actually running, crashing, or never fired.
// LastTaskResult 0 = ok, nonzero = crashed. State "Running"/"Ready"/"Queued".
export async function GET() {
  // NOTE: for a task that has never run, Windows returns a sentinel LastRunTime of
  // 1999-11-30 (NOT null) together with result 0x41303 (SCHED_S_TASK_HAS_NOT_RUN_YET),
  // so we must null out any pre-2000 date here or the API will misread "never ran" as a crash.
  const ps = `Get-ScheduledTask -TaskName 'WingDigital-Agent-*' | ForEach-Object {
    $i = $_ | Get-ScheduledTaskInfo
    $lr = $i.LastRunTime
    $hasRun = ($lr -ne $null -and $lr.Year -ge 2000)
    [PSCustomObject]@{
      name    = $_.TaskName -replace 'WingDigital-Agent-',''
      state   = "$($_.State)"
      lastRun = if ($hasRun) { $lr.ToString('o') } else { $null }
      result  = $i.LastTaskResult
      nextRun = if ($i.NextRunTime) { $i.NextRunTime.ToString('o') } else { $null }
      onBatteryBlocked = $_.Settings.DisallowStartIfOnBatteries
    }
  } | ConvertTo-Json -Compress`;

  try {
    // -EncodedCommand avoids cmd/PowerShell quoting issues (the inline "$($_.State)"
    // double quotes broke -Command "..." and made the scheduler read fail).
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    const { stdout } = await execAsync(
      `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { timeout: 15000, windowsHide: true }
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    const agents = Array.isArray(parsed) ? parsed : [parsed];
    // Windows Task Scheduler status codes that are NOT failures. A scheduled task
    // that simply hasn't reached its trigger yet reports 0x41303, which is normal.
    const NON_FAILURE = new Set<number>([
      0x0, // ERROR_SUCCESS
      0x41300, // SCHED_S_TASK_READY
      0x41301, // SCHED_S_TASK_RUNNING
      0x41302, // SCHED_S_TASK_DISABLED (registered but off)
      0x41303, // SCHED_S_TASK_HAS_NOT_RUN_YET  <-- the one that was faking crashes
      0x41306, // SCHED_S_TASK_TERMINATED (user/time-limit stop, not an agent crash)
    ]);
    // classify health:
    //   idle    = never ran (or hasn't hit its trigger yet)
    //   ok      = last run finished cleanly / is running / is a benign scheduler state
    //   crashed = last run exited with a genuine nonzero failure code
    for (const a of agents) {
      a.lastResultHex = "0x" + ((a.result >>> 0).toString(16).toUpperCase());
      if (a.lastRun == null) {
        a.health = "idle";
      } else if (a.result === 0 || NON_FAILURE.has(a.result)) {
        a.health = "ok";
      } else {
        a.health = "crashed";
      }
    }
    return NextResponse.json({ agents });
  } catch (e: any) {
    return NextResponse.json({ agents: [], error: e.message ?? "scheduler read failed" });
  }
}
