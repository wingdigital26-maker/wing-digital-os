import { NextRequest, NextResponse } from "next/server";
import { outreachStore, storeFailure } from "@/lib/outreach/store";
import { isMachine, staffActor } from "@/lib/outreach/auth";
import { contextFromPath, lowerEmail, normalizeQueueItem, normalizeStop } from "@/lib/outreach/mappers";
import type { DraftInput, LeadStateInput, MailboxState, SuppressionInput } from "@/lib/outreach/types";

// POST /api/outreach/ingest
// Loads the engine's queue files into the OS. Called by scripts/outreach_ingest.mjs
// on Jack's PC (x-heartbeat-key) or by staff. Idempotent on tenant + lead + date + round:
// running it again updates the engine's fields and QA result but never
// overwrites a person's edit or approval decision.
//
// Body:
//   {
//     items: [{ path: "wing/2026-09-28/123.json", data: { ...queue file... } }],
//     mailboxes?: [{ mailbox, tenant?, paused, reason?, at? }],        engine circuit breaker
//     suppression?: [{ tenant, email, reason, at?, detail? }]           engine suppression list
//     leads?: [{ tenant, email, lead_id, round, state, stop_reason,       engine lead_state table
//                last_pushed_at, next_retouch_after, updated_at }]
//   }
// Answers with how many drafts went in, how many were updated, and every file
// that was refused with its reason. Sends nothing, pushes nothing.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ITEMS = 1_000;
const isoOr = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

export async function POST(req: NextRequest) {
  const machine = isMachine(req);
  if (!machine && !(await staffActor())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const choice = outreachStore();
  if (!choice.store) return NextResponse.json({ ok: false, reason: choice.reason }, { status: 503 });

  let body: { items?: unknown; mailboxes?: unknown; suppression?: unknown; leads?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "Body must be JSON." }, { status: 400 });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length > MAX_ITEMS) {
    return NextResponse.json({ ok: false, reason: `At most ${MAX_ITEMS} files per call. Send them in batches.` }, { status: 413 });
  }

  const drafts: DraftInput[] = [];
  const refused: { path: string | null; reason: string }[] = [];
  for (const it of items) {
    const rec = it && typeof it === "object" ? (it as { path?: unknown; data?: unknown }) : {};
    const p = typeof rec.path === "string" ? rec.path : null;
    const r = normalizeQueueItem(rec.data ?? it, p ? contextFromPath(p) : {});
    if (r.ok) drafts.push(r.draft);
    else refused.push({ path: p, reason: r.reason });
  }

  const mailboxes: Omit<MailboxState, "updatedAt">[] = [];
  for (const m of Array.isArray(body.mailboxes) ? body.mailboxes : []) {
    if (!m || typeof m !== "object") continue;
    const o = m as Record<string, unknown>;
    const mailbox = lowerEmail(o.mailbox);
    if (!mailbox) continue;
    mailboxes.push({
      mailbox,
      tenant: typeof o.tenant === "string" ? o.tenant : null,
      paused: o.paused === true,
      pausedReason: typeof o.reason === "string" ? o.reason.slice(0, 300) : null,
      pausedAt: typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) ? new Date(o.at).toISOString() : null,
    });
  }

  const suppression: SuppressionInput[] = [];
  // A stop the engine wrote on the draft itself counts the same as its list.
  for (const d of drafts) {
    if (d.stopReason && d.contactEmail) {
      suppression.push({ tenant: d.tenant, email: d.contactEmail, reason: d.stopReason, at: d.sourceUpdatedAt, detail: "set on the engine's queue file", source: "engine queue file" });
    }
  }
  for (const s of Array.isArray(body.suppression) ? body.suppression : []) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const email = lowerEmail(o.email);
    const reason = normalizeStop(o.reason);
    // The suppression table is permanent stops only; a handoff is not suppression.
    if (!email || !reason || reason === "handoff") continue;
    suppression.push({
      tenant: typeof o.tenant === "string" && o.tenant !== "*" ? o.tenant : "wing",
      email,
      reason,
      at: typeof o.at === "string" && Number.isFinite(Date.parse(o.at)) ? new Date(o.at).toISOString() : null,
      detail: typeof o.detail === "string" ? o.detail.slice(0, 300) : null,
      source: "engine suppression",
    });
  }

  // The engine's lead_state (round, next re-touch date, stop), mirrored as is.
  const leads: LeadStateInput[] = [];
  for (const l of Array.isArray(body.leads) ? body.leads : []) {
    if (!l || typeof l !== "object") continue;
    const o = l as Record<string, unknown>;
    const email = lowerEmail(o.email);
    if (!email) continue;
    const tenant = typeof o.tenant === "string" ? o.tenant : "wing";
    const round = Number(o.round);
    leads.push({
      tenant,
      email,
      leadId: o.lead_id == null ? null : String(o.lead_id).slice(0, 128),
      round: Number.isFinite(round) && round > 0 ? Math.trunc(round) : null,
      lastSentAt: isoOr(o.last_pushed_at),
      nextRoundDue: isoOr(o.next_retouch_after),
    });
    const stop = normalizeStop(o.stop_reason) ?? (o.state === "human-handoff" ? "handoff" : null);
    if (stop) {
      suppression.push({ tenant, email, reason: stop, at: isoOr(o.updated_at), detail: `engine lead_state: ${String(o.state ?? "")}`, source: "engine lead_state" });
    }
  }

  try {
    const s = choice.store;
    const result = await s.upsertDrafts(drafts);
    const leadsSaved = leads.length ? await s.upsertLeadStates(leads) : 0;
    const mailboxesSaved = mailboxes.length ? await s.upsertMailboxStates(mailboxes) : 0;
    const stopsApplied = suppression.length ? await s.applySuppression(suppression) : 0;
    return NextResponse.json({ ok: true, ...result, refused, leadsSaved, mailboxesSaved, stopsApplied, storeKind: s.kind });
  } catch (e) {
    const f = storeFailure(e);
    return NextResponse.json({ ok: false, reason: f.message, refused }, { status: f.status });
  }
}
