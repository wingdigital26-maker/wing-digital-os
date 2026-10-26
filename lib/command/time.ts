// Dates for the Command Center. The team works in Dallas time, so "today",
// "this week" and "overdue" are all Central, never UTC. Client-safe.

export const TZ = "America/Chicago";

/** YYYY-MM-DD for a moment, in Central time. */
export function dayCT(d: Date | number | string = new Date()): string {
  const x = new Date(d);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(x);
}

/** Monday (YYYY-MM-DD) of the Central-time week holding `day`. */
export function weekStart(day = dayCT()): string {
  const d = new Date(`${day}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function monthStart(day = dayCT()): string {
  return `${day.slice(0, 7)}-01`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400_000);
}

export function fmtDay(day: string | null | undefined): string {
  if (!day) return "Not set";
  return new Date(`${day.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", timeZone: "UTC",
  });
}

export function fmtWhen(iso: string | Date | null | undefined): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ,
  });
}

/** "3h ago", "2 days ago". */
export function ago(iso: string | Date | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const ms = now - new Date(iso).getTime();
  const h = Math.floor(ms / 3600_000);
  if (h < 1) return "just now";
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

export function money(n: number | string | null | undefined): string {
  if (n == null || n === "") return "Not recorded";
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "Not recorded";
}
