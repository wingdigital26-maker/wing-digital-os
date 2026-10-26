// One merged client roster for the Command Center. Server-only.
//
//   vault (wiki/clients)       who the active Wing clients are, money basis, site
//   sentinel health pages      green / yellow / red and when it was last checked
//   Roof Command (read-only)   which roofers are on Roof Command, and their plan
//   cc_client_meta             what the team adds: plan, MRR, CRM link, next action
//   cc_billing                 paid / due / late (manual now, Stripe later)
//   cc_problems, cc_roofer_touches   at-risk and overdue signals
import { getRoofOverview } from "../roofCommand";
import { withStore } from "./db";
import { healthPages, isStale, slugify, vaultClients, type Health, type HealthPage } from "./vault";
import { dayCT, daysBetween } from "./time";

export type Billing = { status: "paid" | "due" | "late"; amount: number | null; due_date: string | null; note: string | null; updated_at: string };

export type ClientRow = {
  slug: string;
  name: string;
  from: string[]; // "vault" | "roof-command" | "team"
  industry: string | null;
  location: string | null;
  isRoofer: boolean;
  onRoofCommand: boolean;
  rcPlan: string | null;
  health: Health;
  healthPage: HealthPage | null;
  checkedAt: string | null;
  stale: boolean;
  plan: string | null;
  mrr: number | null;
  mrrNote: string | null;
  crmUrl: string | null;
  nextAction: string | null;
  liveSite: string | null;
  contactName: string | null;
  contactPhone: string | null;
  billing: Billing | null;
  openProblems: number;
  oldestOpenDays: number | null;
  lastTouch: { at: string; mood: string; by: string } | null;
  touchOverdue: boolean;
  atRisk: string[];
};

type Meta = {
  slug: string; display_name: string | null; plan: string | null; mrr: string | null; crm_url: string | null;
  next_action: string | null; is_roofer: boolean | null; roofer_contact: string | null; roofer_phone: string | null; active: boolean;
};

export const TOUCH_EVERY_DAYS = 7;
export const QUIET_DAYS = 14;
export const PROBLEM_RISK_DAYS = 7;

export async function loadClients(): Promise<{ clients: ClientRow[]; errors: string[] }> {
  const errors: string[] = [];
  const [vault, health, rc, store] = await Promise.all([
    vaultClients(),
    healthPages(),
    getRoofOverview().catch(() => ({ connected: false as const })),
    withStore(async (sql) => {
      const [meta, billing, problems, touches] = await Promise.all([
        sql<Meta[]>`select * from cc_client_meta`,
        sql<(Billing & { client_key: string })[]>`select client_key, status, amount::float as amount, due_date::text, note, updated_at from cc_billing`,
        sql<{ client_slug: string; n: number; oldest: string }[]>`
          select client_slug, count(*)::int as n, min(created_at)::text as oldest
            from cc_problems where status <> 'fixed' and client_slug is not null group by client_slug`,
        sql<{ client_slug: string; created_at: string; mood: string; by_user: string }[]>`
          select distinct on (client_slug) client_slug, created_at::text, mood, by_user
            from cc_roofer_touches order by client_slug, created_at desc`,
      ]);
      return { meta, billing, problems, touches };
    }),
  ]);
  if (vault.error) errors.push(vault.error);
  if (!store.ok) errors.push(store.reason);
  if (rc.connected && !rc.ok) errors.push(`Roof Command could not be read: ${rc.error}`);

  const meta = new Map((store.ok ? store.data.meta : []).map((m) => [m.slug, m]));
  const billing = new Map((store.ok ? store.data.billing : []).map((b) => [b.client_key, b]));
  const problems = new Map((store.ok ? store.data.problems : []).map((p) => [p.client_slug, p]));
  const touches = new Map((store.ok ? store.data.touches : []).map((t) => [t.client_slug, t]));

  const rows = new Map<string, ClientRow>();
  const blank = (slug: string, name: string): ClientRow => ({
    slug, name, from: [], industry: null, location: null, isRoofer: false, onRoofCommand: false, rcPlan: null,
    health: "unknown", healthPage: null, checkedAt: null, stale: true, plan: null, mrr: null, mrrNote: null,
    crmUrl: null, nextAction: null, liveSite: null, contactName: null, contactPhone: null, billing: null,
    openProblems: 0, oldestOpenDays: null, lastTouch: null, touchOverdue: false, atRisk: [],
  });

  for (const v of vault.clients) {
    const r = blank(v.slug, v.name);
    r.from.push("vault");
    Object.assign(r, {
      industry: v.industry, location: v.location, isRoofer: v.isRoofer, liveSite: v.liveSite,
      contactName: v.contactName, contactPhone: v.contactPhone,
    });
    if (v.revenueAmount != null) {
      const recurring = v.revenueBasis === "monthly" || v.revenueBasis === "term";
      r.mrr = recurring ? v.revenueAmount : null;
      r.mrrNote = recurring ? `${v.revenueBasis} (vault)` : `$${v.revenueAmount} ${v.revenueBasis ?? "basis unconfirmed"}, not counted as MRR`;
    }
    rows.set(v.slug, r);
  }

  if (rc.connected && rc.ok) {
    for (const c of rc.clients) {
      if (c.isTest) continue;
      const s = slugify(c.name);
      const hit = [...rows.values()].find((r) => r.slug === s || slugify(r.name) === s);
      const r = hit ?? blank(`rc-${s}`, c.name);
      if (!hit) rows.set(r.slug, r);
      r.from.push("roof-command");
      r.onRoofCommand = true;
      r.isRoofer = true;
      r.rcPlan = c.plan;
    }
  }

  for (const m of meta.values()) {
    if (!rows.has(m.slug) && m.active) {
      const r = blank(m.slug, m.display_name || m.slug);
      r.from.push("team");
      rows.set(m.slug, r);
    }
  }

  const today = dayCT();
  const now = Date.now();
  for (const r of rows.values()) {
    const m = meta.get(r.slug);
    if (m && !m.active) {
      rows.delete(r.slug);
      continue;
    }
    if (m) {
      if (m.display_name) r.name = m.display_name;
      r.plan = m.plan ?? r.rcPlan;
      if (m.mrr != null) {
        r.mrr = Number(m.mrr);
        r.mrrNote = "set by the team";
      }
      r.crmUrl = m.crm_url;
      r.nextAction = m.next_action;
      if (m.is_roofer != null) r.isRoofer = m.is_roofer;
      if (m.roofer_contact) r.contactName = m.roofer_contact;
      if (m.roofer_phone) r.contactPhone = m.roofer_phone;
    } else {
      r.plan = r.rcPlan;
    }
    const h = health.get(r.slug);
    if (h) {
      r.healthPage = h;
      r.health = h.color;
      r.checkedAt = h.checkedAt;
    }
    r.stale = isStale(r.checkedAt, now);
    r.billing = billing.get(r.slug) ?? null;
    const p = problems.get(r.slug);
    if (p) {
      r.openProblems = p.n;
      r.oldestOpenDays = Math.floor((now - Date.parse(p.oldest)) / 86400_000);
    }
    const t = touches.get(r.slug);
    if (t) r.lastTouch = { at: t.created_at, mood: t.mood, by: t.by_user };

    if (r.isRoofer) {
      const since = r.lastTouch ? daysBetween(dayCT(r.lastTouch.at), today) : null;
      r.touchOverdue = since == null || since >= TOUCH_EVERY_DAYS;
      if (since != null && since >= QUIET_DAYS) r.atRisk.push(`No check-in for ${since} days`);
      if (r.lastTouch?.mood === "unhappy") r.atRisk.push("Unhappy at the last check-in");
    }
    if (r.oldestOpenDays != null && r.oldestOpenDays > PROBLEM_RISK_DAYS) {
      r.atRisk.push(`A problem has been open ${r.oldestOpenDays} days`);
    }
    if (r.billing?.status === "late") r.atRisk.push("Payment is late");
  }

  const order: Record<Health, number> = { red: 0, yellow: 1, unknown: 2, green: 3 };
  const clients = [...rows.values()].sort(
    (a, b) => b.atRisk.length - a.atRisk.length || order[a.health] - order[b.health] || a.name.localeCompare(b.name)
  );
  return { clients, errors };
}
