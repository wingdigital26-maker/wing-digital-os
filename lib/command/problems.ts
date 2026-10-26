// Problems: anyone reports one, the whole team gets a text. Server-only.
import { withStore, type StoreResult } from "./db";
import { notifyTeam, type NotifyResult } from "./notify";
import { personName } from "./team";

export type Problem = {
  id: number;
  client_slug: string | null;
  reported_by: string;
  urgency: "low" | "normal" | "urgent";
  body: string;
  has_screenshot: boolean;
  status: "open" | "working" | "fixed";
  owner: string | null;
  source: string;
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  comments?: number;
};

export const MAX_SCREENSHOT_BYTES = 1_500_000;

export function validScreenshot(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (!/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v)) return null;
  return v.length <= MAX_SCREENSHOT_BYTES * 1.37 ? v : null;
}

export async function createProblem(p: {
  client_slug: string | null;
  client_name?: string | null;
  reported_by: string;
  urgency: "low" | "normal" | "urgent";
  body: string;
  screenshot?: string | null;
  source?: string;
  baseUrl?: string;
}): Promise<StoreResult<{ id: number; notify: NotifyResult }>> {
  const saved = await withStore(async (sql) => {
    const [row] = await sql<{ id: number }[]>`
      insert into cc_problems (client_slug, reported_by, urgency, body, screenshot, source)
      values (${p.client_slug}, ${p.reported_by}, ${p.urgency}, ${p.body}, ${p.screenshot ?? null}, ${p.source ?? "manual"})
      returning id`;
    return row.id;
  });
  if (!saved.ok) return saved;
  const who = personName(p.reported_by);
  const where = p.client_name || p.client_slug || "Wing";
  const link = p.baseUrl ? `\n${p.baseUrl}/command/problems#p${saved.data}` : "";
  const notify = await notifyTeam(
    "problem",
    `${p.urgency === "urgent" ? "URGENT problem" : "New problem"}: ${where}`,
    `${who}: ${p.body.slice(0, 300)}${link}`,
    { urgent: p.urgency === "urgent" }
  );
  return { ok: true, data: { id: saved.data, notify } };
}

export async function listProblems(): Promise<StoreResult<Problem[]>> {
  return withStore((sql) =>
    sql<Problem[]>`
      select p.id::int, p.client_slug, p.reported_by, p.urgency, p.body, (p.screenshot is not null) as has_screenshot,
             p.status, p.owner, p.source, p.created_at::text, p.updated_at::text, p.fixed_at::text,
             (select count(*)::int from cc_problem_comments c where c.problem_id = p.id) as comments
        from cc_problems p
       order by (p.status = 'fixed'), (p.urgency = 'urgent') desc, p.created_at desc
       limit 300`
  );
}

/** The morning digest text: every open problem, oldest first. */
export async function digestText(): Promise<StoreResult<{ text: string; open: number }>> {
  return withStore(async (sql) => {
    const rows = await sql<{ id: number; client_slug: string | null; body: string; status: string; owner: string | null; urgency: string; days: number }[]>`
      select id::int, client_slug, body, status, owner, urgency,
             floor(extract(epoch from now() - created_at) / 86400)::int as days
        from cc_problems where status <> 'fixed' order by created_at asc limit 20`;
    if (!rows.length) return { text: "No open problems. Good morning.", open: 0 };
    const lines = rows.map(
      (r) =>
        `#${r.id} ${r.client_slug ?? "Wing"}${r.urgency === "urgent" ? " (urgent)" : ""}: ${r.body.slice(0, 80)} [${r.status}, ${
          r.owner ? personName(r.owner) : "no owner"
        }, ${r.days}d]`
    );
    return { text: `${rows.length} open problem${rows.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, open: rows.length };
  });
}
