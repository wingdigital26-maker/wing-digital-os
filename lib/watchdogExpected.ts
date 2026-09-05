// The one table of agent heartbeats the cloud expects, and how long each may
// stay silent before it counts as a real problem. Shared by the cloud watchdog
// cron (app/api/cron/watchdog, which pushes to Jack's phone) and the on-demand
// Da Boss recheck (app/api/boss/recheck), so both judge the same fleet by the
// same numbers. Route files cannot export plain values in Next, which is why
// this lives in lib/ rather than next to the cron.
//
// windowed: only judged during 6am-10pm Central (the hours the PC should be up).

export interface ExpectedHeartbeat {
  agent: string;
  staleMin: number;
  windowed: boolean;
  label: string;
}

export const EXPECTED_HEARTBEATS: ExpectedHeartbeat[] = [
  { agent: "pc-alive", staleMin: 45, windowed: true, label: "PC heartbeat" },
  { agent: "watchdog-heartbeat", staleMin: 200, windowed: true, label: "Watchdog patrol" },
  { agent: "cloud-patrol", staleMin: 200, windowed: false, label: "Cloud patrol" },
  { agent: "sentinel-daily", staleMin: 26 * 60, windowed: false, label: "Sentinel daily" },
  { agent: "b2b-prospector-daily", staleMin: 26 * 60, windowed: false, label: "B2B prospector" },
  { agent: "state-sync-daily", staleMin: 26 * 60, windowed: false, label: "State sync" },
  { agent: "chronicler-end-of-day", staleMin: 26 * 60, windowed: false, label: "Chronicler" },
  { agent: "renewal-content-weekly", staleMin: 8 * 24 * 60, windowed: false, label: "Renewal content engine" },
  // Windows-scheduled Claude-CLI agents (launched via hidden_run.vbs +
  // run_claude_agent.ps1). Without these, a Task Scheduler that stops LAUNCHING
  // the task entirely posts no heartbeat and only pc-alive would notice.
  { agent: "win-dispatch", staleMin: 26 * 60, windowed: false, label: "Dispatch (Windows)" },       // daily 6:30am
  { agent: "win-prospector", staleMin: 8 * 24 * 60, windowed: false, label: "Prospector (Windows)" }, // weekly Sun 9pm
];

// Hour of day in Central time, 0-23.
export function centralHour(): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(new Date())
  );
}

// True during the hours the PC is expected to be awake.
export function inPcWindow(): boolean {
  const h = centralHour();
  return h >= 6 && h < 22;
}
