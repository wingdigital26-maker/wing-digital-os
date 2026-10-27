// The daily client check: the latest sentinel health page per client, flagged
// when missing or more than 36 hours old. Server-only.
import { loadClients, type ClientRow } from "./clients";
import { withStore } from "./db";
import { sentinelLastRun, STALE_HOURS } from "./vault";

export type CheckRow = {
  slug: string;
  name: string;
  color: ClientRow["health"];
  checkedAt: string | null;
  missing: boolean;
  stale: boolean;
  reds: string[];
  yellows: string[];
  published: string | null;
  vaultPath: string | null;
};

export async function currentChecks(): Promise<{ rows: CheckRow[]; sentinel: string | null; errors: string[] }> {
  const [{ clients, errors }, sentinel] = await Promise.all([loadClients(), sentinelLastRun()]);
  const rows = clients.map((c) => ({
    slug: c.slug,
    name: c.name,
    color: c.health,
    checkedAt: c.checkedAt,
    missing: !c.healthPage,
    stale: c.stale,
    reds: c.healthPage?.reds ?? [],
    yellows: c.healthPage?.yellows ?? [],
    published: c.healthPage?.published ?? null,
    vaultPath: c.healthPage?.path ?? null,
  }));
  return { rows, sentinel, errors };
}

/** Save today's snapshot (one row per client per sentinel run) for the history view. */
export async function recordChecks(rows: CheckRow[]) {
  return withStore(async (sql) => {
    let added = 0;
    for (const r of rows) {
      const summary = r.reds[0] ?? r.yellows[0] ?? null;
      const res = await sql`
        insert into cc_checks (client_slug, color, checked_at, stale, summary)
        select ${r.slug}, ${r.missing ? "unknown" : r.color}, ${r.checkedAt}, ${r.stale}, ${summary}
         where not exists (
           select 1 from cc_checks where client_slug = ${r.slug}
              and checked_at is not distinct from ${r.checkedAt}::timestamptz
              and recorded_at > now() - interval '20 hours')`;
      added += res.count;
    }
    return added;
  });
}

export function problemLines(rows: CheckRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.missing) out.push(`${r.name}: no automated check on file`);
    else if (r.stale) out.push(`${r.name}: last check is over ${STALE_HOURS}h old`);
    else if (r.color === "red") out.push(`${r.name}: red. ${r.reds[0]?.slice(0, 120) ?? ""}`.trim());
  }
  return out;
}
