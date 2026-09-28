// Where the outreach queue and its events live.
//
// PRODUCTION: Postgres over OS_DB_URL (the Supabase transaction pooler), the
// same path the Call Room fell back to when Supabase REST started answering
// 402 on 2026-09-21. Tables are created on first use from lib/outreach/schema.ts
// (identical to supabase/migrations/0040_outreach_queue.sql, test-enforced),
// so nothing depends on REST.
//
// LOCAL DEV WITHOUT OS_DB_URL: a JSON file in the OS temp dir, so /outreach can
// be exercised with sample data on a laptop. A production build never uses it:
// with no OS_DB_URL, production gets `null` and every route says so plainly.
//
// Every write that a person makes (edit, approve, reject, request push) is
// refused unless the draft is in a state where that makes sense, and the
// refusal comes back as an OutreachStoreError with words the UI can show.
import postgres from "postgres";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeStop, stepsDiffer } from "./mappers";
import { OUTREACH_DDL } from "./schema";
import type {
  ApprovalStatus,
  DraftInput,
  DraftRow,
  DraftStep,
  LeadRow,
  LeadStateInput,
  MailboxState,
  OutreachEventInput,
  OutreachEventRow,
  StopReason,
  SuppressionInput,
} from "./types";

export class OutreachStoreError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "OutreachStoreError";
    this.status = status;
  }
}

export type UpsertSummary = { inserted: number; updated: number };
export type EventSummary = { inserted: number; skipped: number; stopsApplied: number };

export interface OutreachStore {
  kind: "postgres" | "dev-file";
  upsertDrafts(drafts: DraftInput[]): Promise<UpsertSummary>;
  listDrafts(q: { batchDate?: string | null; tenant?: string | null }): Promise<DraftRow[]>;
  batchDates(limit?: number): Promise<{ date: string; count: number }[]>;
  getDraft(id: number): Promise<DraftRow | null>;
  editDraft(id: number, steps: DraftStep[], actor: string): Promise<DraftRow>;
  setApproval(id: number, status: ApprovalStatus, actor: string, reason?: string | null): Promise<DraftRow>;
  approveAllPassed(batchDate: string, tenant: string | null, actor: string): Promise<number>;
  requestPush(actor: string, tenant: string | null): Promise<number>;
  listApproved(tenant: string | null, onlyPushRequested: boolean): Promise<DraftRow[]>;
  insertEvents(events: OutreachEventInput[]): Promise<EventSummary>;
  listEvents(sinceIso: string): Promise<OutreachEventRow[]>;
  listReplies(limit: number): Promise<OutreachEventRow[]>;
  listLeads(): Promise<LeadRow[]>;
  sendTimes(sinceIso: string): Promise<Map<string, number[]>>;
  applySuppression(rows: SuppressionInput[]): Promise<number>;
  upsertLeadStates(rows: LeadStateInput[]): Promise<number>;
  upsertMailboxStates(states: Omit<MailboxState, "updatedAt">[]): Promise<number>;
  listMailboxStates(): Promise<MailboxState[]>;
  getState<T>(key: string): Promise<T | null>;
  setState(key: string, value: unknown): Promise<void>;
}

const REPLY_COLLAPSE_MS = 15 * 60 * 1000;

// ── shared helpers ──────────────────────────────────────────────────────────

function cleanSteps(steps: DraftStep[]): DraftStep[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new OutreachStoreError("A draft needs at least one email.");
  if (steps.length > 12) throw new OutreachStoreError("Too many steps.");
  return steps.map((s, i) => {
    const subject = String(s?.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const body = String(s?.body ?? "").replace(/\r\n/g, "\n").trim().slice(0, 20_000);
    if (!subject) throw new OutreachStoreError(`Step ${i + 1} has no subject.`);
    if (!body) throw new OutreachStoreError(`Step ${i + 1} has no body.`);
    return { step: Number.isFinite(s.step) ? s.step : i + 1, subject, body, delayDays: s.delayDays ?? null };
  });
}

// ── Postgres ────────────────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres>;
const G = globalThis as typeof globalThis & { __wingOutreachSql?: Sql; __wingOutreachSchema?: Promise<void> | null };

function pgClient(): Sql {
  if (!G.__wingOutreachSql) {
    G.__wingOutreachSql = postgres(process.env.OS_DB_URL as string, {
      prepare: false, // port 6543 transaction pooler
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return G.__wingOutreachSql;
}

async function ensureSchema(sql: Sql): Promise<void> {
  if (!G.__wingOutreachSchema) {
    G.__wingOutreachSchema = (async () => {
      // Several statements in one round trip: simple protocol, no parameters.
      await sql.unsafe(OUTREACH_DDL).simple();
    })().catch((e) => {
      G.__wingOutreachSchema = null; // try again next call
      throw e;
    });
  }
  return G.__wingOutreachSchema;
}

type DraftDb = {
  id: string | number; tenant: string; lead_id: string; batch_date: string | Date; round: number;
  company: string | null; contact_name: string | null; contact_email: string | null; website: string | null;
  city: string | null; trade: string | null; facts: unknown; research: unknown; steps: unknown; original_steps: unknown;
  engine_status: string | null; qa_status: string; qa_reasons: unknown; approval_status: string; approver: string | null;
  approved_at: Date | null; rejected_reason: string | null; edited_by: string | null; edited_at: Date | null;
  push_requested_at: Date | null; push_requested_by: string | null; pushed_at: Date | null; next_round_due: Date | null;
  source_path: string | null; source_updated_at: Date | null; created_at: Date; updated_at: Date;
};

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
const dateOnly = (d: Date | string): string => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

function draftFromDb(r: DraftDb): DraftRow {
  return {
    id: Number(r.id),
    tenant: r.tenant,
    leadId: r.lead_id,
    batchDate: dateOnly(r.batch_date),
    round: r.round,
    company: r.company,
    contactName: r.contact_name,
    contactEmail: r.contact_email,
    website: r.website,
    city: r.city,
    trade: r.trade,
    facts: (r.facts as DraftRow["facts"]) ?? [],
    research: (r.research as DraftRow["research"]) ?? null,
    steps: (r.steps as DraftStep[]) ?? [],
    originalSteps: (r.original_steps as DraftStep[]) ?? [],
    engineStatus: r.engine_status,
    qaStatus: r.qa_status as DraftRow["qaStatus"],
    qaReasons: (r.qa_reasons as string[]) ?? [],
    engineApproval: null,
    approvalStatus: r.approval_status as ApprovalStatus,
    approver: r.approver,
    approvedAt: iso(r.approved_at),
    rejectedReason: r.rejected_reason,
    editedBy: r.edited_by,
    editedAt: iso(r.edited_at),
    pushRequestedAt: iso(r.push_requested_at),
    pushRequestedBy: r.push_requested_by,
    pushedAt: iso(r.pushed_at),
    nextRoundDue: iso(r.next_round_due),
    stopReason: null,
    sourcePath: r.source_path,
    sourceUpdatedAt: iso(r.source_updated_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

type EventDb = {
  id: string | number; event_type: string; occurred_at: Date; contact_email: string | null; tenant: string | null;
  campaign_id: string | null; mailbox: string | null; step: number | null; round: number | null; draft_id: string | number | null;
  lead_id: string | null; instantly_email_id: string | null; thread_id: string | null; subject: string | null;
  body_text: string | null; interest: string | null; stop_reason: string | null; source: string; dedupe_key: string; payload: unknown;
};

function eventFromDb(r: EventDb): OutreachEventRow {
  return {
    id: Number(r.id),
    eventType: r.event_type as OutreachEventRow["eventType"],
    occurredAt: iso(r.occurred_at) as string,
    contactEmail: r.contact_email,
    tenant: r.tenant,
    campaignId: r.campaign_id,
    mailbox: r.mailbox,
    step: r.step,
    round: r.round,
    draftId: r.draft_id == null ? null : Number(r.draft_id),
    leadId: r.lead_id,
    instantlyEmailId: r.instantly_email_id,
    threadId: r.thread_id,
    subject: r.subject,
    bodyText: r.body_text,
    interest: r.interest,
    stopReason: r.stop_reason as StopReason | null,
    source: r.source as OutreachEventRow["source"],
    dedupeKey: r.dedupe_key,
    payload: (r.payload as Record<string, unknown>) ?? null,
  };
}

type LeadDb = {
  tenant: string; email: string; lead_id: string | null; company: string | null; contact_name: string | null;
  current_round: number; last_sent_at: Date | null; next_round_due: Date | null; stop_reason: string | null;
  stopped_at: Date | null; stop_source: string | null; stop_detail: string | null;
};
function leadFromDb(r: LeadDb): LeadRow {
  return {
    tenant: r.tenant, email: r.email, leadId: r.lead_id, company: r.company, contactName: r.contact_name,
    currentRound: r.current_round, lastSentAt: iso(r.last_sent_at), nextRoundDue: iso(r.next_round_due),
    stopReason: r.stop_reason as StopReason | null, stoppedAt: iso(r.stopped_at), stopSource: r.stop_source, stopDetail: r.stop_detail,
  };
}

function pgStore(): OutreachStore {
  const sql = pgClient();
  const ready = () => ensureSchema(sql);

  async function one(id: number): Promise<DraftRow | null> {
    const rows = await sql<DraftDb[]>`select * from outreach_drafts where id = ${id}`;
    return rows[0] ? draftFromDb(rows[0]) : null;
  }

  async function applyLeadStop(
    tx: Sql | postgres.TransactionSql,
    lead: { tenant: string; email: string; reason: StopReason; at: string; source: string; detail: string | null }
  ): Promise<boolean> {
    const cur = await tx<{ stop_reason: string | null }[]>`
      select stop_reason from outreach_leads where tenant = ${lead.tenant} and email = ${lead.email}`;
    const current = (cur[0]?.stop_reason ?? null) as StopReason | null;
    const next = mergeStop(current, lead.reason);
    if (next === current && cur.length) return false;
    await tx`
      insert into outreach_leads (tenant, email, stop_reason, stopped_at, stop_source, stop_detail, updated_at)
      values (${lead.tenant}, ${lead.email}, ${next}, ${lead.at}, ${lead.source}, ${lead.detail}, now())
      on conflict (tenant, email) do update set
        stop_reason = excluded.stop_reason, stopped_at = excluded.stopped_at,
        stop_source = excluded.stop_source, stop_detail = excluded.stop_detail, updated_at = now()`;
    return true;
  }

  return {
    kind: "postgres",

    async upsertDrafts(drafts) {
      await ready();
      let inserted = 0;
      let updated = 0;
      for (const d of drafts) {
        const approved = d.engineApproval ? "approved" : "pending";
        const rows = await sql<{ inserted: boolean }[]>`
          insert into outreach_drafts (
            tenant, lead_id, batch_date, round, company, contact_name, contact_email, website, city, trade,
            facts, research, steps, original_steps, engine_status, qa_status, qa_reasons,
            approval_status, approver, approved_at, next_round_due, pushed_at, source_path, source_updated_at
          ) values (
            ${d.tenant}, ${d.leadId}, ${d.batchDate}, ${d.round}, ${d.company}, ${d.contactName}, ${d.contactEmail},
            ${d.website}, ${d.city}, ${d.trade}, ${sql.json(d.facts as never)}, ${d.research ? sql.json(d.research as never) : null},
            ${sql.json(d.steps as never)}, ${sql.json(d.steps as never)}, ${d.engineStatus}, ${d.qaStatus},
            ${sql.json(d.qaReasons as never)}, ${approved}, ${d.engineApproval?.approver ?? null},
            ${d.engineApproval ? d.engineApproval.at ?? new Date().toISOString() : null},
            ${d.nextRoundDue}, ${d.pushedAt}, ${d.sourcePath}, ${d.sourceUpdatedAt}
          )
          on conflict (tenant, lead_id, batch_date, round) do update set
            round = excluded.round,
            company = excluded.company,
            contact_name = excluded.contact_name,
            contact_email = excluded.contact_email,
            website = excluded.website,
            city = excluded.city,
            trade = excluded.trade,
            facts = excluded.facts,
            research = excluded.research,
            original_steps = excluded.original_steps,
            -- A person's edit or decision is never overwritten by a re-ingest.
            steps = case when outreach_drafts.edited_at is null and outreach_drafts.approval_status = 'pending'
                         then excluded.steps else outreach_drafts.steps end,
            engine_status = excluded.engine_status,
            qa_status = excluded.qa_status,
            qa_reasons = excluded.qa_reasons,
            approval_status = case when outreach_drafts.approval_status = 'pending' and excluded.approval_status = 'approved'
                                   then 'approved' else outreach_drafts.approval_status end,
            approver = coalesce(outreach_drafts.approver, excluded.approver),
            approved_at = coalesce(outreach_drafts.approved_at, excluded.approved_at),
            next_round_due = coalesce(excluded.next_round_due, outreach_drafts.next_round_due),
            pushed_at = coalesce(outreach_drafts.pushed_at, excluded.pushed_at),
            source_path = excluded.source_path,
            source_updated_at = excluded.source_updated_at,
            updated_at = now()
          returning (xmax = 0) as inserted`;
        if (rows[0]?.inserted) inserted++;
        else updated++;
        if (d.contactEmail) {
          await sql`
            insert into outreach_leads (tenant, email, lead_id, company, contact_name, current_round, next_round_due, updated_at)
            values (${d.tenant}, ${d.contactEmail}, ${d.leadId}, ${d.company}, ${d.contactName}, ${d.round}, ${d.nextRoundDue}, now())
            on conflict (tenant, email) do update set
              lead_id = excluded.lead_id,
              company = coalesce(excluded.company, outreach_leads.company),
              contact_name = coalesce(excluded.contact_name, outreach_leads.contact_name),
              current_round = greatest(outreach_leads.current_round, excluded.current_round),
              next_round_due = coalesce(excluded.next_round_due, outreach_leads.next_round_due),
              updated_at = now()`;
        }
      }
      return { inserted, updated };
    },

    async listDrafts(q) {
      await ready();
      const rows = await sql<DraftDb[]>`
        select * from outreach_drafts
        where (${q.batchDate ?? null}::date is null or batch_date = ${q.batchDate ?? null}::date)
          and (${q.tenant ?? null}::text is null or tenant = ${q.tenant ?? null}::text)
        order by batch_date desc, (qa_status = 'failed') desc, company nulls last, id
        limit 500`;
      return rows.map(draftFromDb);
    },

    async batchDates(limit = 30) {
      await ready();
      const rows = await sql<{ d: Date | string; n: number }[]>`
        select batch_date as d, count(*)::int as n from outreach_drafts group by batch_date order by batch_date desc limit ${limit}`;
      return rows.map((r) => ({ date: dateOnly(r.d), count: r.n }));
    },

    async getDraft(id) {
      await ready();
      return one(id);
    },

    async editDraft(id, steps, actor) {
      await ready();
      const clean = cleanSteps(steps);
      const cur = await one(id);
      if (!cur) throw new OutreachStoreError("That draft no longer exists.", 404);
      if (cur.approvalStatus !== "pending") {
        throw new OutreachStoreError(`This draft is already ${cur.approvalStatus}. Move it back to pending before editing.`, 409);
      }
      if (!stepsDiffer(cur.steps, clean)) return cur;
      const rows = await sql<DraftDb[]>`
        update outreach_drafts set steps = ${sql.json(clean as never)}, edited_by = ${actor}, edited_at = now(), updated_at = now()
        where id = ${id} and approval_status = 'pending' returning *`;
      if (!rows[0]) throw new OutreachStoreError("The draft changed while you were editing. Reload and try again.", 409);
      return draftFromDb(rows[0]);
    },

    async setApproval(id, status, actor, reason) {
      await ready();
      const cur = await one(id);
      if (!cur) throw new OutreachStoreError("That draft no longer exists.", 404);
      if (cur.pushRequestedAt || cur.pushedAt) {
        throw new OutreachStoreError("This draft is already handed to the sender, so its decision is locked.", 409);
      }
      if (status === "approved" && cur.qaStatus === "failed" && !reason) {
        throw new OutreachStoreError("QA failed on this draft. Fix it and re-run QA, or approve with a written reason.", 409);
      }
      const rows = await sql<DraftDb[]>`
        update outreach_drafts set
          approval_status = ${status},
          approver = ${status === "pending" ? null : actor},
          approved_at = ${status === "pending" ? null : new Date().toISOString()},
          rejected_reason = ${status === "rejected" || (status === "approved" && reason) ? reason ?? null : null},
          updated_at = now()
        where id = ${id} returning *`;
      return draftFromDb(rows[0]);
    },

    async approveAllPassed(batchDate, tenant, actor) {
      await ready();
      const rows = await sql`
        update outreach_drafts set approval_status = 'approved', approver = ${actor}, approved_at = now(), updated_at = now()
        where batch_date = ${batchDate}::date and approval_status = 'pending' and qa_status = 'passed'
          -- QA passed on the engine's text; an edited draft needs its own look.
          and edited_at is null
          and (${tenant}::text is null or tenant = ${tenant}::text)
        returning id`;
      return rows.length;
    },

    async requestPush(actor, tenant) {
      await ready();
      const rows = await sql`
        update outreach_drafts set push_requested_at = now(), push_requested_by = ${actor}, updated_at = now()
        where approval_status = 'approved' and push_requested_at is null and pushed_at is null
          and (${tenant}::text is null or tenant = ${tenant}::text)
        returning id`;
      return rows.length;
    },

    async listApproved(tenant, onlyPushRequested) {
      await ready();
      const rows = await sql<DraftDb[]>`
        select * from outreach_drafts
        where approval_status = 'approved' and pushed_at is null
          and (${tenant}::text is null or tenant = ${tenant}::text)
          and (${onlyPushRequested} = false or push_requested_at is not null)
        order by approved_at, id limit 500`;
      return rows.map(draftFromDb);
    },

    async insertEvents(events) {
      await ready();
      if (events.length === 0) return { inserted: 0, skipped: 0, stopsApplied: 0 };
      const emails = [...new Set(events.map((e) => e.contactEmail).filter((x): x is string => Boolean(x)))];

      // Which draft each person belongs to: their newest one.
      const drafts = emails.length
        ? await sql<{ id: string; tenant: string; lead_id: string; round: number; email: string }[]>`
            select distinct on (lower(contact_email)) id, tenant, lead_id, round, lower(contact_email) as email
            from outreach_drafts where lower(contact_email) = any(${emails})
            order by lower(contact_email), batch_date desc, id desc`
        : [];
      const draftBy = new Map(drafts.map((d) => [d.email, d]));

      // Replies already held, for collapsing the webhook copy onto the inbox copy.
      const replyEmails = [...new Set(events.filter((e) => e.eventType === "replied" || e.eventType === "auto_replied").map((e) => e.contactEmail).filter(Boolean) as string[])];
      const held = replyEmails.length
        ? await sql<{ email: string; at: Date }[]>`
            select contact_email as email, occurred_at as at from outreach_events
            where event_type in ('replied','auto_replied') and contact_email = any(${replyEmails})`
        : [];
      const heldBy = new Map<string, number[]>();
      for (const h of held) heldBy.set(h.email, [...(heldBy.get(h.email) ?? []), new Date(h.at).getTime()]);

      const rows: Record<string, unknown>[] = [];
      const seenKeys = new Set<string>();
      let skipped = 0;
      for (const e of events) {
        if (seenKeys.has(e.dedupeKey)) { skipped++; continue; }
        seenKeys.add(e.dedupeKey);
        if ((e.eventType === "replied" || e.eventType === "auto_replied") && e.contactEmail) {
          const t = Date.parse(e.occurredAt);
          const times = heldBy.get(e.contactEmail) ?? [];
          if (times.some((x) => Math.abs(x - t) < REPLY_COLLAPSE_MS)) { skipped++; continue; }
          heldBy.set(e.contactEmail, [...times, t]);
        }
        const d = e.contactEmail ? draftBy.get(e.contactEmail) : undefined;
        rows.push({
          event_type: e.eventType,
          occurred_at: e.occurredAt,
          contact_email: e.contactEmail,
          tenant: e.tenant ?? d?.tenant ?? null,
          campaign_id: e.campaignId,
          mailbox: e.mailbox,
          step: e.step,
          round: d?.round ?? null,
          draft_id: d ? Number(d.id) : null,
          lead_id: d?.lead_id ?? null,
          instantly_email_id: e.instantlyEmailId,
          thread_id: e.threadId,
          subject: e.subject,
          body_text: e.bodyText,
          interest: e.interest,
          stop_reason: e.stopReason,
          source: e.source,
          dedupe_key: e.dedupeKey,
          payload: e.payload ? sql.json(e.payload as never) : null,
        });
      }

      let insertedRows: EventDb[] = [];
      for (let i = 0; i < rows.length; i += 200) {
        const chunk = rows.slice(i, i + 200);
        const got = await sql<EventDb[]>`
          insert into outreach_events ${sql(chunk as never)}
          on conflict (dedupe_key) do nothing returning *`;
        insertedRows = insertedRows.concat(got);
      }
      skipped += rows.length - insertedRows.length;

      // Lead bookkeeping for what actually went in.
      let stopsApplied = 0;
      const lastSent = new Map<string, { tenant: string; at: string }>();
      for (const r of insertedRows) {
        const ev = eventFromDb(r);
        if (!ev.contactEmail) continue;
        const tenant = ev.tenant ?? "wing";
        if (ev.eventType === "sent") {
          const prev = lastSent.get(`${tenant}|${ev.contactEmail}`);
          if (!prev || prev.at < ev.occurredAt) lastSent.set(`${tenant}|${ev.contactEmail}`, { tenant, at: ev.occurredAt });
        }
        if (ev.stopReason) {
          const detail = ev.eventType === "replied" && ev.bodyText ? ev.bodyText.slice(0, 280) : ev.interest ?? ev.eventType;
          if (await applyLeadStop(sql, { tenant, email: ev.contactEmail, reason: ev.stopReason, at: ev.occurredAt, source: `instantly ${ev.source}`, detail })) stopsApplied++;
        }
      }
      for (const [k, v] of lastSent) {
        const email = k.slice(k.indexOf("|") + 1);
        await sql`
          insert into outreach_leads (tenant, email, last_sent_at, updated_at) values (${v.tenant}, ${email}, ${v.at}, now())
          on conflict (tenant, email) do update set
            last_sent_at = greatest(outreach_leads.last_sent_at, excluded.last_sent_at), updated_at = now()`;
      }
      return { inserted: insertedRows.length, skipped, stopsApplied };
    },

    async listEvents(sinceIso) {
      await ready();
      const rows = await sql<EventDb[]>`
        select id, event_type, occurred_at, contact_email, tenant, campaign_id, mailbox, step, round, draft_id, lead_id,
               instantly_email_id, thread_id, subject, null::text as body_text, interest, stop_reason, source, dedupe_key, null::jsonb as payload
        from outreach_events where occurred_at >= ${sinceIso} order by occurred_at desc limit 20000`;
      return rows.map(eventFromDb);
    },

    async listReplies(limit) {
      await ready();
      const rows = await sql<EventDb[]>`
        select * from outreach_events where event_type = 'replied' order by occurred_at desc limit ${limit}`;
      return rows.map(eventFromDb);
    },

    async listLeads() {
      await ready();
      const rows = await sql<LeadDb[]>`select * from outreach_leads order by updated_at desc limit 20000`;
      return rows.map(leadFromDb);
    },

    async sendTimes(sinceIso) {
      await ready();
      const rows = await sql<{ email: string; at: Date }[]>`
        select contact_email as email, occurred_at as at from outreach_events
        where event_type = 'sent' and contact_email is not null and occurred_at >= ${sinceIso}`;
      const m = new Map<string, number[]>();
      for (const r of rows) m.set(r.email, [...(m.get(r.email) ?? []), new Date(r.at).getTime()]);
      return m;
    },

    async applySuppression(list) {
      await ready();
      let n = 0;
      for (const s of list) {
        if (await applyLeadStop(sql, { tenant: s.tenant, email: s.email.toLowerCase(), reason: s.reason, at: s.at ?? new Date().toISOString(), source: s.source, detail: s.detail })) n++;
      }
      return n;
    },

    async upsertLeadStates(list) {
      await ready();
      for (const l of list) {
        await sql`
          insert into outreach_leads (tenant, email, lead_id, current_round, last_sent_at, next_round_due, updated_at)
          values (${l.tenant}, ${l.email}, ${l.leadId}, ${l.round ?? 1}, ${l.lastSentAt}, ${l.nextRoundDue}, now())
          on conflict (tenant, email) do update set
            lead_id = coalesce(excluded.lead_id, outreach_leads.lead_id),
            current_round = greatest(outreach_leads.current_round, excluded.current_round),
            last_sent_at = greatest(outreach_leads.last_sent_at, excluded.last_sent_at),
            -- The engine owns the re-touch schedule.
            next_round_due = coalesce(excluded.next_round_due, outreach_leads.next_round_due),
            updated_at = now()`;
      }
      return list.length;
    },

    async upsertMailboxStates(states) {
      await ready();
      for (const s of states) {
        await sql`
          insert into outreach_mailbox_state (mailbox, tenant, paused, paused_reason, paused_at, updated_at)
          values (${s.mailbox.toLowerCase()}, ${s.tenant}, ${s.paused}, ${s.pausedReason}, ${s.pausedAt}, now())
          on conflict (mailbox) do update set tenant = excluded.tenant, paused = excluded.paused,
            paused_reason = excluded.paused_reason, paused_at = excluded.paused_at, updated_at = now()`;
      }
      return states.length;
    },

    async listMailboxStates() {
      await ready();
      const rows = await sql<{ mailbox: string; tenant: string | null; paused: boolean; paused_reason: string | null; paused_at: Date | null; updated_at: Date }[]>`
        select * from outreach_mailbox_state order by mailbox`;
      return rows.map((r) => ({ mailbox: r.mailbox, tenant: r.tenant, paused: r.paused, pausedReason: r.paused_reason, pausedAt: iso(r.paused_at), updatedAt: iso(r.updated_at) as string }));
    },

    async getState<T>(key: string) {
      await ready();
      const rows = await sql<{ value: T }[]>`select value from outreach_sync_state where key = ${key}`;
      return rows[0]?.value ?? null;
    },

    async setState(key, value) {
      await ready();
      await sql`
        insert into outreach_sync_state (key, value, updated_at) values (${key}, ${sql.json(value as never)}, now())
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    },
  };
}

// ── Dev file store (local only) ─────────────────────────────────────────────

type DevDb = {
  drafts: DraftRow[];
  events: OutreachEventRow[];
  leads: LeadRow[];
  mailboxes: MailboxState[];
  state: Record<string, unknown>;
  seq: { draft: number; event: number };
};

export function devStorePath(): string {
  return process.env.OUTREACH_DEV_STORE || path.join(os.tmpdir(), "wing-os-outreach-dev.json");
}

function devStore(): OutreachStore {
  const file = devStorePath();
  const load = (): DevDb => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as DevDb;
    } catch {
      return { drafts: [], events: [], leads: [], mailboxes: [], state: {}, seq: { draft: 0, event: 0 } };
    }
  };
  const save = (db: DevDb) => fs.writeFileSync(file, JSON.stringify(db));
  const now = () => new Date().toISOString();

  const leadFor = (db: DevDb, tenant: string, email: string): LeadRow => {
    let l = db.leads.find((x) => x.tenant === tenant && x.email === email);
    if (!l) {
      l = { tenant, email, leadId: null, company: null, contactName: null, currentRound: 1, lastSentAt: null, nextRoundDue: null, stopReason: null, stoppedAt: null, stopSource: null, stopDetail: null };
      db.leads.push(l);
    }
    return l;
  };
  const stop = (db: DevDb, tenant: string, email: string, reason: StopReason, at: string, source: string, detail: string | null) => {
    const l = leadFor(db, tenant, email);
    const next = mergeStop(l.stopReason, reason);
    if (next === l.stopReason) return false;
    Object.assign(l, { stopReason: next, stoppedAt: at, stopSource: source, stopDetail: detail });
    return true;
  };

  return {
    kind: "dev-file",
    async upsertDrafts(drafts) {
      const db = load();
      let inserted = 0, updated = 0;
      for (const d of drafts) {
        const cur = db.drafts.find((x) => x.tenant === d.tenant && x.leadId === d.leadId && x.batchDate === d.batchDate && x.round === d.round);
        if (!cur) {
          inserted++;
          db.drafts.push({
            ...d, id: ++db.seq.draft, originalSteps: d.steps,
            approvalStatus: d.engineApproval ? "approved" : "pending",
            approver: d.engineApproval?.approver ?? null, approvedAt: d.engineApproval ? d.engineApproval.at ?? now() : null,
            rejectedReason: null, editedBy: null, editedAt: null, pushRequestedAt: null, pushRequestedBy: null, pushedAt: null,
            createdAt: now(), updatedAt: now(),
          });
        } else {
          updated++;
          const keepSteps = cur.editedAt || cur.approvalStatus !== "pending";
          Object.assign(cur, { ...d, id: cur.id, steps: keepSteps ? cur.steps : d.steps, originalSteps: d.steps, pushedAt: cur.pushedAt ?? d.pushedAt, updatedAt: now() });
          if (cur.approvalStatus === "pending" && d.engineApproval) Object.assign(cur, { approvalStatus: "approved", approver: d.engineApproval.approver, approvedAt: d.engineApproval.at ?? now() });
        }
        if (d.contactEmail) {
          const l = leadFor(db, d.tenant, d.contactEmail);
          Object.assign(l, { leadId: d.leadId, company: d.company ?? l.company, contactName: d.contactName ?? l.contactName, currentRound: Math.max(l.currentRound, d.round), nextRoundDue: d.nextRoundDue ?? l.nextRoundDue });
        }
      }
      save(db);
      return { inserted, updated };
    },
    async listDrafts(q) {
      return load().drafts
        .filter((d) => (!q.batchDate || d.batchDate === q.batchDate) && (!q.tenant || d.tenant === q.tenant))
        .sort((a, b) => (a.batchDate < b.batchDate ? 1 : a.batchDate > b.batchDate ? -1 : Number(b.qaStatus === "failed") - Number(a.qaStatus === "failed") || (a.company ?? "").localeCompare(b.company ?? "")));
    },
    async batchDates(limit = 30) {
      const m = new Map<string, number>();
      for (const d of load().drafts) m.set(d.batchDate, (m.get(d.batchDate) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, limit).map(([date, count]) => ({ date, count }));
    },
    async getDraft(id) {
      return load().drafts.find((d) => d.id === id) ?? null;
    },
    async editDraft(id, steps, actor) {
      const db = load();
      const clean = cleanSteps(steps);
      const d = db.drafts.find((x) => x.id === id);
      if (!d) throw new OutreachStoreError("That draft no longer exists.", 404);
      if (d.approvalStatus !== "pending") throw new OutreachStoreError(`This draft is already ${d.approvalStatus}. Move it back to pending before editing.`, 409);
      if (!stepsDiffer(d.steps, clean)) return d;
      Object.assign(d, { steps: clean, editedBy: actor, editedAt: now(), updatedAt: now() });
      save(db);
      return d;
    },
    async setApproval(id, status, actor, reason) {
      const db = load();
      const d = db.drafts.find((x) => x.id === id);
      if (!d) throw new OutreachStoreError("That draft no longer exists.", 404);
      if (d.pushRequestedAt || d.pushedAt) throw new OutreachStoreError("This draft is already handed to the sender, so its decision is locked.", 409);
      if (status === "approved" && d.qaStatus === "failed" && !reason) throw new OutreachStoreError("QA failed on this draft. Fix it and re-run QA, or approve with a written reason.", 409);
      Object.assign(d, {
        approvalStatus: status, approver: status === "pending" ? null : actor, approvedAt: status === "pending" ? null : now(),
        rejectedReason: status === "rejected" || (status === "approved" && reason) ? reason ?? null : null, updatedAt: now(),
      });
      save(db);
      return d;
    },
    async approveAllPassed(batchDate, tenant, actor) {
      const db = load();
      let n = 0;
      for (const d of db.drafts) {
        if (d.batchDate === batchDate && d.approvalStatus === "pending" && d.qaStatus === "passed" && !d.editedAt && (!tenant || d.tenant === tenant)) {
          Object.assign(d, { approvalStatus: "approved", approver: actor, approvedAt: now(), updatedAt: now() });
          n++;
        }
      }
      save(db);
      return n;
    },
    async requestPush(actor, tenant) {
      const db = load();
      let n = 0;
      for (const d of db.drafts) {
        if (d.approvalStatus === "approved" && !d.pushRequestedAt && !d.pushedAt && (!tenant || d.tenant === tenant)) {
          Object.assign(d, { pushRequestedAt: now(), pushRequestedBy: actor });
          n++;
        }
      }
      save(db);
      return n;
    },
    async listApproved(tenant, onlyPushRequested) {
      return load().drafts.filter((d) => d.approvalStatus === "approved" && !d.pushedAt && (!tenant || d.tenant === tenant) && (!onlyPushRequested || d.pushRequestedAt));
    },
    async insertEvents(events) {
      const db = load();
      let inserted = 0, skipped = 0, stopsApplied = 0;
      const keys = new Set(db.events.map((e) => e.dedupeKey));
      for (const e of events) {
        if (keys.has(e.dedupeKey)) { skipped++; continue; }
        if ((e.eventType === "replied" || e.eventType === "auto_replied") && e.contactEmail) {
          const t = Date.parse(e.occurredAt);
          if (db.events.some((x) => (x.eventType === "replied" || x.eventType === "auto_replied") && x.contactEmail === e.contactEmail && Math.abs(Date.parse(x.occurredAt) - t) < REPLY_COLLAPSE_MS)) { skipped++; continue; }
        }
        keys.add(e.dedupeKey);
        const d = e.contactEmail
          ? db.drafts.filter((x) => x.contactEmail === e.contactEmail).sort((a, b) => (a.batchDate < b.batchDate ? 1 : -1))[0]
          : undefined;
        const row: OutreachEventRow = { ...e, id: ++db.seq.event, tenant: e.tenant ?? d?.tenant ?? null, draftId: d?.id ?? null, leadId: d?.leadId ?? null, round: d?.round ?? null };
        db.events.push(row);
        inserted++;
        if (!row.contactEmail) continue;
        const tenant = row.tenant ?? "wing";
        if (row.eventType === "sent") {
          const l = leadFor(db, tenant, row.contactEmail);
          if (!l.lastSentAt || l.lastSentAt < row.occurredAt) l.lastSentAt = row.occurredAt;
        }
        if (row.stopReason) {
          const detail = row.eventType === "replied" && row.bodyText ? row.bodyText.slice(0, 280) : row.interest ?? row.eventType;
          if (stop(db, tenant, row.contactEmail, row.stopReason, row.occurredAt, `instantly ${row.source}`, detail)) stopsApplied++;
        }
      }
      save(db);
      return { inserted, skipped, stopsApplied };
    },
    async listEvents(sinceIso) {
      return load().events.filter((e) => e.occurredAt >= sinceIso).sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
    },
    async listReplies(limit) {
      return load().events.filter((e) => e.eventType === "replied").sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1)).slice(0, limit);
    },
    async listLeads() {
      return load().leads;
    },
    async sendTimes(sinceIso) {
      const m = new Map<string, number[]>();
      for (const e of load().events) {
        if (e.eventType === "sent" && e.contactEmail && e.occurredAt >= sinceIso) m.set(e.contactEmail, [...(m.get(e.contactEmail) ?? []), Date.parse(e.occurredAt)]);
      }
      return m;
    },
    async applySuppression(list) {
      const db = load();
      let n = 0;
      for (const s of list) if (stop(db, s.tenant, s.email.toLowerCase(), s.reason, s.at ?? now(), s.source, s.detail)) n++;
      save(db);
      return n;
    },
    async upsertLeadStates(list) {
      const db = load();
      for (const x of list) {
        const l = leadFor(db, x.tenant, x.email);
        l.leadId = x.leadId ?? l.leadId;
        l.currentRound = Math.max(l.currentRound, x.round ?? 1);
        if (x.lastSentAt && (!l.lastSentAt || l.lastSentAt < x.lastSentAt)) l.lastSentAt = x.lastSentAt;
        l.nextRoundDue = x.nextRoundDue ?? l.nextRoundDue;
      }
      save(db);
      return list.length;
    },
    async upsertMailboxStates(states) {
      const db = load();
      for (const s of states) {
        const m = s.mailbox.toLowerCase();
        db.mailboxes = db.mailboxes.filter((x) => x.mailbox !== m);
        db.mailboxes.push({ ...s, mailbox: m, updatedAt: now() });
      }
      save(db);
      return states.length;
    },
    async listMailboxStates() {
      return load().mailboxes;
    },
    async getState<T>(key: string) {
      return (load().state[key] as T) ?? null;
    },
    async setState(key, value) {
      const db = load();
      db.state[key] = value;
      save(db);
    },
  };
}

// ── pick one ────────────────────────────────────────────────────────────────

export type StoreChoice = { store: OutreachStore; reason: null } | { store: null; reason: string };

export function outreachStore(): StoreChoice {
  if (process.env.OS_DB_URL) return { store: pgStore(), reason: null };
  if (process.env.NODE_ENV !== "production") return { store: devStore(), reason: null };
  return {
    store: null,
    reason: "OS_DB_URL is not set on this deployment, so the outreach queue has nowhere to live. Add the Supabase pooler URL as OS_DB_URL in Vercel.",
  };
}

/** Turn any store failure into words for the UI. The pooler URL never leaks. */
export function storeFailure(e: unknown): { message: string; status: number } {
  if (e instanceof OutreachStoreError) return { message: e.message, status: e.status };
  const raw = e instanceof Error ? e.message : String(e);
  const safe = raw.replace(/postgres(ql)?:\/\/[^\s]+/gi, "[database url]");
  return { message: `The outreach database did not answer: ${safe.slice(0, 240)}`, status: 503 };
}
