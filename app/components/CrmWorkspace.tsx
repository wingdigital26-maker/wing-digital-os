"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import CrmRowDetail, {
  SourceLink, NoSourceLink,
  type DetailItem, type Evidence, type Review, type TierInfo,
} from "./CrmRowDetail";
import { ContactDetail } from "./pipeline/ContactsPanel";

// ───────────────────────────────────────────────────────────────────────────
// CrmWorkspace — the ONE CRM surface.
//
// It replaces three tabs that each held a third of the truth:
//   Inbox    (/api/inbox)    the per-client queue of drafts awaiting a decision
//   Outbound (/api/crm)      everything ever drafted, sent, rejected or skipped
//   Pipeline (/api/pipeline) Wing's own contact book and deals, the CRM that
//                            GoHighLevel took with it when it was retired
//
// The Inbox was a strict subset of Outbound (the same table, filtered to
// status = draft), so it is folded in as the DEFAULT FILTER rather than as a
// separate screen — "needs your decision" is the only time-sensitive part, so
// that is what opens. The Pipeline tab is gone, but every one of its records is
// here as its own category with every column intact. Nothing was deleted.
//
// HONESTY RULES, carried over from the routes this reads:
//   * NULL is unknown and never renders as zero or as an empty success state.
//   * A short read says it is short. A capped list says it is capped.
//   * Every blocker below is computed from a real field. A blocker that cannot
//     be derived from data is not shown at all rather than guessed at.
// ───────────────────────────────────────────────────────────────────────────

// ── Payload types (mirroring the two routes) ───────────────────────────────

type SourceLinkOut = { url: string; kind: "evidence" | "recipient" };

type OutboundItem = {
  id: number;
  client: string | null;
  channel: string | null;
  recipient: string | null;
  recipient_url: string | null;
  subject: string | null;
  body: string | null;
  personalization: string | null;
  evidence_url: string | null;
  status: string | null;
  tier: string | null;
  created_at: string | null;
  direction: string | null;
  recipientHandle: string | null;
  reviewedAt: string | null;
  sentAt: string | null;
  tierInfo: TierInfo;
  evidence: Evidence;
  sourceLinks: SourceLinkOut[];
  bodyState: string;
  review: Review;
  sendable: boolean | null;
  notSendableReason: string | null;
};

type CrmClientRoll = {
  client: string;
  total: number; draft: number; approved: number; sent: number;
  sendPolicy: { client: string; may_send: boolean; scope_note: string | null } | null;
  /** Derived server-side from client_send_policy, default deny. */
  sendPolicyState?: "may_send" | "deny" | "unknown";
  /** True when this client's drafts are leads to hand over, not Wing outbound. */
  handover?: boolean;
  handoverReason?: string | null;
};

type CrmPayload = {
  configured: boolean;
  error?: string;
  clients: CrmClientRoll[];
  items: OutboundItem[];
  itemsMeta?: { limit: number; returned: number; capped: boolean; note: string | null };
  sendPolicy?: { available: boolean; reason: string | null };
  scan?: { complete: boolean; note: string | null };
};

type PipelineContact = {
  recordId: string; recordType: "contact"; id: number;
  name: string; person: string | null; title: string | null;
  email: string | null; phone: string | null; website: string | null;
  where: string | null; trade: string | null;
  source: string | null; sourceRef: string | null; verifiedAt: string | null;
  doNotContact: boolean; dncReason: string | null; notes: string | null;
  dealCount: number; ownerId: string | null;
  createdAt: string; updatedAt: string;
};

type PipelineDeal = {
  recordId: string; recordType: "deal"; id: number;
  name: string; contactId: number;
  business: string | null; person: string | null;
  email: string | null; phone: string | null; website: string | null;
  where: string | null; trade: string | null; doNotContact: boolean;
  valueCents: number | null; status: string;
  stageKey: string | null; stageLabel: string | null;
  expectedClose: string | null; wonAt: string | null; lostAt: string | null;
  lostReason: string | null; ownerId: string | null;
  createdAt: string; updatedAt: string;
};

type PipelinePayload = {
  ok?: boolean;
  error?: string; message?: string;
  records?: { contacts: PipelineContact[]; deals: PipelineDeal[] };
  contactsMeta?: { returned: number; total: number | null; complete: boolean; note: string | null };
  counts?: {
    contacts: number; contactsDoNotContact: number; contactsWithoutDeal: number;
    deals: number; dealsOpen: number; dealsWon: number; dealsLost: number;
  };
};

// ── Categories ─────────────────────────────────────────────────────────────

type TypeKey = "outbound" | "contact" | "deal";
type Pane = "contacts" | "deals" | "drafts";
type StatusKey =
  | "needs_decision" | "client_handover" | "approved" | "rejected" | "sent" | "other_outbound"
  | "deal_open" | "deal_won" | "deal_lost" | "contact_on_file";

const TYPE_LABEL: Record<TypeKey, string> = {
  outbound: "Outbound draft",
  contact: "Pipeline contact",
  deal: "Deal",
};

const STATUS_LABEL: Record<StatusKey, string> = {
  needs_decision: "Needs your decision",
  client_handover: "Leads to hand to the client",
  approved: "Approved",
  rejected: "Rejected",
  sent: "Sent",
  other_outbound: "Other draft status",
  deal_open: "Deal open",
  deal_won: "Deal won",
  deal_lost: "Deal lost",
  contact_on_file: "Contact on file",
};

const STATUS_COLOR: Record<StatusKey, string> = {
  needs_decision: "var(--accent)",
  client_handover: "var(--accent-2)",
  approved: "var(--green)",
  rejected: "var(--text-muted)",
  sent: "var(--green)",
  other_outbound: "var(--text-muted)",
  deal_open: "var(--accent)",
  deal_won: "var(--green)",
  deal_lost: "var(--red)",
  contact_on_file: "var(--text-muted)",
};

/** Pipeline records belong to Wing's own book, not to a client Wing works for.
 *  Filing them under a client name would invent a relationship. */
const WING_BOOK = "Wing Digital, our own book";
const NO_CHANNEL = "no channel (pipeline record)";

// ── Blockers ───────────────────────────────────────────────────────────────
// The audit found 0 of 41 drafts were actually sendable and the board said
// nothing about why. Every entry below is derived from a field that really
// exists on the row. Anything that would need a guess (whether an address is
// genuinely inside a service area, whether a recipient is on the suppression
// list — neither is exposed per row) is deliberately absent rather than faked.

type Blocker = { code: string; label: string; detail: string };

const SALE_DATE = /Upcoming sale:\s*(\d{4}-\d{2}-\d{2})/i;
const LOCATION_FLAG = /NEEDS LOCATION CHECK/i;

/** Today as YYYY-MM-DD in the viewer's own timezone, for date-only comparison. */
function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Does this row belong in the client-handover lane rather than in Wing's own
 * approval queue? Derived ONLY from client_send_policy, which /api/crm resolves
 * per client with default deny. No client name appears anywhere in this file:
 * the day a policy row flips, the lane follows it with no code change.
 *
 * Only drafts qualify. An already-approved or already-sent row has its own
 * status and its own history, and re-filing it here would rewrite the past.
 */
function isHandover(it: OutboundItem, policy: { available: boolean }, roll: CrmClientRoll | undefined): boolean {
  if (!policy.available) return false;   // permission unknown is not permission denied
  if (it.status !== "draft") return false;
  const pol = roll?.sendPolicy ?? null;
  return pol?.may_send !== true;
}

function outboundBlockers(
  it: OutboundItem,
  policy: { available: boolean },
  roll: CrmClientRoll | undefined,
  today: string,
  handover: boolean,
): Blocker[] {
  const out: Blocker[] = [];

  // Sending permission. Default deny is the contract in /api/crm, so a client
  // with no policy row is as blocked as one explicitly denied.
  //
  // Not on a handover row, though. There, the deny IS the lane: the draft is
  // doing exactly what it is supposed to do, and painting it red as "blocked"
  // is the wrong word for a lead that is working as intended.
  if (policy.available && !handover) {
    const pol = roll?.sendPolicy ?? null;
    if (!pol) {
      out.push({
        code: "forbidden",
        label: "client forbids Wing sending",
        detail: `${it.client ?? "This client"} has no send-policy row on file, and the policy ` +
                `table defaults to deny. Nothing can go out for them until a row says otherwise.`,
      });
    } else if (pol.may_send !== true) {
      out.push({
        code: "forbidden",
        label: "client forbids Wing sending",
        detail: pol.scope_note?.replace(/\s+/g, " ").trim() ||
                `${pol.client} is marked may_send = false and no scope note was recorded.`,
      });
    }
  }

  // A contact path that matches the channel it is meant to go out on.
  const rec = it.recipient?.trim() ?? "";
  if (it.channel === "email") {
    if (!rec) {
      out.push({
        code: "no_email",
        label: "no email address",
        detail: "This row is on the email channel but no recipient was recorded, so there is nowhere to send it.",
      });
    } else if (!rec.includes("@")) {
      out.push({
        code: "no_email",
        label: "no email address",
        detail: `This row is on the email channel but the recipient is "${rec}", which is a ` +
                `company name rather than an address. The drafter never found a mailbox for them.`,
      });
    }
  } else if (!rec && !it.recipientHandle) {
    out.push({
      code: "no_contact_path",
      label: "no contact path recorded",
      detail: `Neither a recipient nor a handle was recorded on the ${it.channel ?? "unset"} ` +
              `channel, so there is no way to reach this person from the row.`,
    });
  }

  // The clickable source. sourceLinks is the payload's own explicit list, so an
  // empty array is a stated fact, not an absence the UI had to notice.
  if (!it.sourceLinks || it.sourceLinks.length === 0) {
    out.push({
      code: "no_source",
      label: "no source link",
      detail: "Neither an evidence_url nor a recipient_url was captured, so the post this " +
              "was written from cannot be opened and the claim cannot be checked.",
    });
  }

  // Nothing to approve.
  if (!it.body) {
    out.push({
      code: "no_body",
      label: "no message written",
      detail: it.bodyState && it.bodyState !== "written"
        ? it.bodyState
        : "The drafter created this row and never wrote the message.",
    });
  }

  // A dated opportunity that has already expired. The date is a real structured
  // field the drafter writes into the personalization note, not an inference.
  const m = it.personalization?.match(SALE_DATE) ?? null;
  if (m && m[1] < today) {
    out.push({
      code: "date_passed",
      label: "sale date passed",
      detail: `The drafter recorded an upcoming sale on ${m[1]}, which is in the past. The ` +
              `reason this message existed has already happened.`,
    });
  }

  // The drafter's own location doubt. Reported as what it is — an unconfirmed
  // location — rather than as a service-area verdict nobody actually computed.
  if (LOCATION_FLAG.test(it.personalization ?? "")) {
    out.push({
      code: "location_unconfirmed",
      label: "location not confirmed, may be outside service area",
      detail: "The drafter flagged this row itself: no city could be resolved from the post, " +
              "so whether this person is inside the client's service area is unknown.",
    });
  }

  return out;
}

function contactBlockers(c: PipelineContact): Blocker[] {
  const out: Blocker[] = [];
  if (c.doNotContact) {
    out.push({
      code: "dnc", label: "on the do-not-contact list",
      detail: c.dncReason?.trim() || "Marked do_not_contact with no reason recorded. Do not reach out.",
    });
  }
  if (!c.email) {
    out.push({
      code: "no_email", label: "no email address",
      detail: "No email is on file for this contact, so they cannot be mailed.",
    });
  }
  if (!c.phone) {
    out.push({
      code: "no_phone", label: "no phone number",
      detail: "No phone number is on file for this contact, so they cannot be called.",
    });
  }
  if (!c.website) {
    out.push({
      code: "no_source", label: "no source link",
      detail: "No website was captured for this business, so there is no page to open and check them against.",
    });
  }
  return out;
}

function dealBlockers(d: PipelineDeal, today: string): Blocker[] {
  const out: Blocker[] = [];
  if (d.doNotContact) {
    out.push({
      code: "dnc", label: "on the do-not-contact list",
      detail: "The contact behind this deal is marked do_not_contact. Do not reach out.",
    });
  }
  if (d.status === "open" && d.expectedClose && d.expectedClose.slice(0, 10) < today) {
    out.push({
      code: "date_passed", label: "expected close date passed",
      detail: `This deal was expected to close on ${d.expectedClose.slice(0, 10)} and is still ` +
              `open. Either it slipped and the date needs moving, or it is dead and nobody said so.`,
    });
  }
  if (d.valueCents === null) {
    out.push({
      code: "not_quoted", label: "not quoted",
      detail: "No value has been recorded on this deal, so it contributes nothing to the " +
              "pipeline total. That is unknown, not zero.",
    });
  }
  if (!d.email && !d.phone) {
    out.push({
      code: "no_contact_path", label: "no contact path recorded",
      detail: "The contact behind this deal has neither an email nor a phone number on file.",
    });
  }
  return out;
}

// ── The unified row ────────────────────────────────────────────────────────

type Row = {
  key: string;
  type: TypeKey;
  status: StatusKey;
  statusText: string;      // raw status when it is not one we map
  client: string;
  channel: string;
  title: string;
  who: string | null;
  where: string | null;
  when: string | null;
  blockers: Blocker[];
  /** Why this row sits in the handover lane. Null for every other row. */
  handoverNote: string | null;
  search: string;
  outbound: OutboundItem | null;
  contact: PipelineContact | null;
  deal: PipelineDeal | null;
};

function outboundStatus(raw: string | null): { key: StatusKey; text: string } {
  switch (raw) {
    case "draft": return { key: "needs_decision", text: "Needs your decision" };
    case "approved": return { key: "approved", text: "Approved" };
    case "sent": return { key: "sent", text: "Sent" };
    case "rejected": return { key: "rejected", text: "Rejected" };
    case "skipped": return { key: "rejected", text: "Skipped" };
    default:
      return {
        key: "other_outbound",
        text: raw ? `Status "${raw}"` : "No status recorded",
      };
  }
}

function money(cents: number | null): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "not quoted";
  const d = cents / 100;
  return d.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    maximumFractionDigits: d % 1 === 0 ? 0 : 2,
  });
}

function when(iso: string | null): string {
  if (!iso) return "no date recorded";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "no date recorded";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 0) return new Date(t).toLocaleDateString();
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return days < 60 ? `${days}d ago` : new Date(t).toLocaleDateString();
}

/** The outbound row, in the exact shape CrmRowDetail already renders. This is
 *  a pass-through on purpose: the source links, quote and empty states it
 *  builds are the thing Jack asked for and must not be re-implemented here. */
function toDetail(it: OutboundItem): DetailItem {
  return {
    id: it.id, client: it.client, channel: it.channel, recipient: it.recipient,
    recipientHandle: it.recipientHandle, recipient_url: it.recipient_url,
    subject: it.subject, body: it.body, personalization: it.personalization,
    evidence_url: it.evidence_url, status: it.status, tier: it.tier,
    created_at: it.created_at, reviewedAt: it.reviewedAt, sentAt: it.sentAt,
    direction: it.direction, sendable: it.sendable,
    notSendableReason: it.notSendableReason,
    tierInfo: it.tierInfo, evidence: it.evidence, review: it.review,
    bodyState: it.bodyState,
  };
}

// ── Small presentational pieces ────────────────────────────────────────────

const chipBase: React.CSSProperties = {
  padding: "5px 11px", borderRadius: 999, fontSize: 12.5, cursor: "pointer",
  background: "transparent", whiteSpace: "nowrap", lineHeight: 1.4,
};

/** One collapsed facet. The chip rows carried the counts; a select carries the
 *  same counts inside its option labels, so nothing is lost by folding it. */
function Select({
  name, value, options, onChange, wide,
}: {
  name: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  wide?: boolean;
}) {
  const on = value !== "all";
  return (
    <label style={{ display: "inline-flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{
        fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".07em",
        fontWeight: 700, color: "var(--text-muted)", paddingLeft: 2,
      }}>
        {name}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: "7px 10px", borderRadius: 9, fontSize: 12.5, cursor: "pointer",
          maxWidth: "100%", minWidth: wide ? 210 : 150,
          border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
          color: on ? "var(--accent)" : "var(--text-secondary)",
          fontWeight: on ? 700 : 500,
          background: "var(--bg-secondary)",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

/** The one action that is not a filter: approve. Filled, not outlined, so it
 *  never reads as one more equal choice in a row of chips. */
function PrimaryButton({
  label, onClick, busy, disabled,
}: {
  label: string; onClick: () => void; busy?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        padding: "7px 15px", borderRadius: 9, fontSize: 12.5, fontWeight: 700,
        border: "1px solid var(--green)", background: "var(--green)", color: "var(--bg-primary)",
        cursor: busy || disabled ? "default" : "pointer", opacity: busy || disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "Saving" : label}
    </button>
  );
}

function QuietButton({
  label, onClick, busy, tone = "var(--text-secondary)",
}: {
  label: string; onClick: () => void; busy?: boolean; tone?: string;
}) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        padding: "6px 12px", borderRadius: 9, fontSize: 12, fontWeight: 600,
        border: "1px solid var(--border)", background: "transparent", color: tone,
        cursor: busy ? "default" : "pointer", opacity: busy ? 0.55 : 1, whiteSpace: "nowrap",
      }}
    >
      {busy ? "Saving" : label}
    </button>
  );
}

// ── Handing a lead to the client ───────────────────────────────────────────
// The handover lane's whole purpose is getting the lead OUT of this screen and
// into the client's hands. Approving is meaningless here (Wing will never send
// it), so the action is a copy: the message text, the source link and whatever
// contact detail the row carries, as plain text Jack can paste anywhere.

/** One lead as plain text. Built only from fields the row really carries; an
 *  absent field says it is absent rather than leaving a blank that reads as if
 *  the detail was never needed. */
function handoverText(r: Row): string {
  const it = r.outbound;
  if (!it) return "";
  const L: string[] = [];
  L.push(`LEAD FOR ${it.client ?? "an unrecorded client"}`);
  L.push(`Who: ${it.recipient ?? it.recipientHandle ?? "no contact detail was recorded"}`);
  L.push(`Channel it was found on: ${it.channel ?? "not recorded"}`);
  L.push(`Found: ${it.created_at ?? "no date recorded"}`);
  if (it.sourceLinks?.length) {
    for (const s of it.sourceLinks) {
      L.push(`${s.kind === "evidence" ? "Source (the post it was read from)" : "Their own page"}: ${s.url}`);
    }
  } else {
    L.push("Source: none was captured, so there is no page to open and check this against.");
  }
  L.push(`Why them: ${it.personalization ?? "the drafter recorded no reason."}`);
  L.push("");
  L.push(`Subject: ${it.subject ?? "none written"}`);
  L.push(it.body ?? "No message was ever written for this lead.");
  L.push("");
  L.push("Wing did not send this. It is written up for you to use as you see fit.");
  return L.join("\n");
}

/** Copy that still works where the async clipboard API is unavailable (an
 *  insecure origin, an older browser). Returns whether the text really landed,
 *  so the UI can say it failed instead of claiming a copy that never happened. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the manual path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Said in full everywhere an approve button appears. Approving is a database
 *  write and nothing else: there is no code path from this screen to a mail
 *  server, and /api/crm's POST only PATCHes the outbound row. */
const NO_SEND_NOTE =
  "Approving marks the row approved in the database. It does not send anything. " +
  "Wing's own sending pipe has never fired and Grant currently owns sending.";

/** Said on every handover row, in place of the approve note. There is no
 *  approve button here and nothing on this path can transmit anything. */
const HANDOVER_NOTE =
  "This client does not permit Wing to send on their behalf, so there is nothing here to " +
  "approve and nothing will ever be mailed from this row. Copy the lead and hand it to them.";

function Note({ text, tone = "var(--orange)" }: { text: string; tone?: string }) {
  return (
    <div style={{
      border: `1px solid ${tone}`, borderRadius: 10, padding: "9px 12px",
      background: "var(--bg-card)", fontSize: 12, lineHeight: 1.55, color: tone,
    }}>
      {text}
    </div>
  );
}

function BlockerCell({ blockers }: { blockers: Blocker[] }) {
  if (blockers.length === 0) {
    return (
      <span style={{ fontSize: 11.5, color: "var(--green)", fontWeight: 600 }}>
        nothing blocking it
      </span>
    );
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {blockers.map((b) => (
        <span
          key={b.code}
          title={b.detail}
          style={{
            fontSize: 10.5, fontWeight: 700, color: "var(--red)",
            border: "1px solid var(--red)", borderRadius: 6, padding: "1px 7px",
            whiteSpace: "nowrap",
          }}
        >
          {b.label}
        </span>
      ))}
    </div>
  );
}

/** The pipeline record's own detail panel. Uses the same SourceLink /
 *  NoSourceLink pair as the outbound panel, so a missing link is just as loud
 *  on a contact as it is on a draft. */
function PipelineDetail({ row, onClose, onViewContact }: {
  row: Row; onClose: () => void; onViewContact: (contactId: number) => void;
}) {
  const c = row.contact;
  const d = row.deal;
  const contactId = c?.id ?? d?.contactId ?? null;
  const site = c?.website ?? d?.website ?? null;
  const label: React.CSSProperties = {
    fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em",
    color: "var(--text-muted)", fontWeight: 700,
  };
  const val = (v: string | null, empty: string) => (
    <div style={{
      fontSize: 12.5, marginTop: 3, wordBreak: "break-word",
      color: v ? "var(--text-primary)" : "var(--text-muted)",
      fontStyle: v ? "normal" : "italic",
    }}>
      {v || empty}
    </div>
  );
  const F = ({ n, v, e }: { n: string; v: string | null; e: string }) => (
    <div style={{ minWidth: 0 }}><div style={label}>{n}</div>{val(v, e)}</div>
  );

  return (
    <div
      role="region"
      aria-label={`Full details for ${row.key}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        border: "1px solid var(--accent)", borderRadius: 12, padding: "14px 16px",
        background: "var(--bg-secondary)", display: "flex", flexDirection: "column", gap: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span style={{
          fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em",
          fontWeight: 700, color: "var(--accent)",
        }}>
          {c ? `Pipeline contact · #${c.id}` : `Deal · #${d?.id}`}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          {contactId !== null && (
            <button
              type="button"
              onClick={() => onViewContact(contactId)}
              style={{
                fontSize: 11.5, padding: "3px 10px", borderRadius: 8, cursor: "pointer",
                border: "1px solid var(--accent)", background: "transparent", color: "var(--accent)",
              }}
            >
              {c ? "Open full contact view" : "View contact"}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 11.5, padding: "3px 10px", borderRadius: 8, cursor: "pointer",
              border: "1px solid var(--border)", background: "transparent", color: "var(--text-secondary)",
            }}
          >
            close
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
        <F n="Business" v={c?.name ?? d?.business ?? null} e="No business name recorded." />
        <F n="Person" v={c?.person ?? d?.person ?? null} e="No contact name yet." />
        <F n="Job title" v={c?.title ?? null} e="No title recorded." />
        <F n="Email" v={c?.email ?? d?.email ?? null} e="No email on file." />
        <F n="Phone" v={c?.phone ?? d?.phone ?? null} e="No phone on file." />
        <F n="Location" v={row.where} e="No city or state recorded." />
        <F n="Trade" v={c?.trade ?? d?.trade ?? null} e="No trade recorded." />
      </div>

      <div>
        <div style={label}>Their website</div>
        <div style={{ marginTop: 4 }}>
          {site
            ? <SourceLink url={site} kind="recipient" />
            : <NoSourceLink what="No source link captured for this lead" />}
        </div>
      </div>

      {d && (
        <div style={{
          display: "grid", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border)",
          gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
        }}>
          <F n="Deal title" v={d.name} e="No title recorded." />
          <F n="Stage" v={d.stageLabel} e="No stage recorded." />
          <F n="Value" v={d.valueCents === null ? null : money(d.valueCents)} e="not quoted" />
          <F n="Deal status" v={d.status} e="No status recorded." />
          <F n="Expected close" v={d.expectedClose} e="No expected close date set." />
          <F n="Won at" v={d.wonAt} e="Not won." />
          <F n="Lost at" v={d.lostAt} e="Not lost." />
          <F n="Lost reason" v={d.lostReason} e="No lost reason recorded." />
        </div>
      )}

      {c && (
        <div style={{
          display: "grid", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border)",
          gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
        }}>
          <F n="Where this record came from" v={c.source} e="No source recorded." />
          <F n="Source reference" v={c.sourceRef} e="No source reference recorded." />
          <F n="Verified by a human" v={c.verifiedAt} e="Never verified by a human." />
          <F n="Do not contact" v={c.doNotContact ? (c.dncReason || "Yes, no reason recorded") : null} e="Not suppressed." />
          <F n="Open and closed deals" v={String(c.dealCount)} e="none" />
          <F n="Owner" v={c.ownerId} e="No owner recorded." />
        </div>
      )}

      <div style={{
        display: "grid", gap: 10, paddingTop: 12, borderTop: "1px solid var(--border)",
        gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
      }}>
        <F n="Notes" v={c?.notes ?? null} e="No notes recorded." />
        <F n="Created" v={c?.createdAt ?? d?.createdAt ?? null} e="No created timestamp." />
        <F n="Last updated" v={c?.updatedAt ?? d?.updatedAt ?? null} e="No updated timestamp." />
      </div>

      {row.blockers.length > 0 && (
        <div style={{ paddingTop: 12, borderTop: "1px solid var(--border)" }}>
          <div style={label}>What is blocking this record</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, display: "grid", gap: 5 }}>
            {row.blockers.map((b) => (
              <li key={b.code} style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--red)" }}>{b.label}</strong>: {b.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── The workspace ──────────────────────────────────────────────────────────

export type CrmWorkspaceProps = {
  /** Which bucket opens first. Defaults to "needs_decision", the only
   *  time-sensitive category. Pass "all" to open on everything. */
  initialStatus?: StatusKey | "all";
  /** Preselect one client, by the exact name used in the outbound table
   *  (for example "Hero's Junk Removal"), or WING_BOOK for the pipeline. */
  initialClient?: string;
};

const PAGE_SIZE = 150;

export default function CrmWorkspace({
  initialStatus = "needs_decision",
  initialClient,
}: CrmWorkspaceProps = {}) {
  const [crm, setCrm] = useState<CrmPayload | null>(null);
  const [pipe, setPipe] = useState<PipelinePayload | null>(null);
  const [crmErr, setCrmErr] = useState("");
  const [pipeErr, setPipeErr] = useState("");
  const [loading, setLoading] = useState(true);

  const [status, setStatus] = useState<StatusKey | "all">(initialStatus);
  const [client, setClient] = useState<string>(initialClient ?? "all");
  const [channel, setChannel] = useState<string>("all");
  const [blocked, setBlocked] = useState<"all" | "blocked" | "clear">("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // The unified contact view (tags, tasks, deals, every message and
  // automation run) opened from a pipeline row's detail.
  const [contactView, setContactView] = useState<number | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [more, setMore] = useState(false);

  // Decision state, per row. busy blocks a double click; done and failed are
  // both shown, because a write that failed must never look like one that
  // worked (the route already returns 502 rather than a quiet ok:false).
  const [busy, setBusy] = useState<number | null>(null);
  const [done, setDone] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState<Record<number, string>>({});
  // Handover copy feedback, per row and for the whole lane. A copy that did not
  // land must say so rather than showing the same "Copied" as one that did.
  const [copied, setCopied] = useState<Record<string, string>>({});

  const copyLead = useCallback(async (key: string, text: string, okMsg: string) => {
    const ok = await copyText(text);
    setCopied((c) => ({
      ...c,
      [key]: ok ? okMsg
                : "The copy failed, so nothing reached your clipboard. Select the text by hand.",
    }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setCrmErr(""); setPipeErr("");
    const [a, b] = await Promise.allSettled([
      fetch("/api/crm?limit=2000").then((r) => r.json()),
      fetch("/api/pipeline").then(async (r) => ({ http: r.status, body: await r.json() })),
    ]);
    if (a.status === "fulfilled") {
      const p = a.value as CrmPayload;
      if (p.error) setCrmErr(p.error);
      else if (!p.configured) setCrmErr("Sonar Supabase is not configured on this deployment, so no drafted outbound can be read at all.");
      setCrm(p);
    } else {
      setCrmErr(a.reason instanceof Error ? a.reason.message : String(a.reason));
    }
    if (b.status === "fulfilled") {
      const { http, body } = b.value as { http: number; body: PipelinePayload };
      if (http !== 200 || body.error) {
        setPipeErr(body.message || body.error || `The contact book and deals could not be read (HTTP ${http}).`);
      }
      setPipe(body);
    } else {
      setPipeErr(b.reason instanceof Error ? b.reason.message : String(b.reason));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  // ── The decision write ──────────────────────────────────────────────────
  // The ONLY write this screen makes. It POSTs to /api/crm, whose POST handler
  // does a single PATCH of the outbound row's status. There is no mail client,
  // no SMTP call and no queue push anywhere on this path, so no button here can
  // transmit a message to a prospect.
  const decide = useCallback(async (id: number, action: "approve" | "skip" | "sent") => {
    setBusy(id);
    setFailed((f) => { const n = { ...f }; delete n[id]; return n; });
    try {
      const res = await fetch("/api/crm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const j = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !j?.ok) {
        setFailed((f) => ({
          ...f,
          [id]: j?.error || `The save failed (HTTP ${res.status}). This row was NOT changed.`,
        }));
        return;
      }
      const next = action === "approve" ? "approved" : action === "skip" ? "skipped" : "sent";
      const now = new Date().toISOString();
      setDone((d) => ({
        ...d,
        [id]: action === "approve" ? "Approved. Nothing was sent."
          : action === "skip" ? "Skipped."
          : "Recorded as already sent by hand.",
      }));
      setCrm((prev) => prev ? {
        ...prev,
        items: prev.items.map((x) => x.id === id ? {
          ...x,
          status: next,
          reviewedAt: action === "sent" ? x.reviewedAt : now,
          sentAt: action === "sent" ? now : x.sentAt,
        } : x),
      } : prev);
    } catch (e: unknown) {
      setFailed((f) => ({
        ...f,
        [id]: `${e instanceof Error ? e.message : String(e)}. This row was NOT changed.`,
      }));
    } finally {
      setBusy(null);
    }
  }, []);

  // ── Build every row, once ───────────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const today = todayIso();
    const out: Row[] = [];
    const policy = { available: crm?.sendPolicy?.available === true };
    const rollByClient = new Map((crm?.clients ?? []).map((c) => [c.client, c]));

    for (const it of crm?.items ?? []) {
      const roll = rollByClient.get(it.client ?? "");
      const handover = isHandover(it, policy, roll);
      const st = outboundStatus(it.status);
      const blockers = outboundBlockers(it, policy, roll, today, handover);
      out.push({
        key: `out:${it.id}`,
        type: "outbound",
        status: handover ? "client_handover" : st.key,
        statusText: handover ? "Hand to the client" : st.text,
        client: it.client ?? "no client recorded",
        channel: it.channel ?? "no channel recorded",
        title: it.subject ?? (it.body ? it.body.slice(0, 80) : "No subject or body was ever written"),
        who: it.recipient ?? it.recipientHandle,
        where: null,
        when: it.created_at,
        blockers,
        handoverNote: handover
          ? roll?.handoverReason ??
            roll?.sendPolicy?.scope_note?.replace(/\s+/g, " ").trim() ??
            `${it.client ?? "This client"} does not permit Wing to send on their behalf, so ` +
            `this lead is for them to work, not for Wing to mail.`
          : null,
        search: [it.client, it.subject, it.recipient, it.recipientHandle, it.personalization, it.channel]
          .filter(Boolean).join(" ").toLowerCase(),
        outbound: it, contact: null, deal: null,
      });
    }

    for (const c of pipe?.records?.contacts ?? []) {
      out.push({
        key: `con:${c.id}`,
        type: "contact",
        status: "contact_on_file",
        statusText: c.dealCount > 0
          ? `On file, ${c.dealCount} deal${c.dealCount === 1 ? "" : "s"}`
          : "On file, no deal yet",
        client: WING_BOOK,
        channel: NO_CHANNEL,
        title: c.name,
        who: c.person,
        where: c.where,
        when: c.updatedAt,
        blockers: contactBlockers(c),
        handoverNote: null,
        search: [c.name, c.person, c.email, c.phone, c.where, c.trade, c.source]
          .filter(Boolean).join(" ").toLowerCase(),
        outbound: null, contact: c, deal: null,
      });
    }

    for (const d of pipe?.records?.deals ?? []) {
      const key: StatusKey =
        d.status === "won" ? "deal_won" : d.status === "lost" ? "deal_lost" : "deal_open";
      out.push({
        key: `deal:${d.id}`,
        type: "deal",
        status: key,
        statusText: `${d.stageLabel ?? "no stage"} · ${money(d.valueCents)}`,
        client: WING_BOOK,
        channel: NO_CHANNEL,
        title: d.name,
        who: d.business ?? d.person,
        where: d.where,
        when: d.updatedAt,
        blockers: dealBlockers(d, today),
        handoverNote: null,
        search: [d.name, d.business, d.person, d.email, d.phone, d.where, d.stageLabel]
          .filter(Boolean).join(" ").toLowerCase(),
        outbound: null, contact: null, deal: d,
      });
    }

    out.sort((a, b) => {
      // Whatever needs a decision floats, then the handover leads, then newest
      // first inside each group.
      const rank = (r: Row) =>
        r.status === "needs_decision" ? 0 : r.status === "client_handover" ? 1 : 2;
      const dr = rank(a) - rank(b);
      if (dr !== 0) return dr;
      return Date.parse(b.when ?? "") - Date.parse(a.when ?? "") || 0;
    });
    return out;
  }, [crm, pipe]);

  // ── Facet counts, always over the WHOLE set so a chip never lies about how
  //    much is behind it just because another filter is on. ────────────────
  const counts = useMemo(() => {
    const st = {} as Record<string, number>;
    const ty = {} as Record<string, number>;
    const cl = {} as Record<string, number>;
    const ch = {} as Record<string, number>;
    let blockedN = 0;
    // The two numbers the whole screen exists to answer: how many drafts Jack
    // can act on right now, and how many are waiting on something else first.
    let readyN = 0;
    let stuckN = 0;
    for (const r of rows) {
      st[r.status] = (st[r.status] ?? 0) + 1;
      ty[r.type] = (ty[r.type] ?? 0) + 1;
      cl[r.client] = (cl[r.client] ?? 0) + 1;
      ch[r.channel] = (ch[r.channel] ?? 0) + 1;
      if (r.blockers.length) blockedN++;
      if (r.status === "needs_decision") {
        if (r.blockers.length === 0) readyN++; else stuckN++;
      }
    }
    // Counted separately and deliberately EXCLUDED from readyN/stuckN above:
    // these are not drafts Wing is deciding whether to send, so folding them
    // into "needs your decision" buries the number that headline exists for.
    const handoverN = st.client_handover ?? 0;
    return { st, ty, cl, ch, blockedN, clearN: rows.length - blockedN, readyN, stuckN, handoverN };
  }, [rows]);

  // ── The three panes ─────────────────────────────────────────────────────
  // Jack (2026-09-04): "too much going on". The Everything view is now one
  // search box and three pills: Contacts, Deals, Drafts to review. Every
  // record is still here, split by what it is; the old status, client,
  // channel and blocker facets live under "More filters" with their counts.
  // The pane is null until the first load lands, then opens on Drafts if any
  // need a decision and on Contacts otherwise. Decided once, so a pill Jack
  // picks later is never overridden.
  const [pane, setPane] = useState<Pane | null>(null);
  useEffect(() => {
    if (pane !== null || loading) return;
    if (rows.length === 0 && !crm && !pipe) return;
    if (initialStatus === "contact_on_file") { setPane("contacts"); setStatus("all"); return; }
    if (initialStatus.startsWith("deal_")) { setPane("deals"); return; }
    if (counts.st.needs_decision) { setPane("drafts"); setStatus("needs_decision"); return; }
    setPane("contacts"); setStatus("all");
  }, [pane, loading, rows.length, counts, initialStatus, crm, pipe]);

  const choosePane = (p: Pane) => {
    setPane(p);
    // Drafts opens on what needs a decision; the other panes show everything.
    setStatus(p === "drafts" ? "needs_decision" : "all");
    setChannel("all"); setBlocked("all"); setOpen(null);
  };

  const paneType: TypeKey = pane === "deals" ? "deal" : pane === "contacts" ? "contact" : "outbound";

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (r.type !== paneType) return false;
      // Handover leads live in their own collapsed section under the drafts
      // list, never in the main list.
      if (r.status === "client_handover") return false;
      // A row Jack just decided on stays put. Approving moves it out of the
      // "needs your decision" bucket, and letting it vanish mid-click left him
      // with no confirmation that anything happened at all.
      if (r.outbound && done[r.outbound.id]) return true;
      if (status !== "all" && r.status !== status) return false;
      if (client !== "all" && r.client !== client) return false;
      if (channel !== "all" && r.channel !== channel) return false;
      if (blocked === "blocked" && r.blockers.length === 0) return false;
      if (blocked === "clear" && r.blockers.length > 0) return false;
      if (needle && !r.search.includes(needle)) return false;
      return true;
    });
  }, [rows, paneType, status, client, channel, blocked, q, done]);

  // Changing the filters is Jack moving on, so the "just decided" exemption
  // above is dropped at the same moment the page size resets.
  useEffect(() => { setShown(PAGE_SIZE); setDone({}); }, [pane, status, client, channel, blocked, q]);

  // Every handover lead, in row order, for the collapsed section and its
  // lane-level copy. The search box applies here too.
  const handoverRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => r.status === "client_handover" && (!needle || r.search.includes(needle)));
  }, [rows, q]);
  // Which clients the lane covers, read off the rows themselves rather than
  // named anywhere in this file.
  const handoverClients = useMemo(
    () => Array.from(new Set(handoverRows.map((r) => r.client))).sort(),
    [handoverRows],
  );
  const [handoverOpen, setHandoverOpen] = useState(false);

  const active: string[] = [];
  if (status !== "all" && pane !== "drafts") active.push(STATUS_LABEL[status]);
  if (status !== "all" && status !== "needs_decision" && pane === "drafts") active.push(STATUS_LABEL[status]);
  if (client !== "all") active.push(client);
  if (channel !== "all") active.push(`channel ${channel}`);
  if (blocked !== "all") active.push(blocked === "blocked" ? "blocked only" : "nothing blocking only");
  if (q.trim()) active.push(`search "${q.trim()}"`);

  const clearAll = () => {
    setStatus(pane === "drafts" ? "needs_decision" : "all"); setClient("all");
    setChannel("all"); setBlocked("all"); setQ("");
  };

  const clientNames = Object.keys(counts.cl).sort((a, b) => counts.cl[b] - counts.cl[a]);
  const channelNames = Object.keys(counts.ch).filter((c) => c !== NO_CHANNEL).sort((a, b) => counts.ch[b] - counts.ch[a]);
  const statusOrder: StatusKey[] = pane === "deals"
    ? ["deal_open", "deal_won", "deal_lost"]
    : ["needs_decision", "approved", "sent", "rejected", "other_outbound"];

  // Every facet's counts survive the condensing: they moved from a chip row
  // into the option labels of the select that replaced it.
  const paneTotal = counts.ty[paneType] ?? 0;
  const statusOptions = [
    { value: "all", label: pane === "deals" ? `Every deal (${paneTotal})` : `Every draft (${paneTotal})` },
    ...statusOrder.filter((s) => counts.st[s]).map((s) => ({
      value: s, label: `${STATUS_LABEL[s]} (${counts.st[s]})`,
    })),
  ];
  const clientOptions = [
    { value: "all", label: `Every client (${rows.length})` },
    ...clientNames.map((c) => ({ value: c, label: `${c} (${counts.cl[c]})` })),
  ];
  const channelOptions = [
    { value: "all", label: "Every channel" },
    ...channelNames.map((c) => ({ value: c, label: `${c} (${counts.ch[c]})` })),
  ];
  const blockedOptions = [
    { value: "all", label: "Blocked and clear" },
    { value: "blocked", label: `Something is blocking it (${counts.blockedN})` },
    { value: "clear", label: `Nothing blocking it (${counts.clearN})` },
  ];
  const hiddenFacets =
    (client !== "all" ? 1 : 0) + (channel !== "all" ? 1 : 0) + (blocked !== "all" ? 1 : 0)
    + (pane === "deals" && status !== "all" ? 1 : 0)
    + (pane === "drafts" && status !== "needs_decision" ? 1 : 0);

  const needsN = counts.st.needs_decision ?? 0;
  const pills: { id: Pane; label: string; count: number }[] = [
    { id: "contacts", label: "Contacts", count: counts.ty.contact ?? 0 },
    { id: "deals", label: "Deals", count: counts.ty.deal ?? 0 },
    { id: "drafts", label: "Drafts to review", count: needsN },
  ];

  // ── Add contact ─────────────────────────────────────────────────────────
  // The one create on this screen. POST /api/pipeline/contacts, the same
  // route the pipeline used; business name is the only required field, and
  // the new contact opens in the full contact view once it exists.
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [addForm, setAddForm] = useState({ business_name: "", contact_name: "", email: "", phone: "", city: "", state: "" });
  const addField = (k: keyof typeof addForm, v: string) => setAddForm((f) => ({ ...f, [k]: v }));
  const submitAdd = async () => {
    if (!addForm.business_name.trim()) { setAddErr("Give the business a name first."); return; }
    setAddBusy(true); setAddErr("");
    try {
      const res = await fetch("/api/pipeline/contacts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: addForm.business_name.trim(),
          contact_name: addForm.contact_name.trim() || null,
          email: addForm.email.trim() || null,
          phone: addForm.phone.trim() || null,
          city: addForm.city.trim() || null,
          state: addForm.state.trim() || null,
        }),
      });
      const j = await res.json().catch(() => null) as { ok?: boolean; error?: string; message?: string; contact?: { id: number } } | null;
      if (!res.ok || !j?.ok) {
        setAddErr(j?.message || j?.error || `The contact was not saved (HTTP ${res.status}).`);
        return;
      }
      setAddForm({ business_name: "", contact_name: "", email: "", phone: "", city: "", state: "" });
      setAddOpen(false);
      await load();
      setPane("contacts");
      if (j.contact?.id) setContactView(j.contact.id);
    } catch (e) {
      setAddErr(`${e instanceof Error ? e.message : String(e)}. The contact was not saved.`);
    } finally {
      setAddBusy(false);
    }
  };

  // ── The decision controls for one row ───────────────────────────────────
  // A ready draft gets ONE filled button. A blocked draft gets no approve at
  // all, because approving it would be a decision made on a row that cannot
  // go anywhere; the blocker beside it says why, in words, already.
  const rowActions = (r: Row, big: boolean) => {
    const it = r.outbound;
    if (!it) return null;
    const id = it.id;
    const isBusy = busy === id;
    const ready = r.status === "needs_decision" && r.blockers.length === 0;
    const note: React.CSSProperties = {
      fontSize: 11, lineHeight: 1.45, fontWeight: 600,
      textAlign: big ? "left" : "right", maxWidth: big ? "100%" : 190,
      whiteSpace: "normal",
    };

    // The handover lane gets its own single action. No approve button appears
    // here at all: approving would record a decision about sending a message
    // Wing is never going to send.
    if (r.status === "client_handover") {
      return (
        <div style={{
          display: "flex", gap: 7, flexWrap: "wrap",
          justifyContent: big ? "flex-start" : "flex-end", alignItems: "center",
        }}>
          <QuietButton
            label="Copy lead to hand over"
            tone="var(--accent-2)"
            onClick={() => {
              void copyLead(r.key, handoverText(r), "Lead copied. Paste it to the client.");
            }}
          />
          {copied[r.key] && (
            <span style={{
              ...note,
              color: copied[r.key].startsWith("The copy failed") ? "var(--red)" : "var(--green)",
            }}>
              {copied[r.key]}
            </span>
          )}
          {big && r.handoverNote && (
            <span style={{ ...note, fontWeight: 500, color: "var(--text-muted)" }}>
              {r.handoverNote}
            </span>
          )}
        </div>
      );
    }

    return (
      <div style={{
        display: "flex", gap: 7, flexWrap: "wrap",
        justifyContent: big ? "flex-start" : "flex-end", alignItems: "center",
      }}>
        {ready && (
          <PrimaryButton label="Approve draft" busy={isBusy} onClick={() => { void decide(id, "approve"); }} />
        )}
        {r.status === "needs_decision" && !ready && big && (
          <span style={{ ...note, color: "var(--red)" }}>
            Not approvable yet. Clear the blocker first.
          </span>
        )}
        {r.status === "needs_decision" && (
          <QuietButton label="Skip" busy={isBusy} onClick={() => { void decide(id, "skip"); }} />
        )}
        {r.status === "approved" && big && (
          <span style={{ ...note, color: "var(--green)" }}>
            Approved and not sent. Grant sends it.
          </span>
        )}
        {r.status === "approved" && big && (
          <QuietButton
            label="Record it as already sent by hand"
            busy={isBusy}
            onClick={() => { void decide(id, "sent"); }}
          />
        )}
        {done[id] && (
          <span style={{ ...note, color: "var(--green)" }}>{done[id]}</span>
        )}
        {failed[id] && (
          <span style={{ ...note, color: "var(--red)" }}>{failed[id]}</span>
        )}
      </div>
    );
  };

  // ── One compact row ─────────────────────────────────────────────────────
  // One line on desktop: name, one-line context, status, date, action. Two
  // lines on a phone (the .crm-row rules below). A contact opens the full
  // contact view; a deal opens its detail; a draft opens the draft detail
  // with the same approve flow as before.
  const openRow = (r: Row) => {
    if (r.contact) { setContactView(r.contact.id); return; }
    setOpen(open === r.key ? null : r.key);
  };
  const contextOf = (r: Row): string => {
    if (r.outbound) {
      const bits = [r.who ?? "no contact recorded", r.client];
      if (r.channel && r.channel !== NO_CHANNEL && r.channel !== "no channel recorded") bits.push(r.channel);
      return bits.join(" · ");
    }
    if (r.contact) {
      const c = r.contact;
      return [r.who ?? "no person named", r.where, c.trade].filter(Boolean).join(" · ");
    }
    return [r.who ?? "no business recorded", r.where].filter(Boolean).join(" · ");
  };
  const renderRow = (r: Row) => {
    const isOpen = open === r.key;
    const n = r.blockers.length;
    return (
      <div key={r.key} style={{ display: "grid", gap: 8 }}>
        <div
          className="crm-row"
          role="button"
          tabIndex={0}
          title={TYPE_LABEL[r.type]}
          onClick={() => openRow(r)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRow(r); }
          }}
          style={{
            border: `1px solid ${isOpen ? "var(--accent)" : "var(--border)"}`,
            borderLeft: `3px solid ${STATUS_COLOR[r.status]}`,
            borderRadius: 10, padding: "8px 12px", cursor: "pointer",
            background: "var(--bg-card)",
          }}
        >
          <div className="crm-row-main">
            <span className="crm-row-title">{r.title}</span>
            <span className="crm-row-ctx">{contextOf(r)}</span>
          </div>
          <div className="crm-row-meta">
            {n > 0 && (
              <span
                title={r.blockers.map((b) => `${b.label}: ${b.detail}`).join("\n\n")}
                style={{
                  fontSize: 10.5, fontWeight: 700, color: "var(--red)",
                  border: "1px solid var(--red)", borderRadius: 6, padding: "1px 7px",
                  whiteSpace: "nowrap",
                }}
              >
                {n === 1 ? r.blockers[0].label : `${n} things blocking it`}
              </span>
            )}
            <span style={{ fontSize: 11.5, fontWeight: 700, color: STATUS_COLOR[r.status], whiteSpace: "nowrap" }}>
              {r.statusText}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {when(r.when)}
            </span>
            {rowActions(r, false)}
          </div>
        </div>

        {isOpen && (r.outbound
          ? <CrmRowDetail
              it={toDetail(r.outbound)}
              onClose={() => setOpen(null)}
              actions={
                <div style={{ display: "grid", gap: 7 }}>
                  {r.blockers.length > 0 && (
                    <div style={{ display: "grid", gap: 4 }}>
                      <span style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-muted)", fontWeight: 700 }}>
                        What is blocking it
                      </span>
                      <BlockerCell blockers={r.blockers} />
                    </div>
                  )}
                  {rowActions(r, true)}
                  <span style={{ fontSize: 11, lineHeight: 1.5, color: "var(--text-muted)" }}>
                    {r.status === "client_handover" ? HANDOVER_NOTE : NO_SEND_NOTE}
                  </span>
                </div>
              }
            />
          : <PipelineDetail row={r} onClose={() => setOpen(null)} onViewContact={setContactView} />)}
      </div>
    );
  };

  const inputStyle: React.CSSProperties = {
    minWidth: 0, padding: "7px 12px", borderRadius: 9,
    border: "1px solid var(--border)",
    background: "var(--bg-secondary)", color: "var(--text-primary)", fontSize: 12.5,
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <style>{`
        .crm-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 6px 14px; align-items: center; }
        .crm-row-main { display: flex; gap: 10px; min-width: 0; align-items: baseline; }
        .crm-row-title { font-size: 13.5px; font-weight: 650; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; max-width: 60%; }
        .crm-row-ctx { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 0; min-width: 0; }
        .crm-row-meta { display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex-wrap: nowrap; }
        .crm-pane-pill { padding: 7px 14px; border-radius: 999px; font-size: 12.5px; cursor: pointer; background: transparent; white-space: nowrap; }
        @media (max-width: 768px) {
          .crm-row { grid-template-columns: minmax(0,1fr); gap: 5px; }
          .crm-row-main { flex-direction: column; gap: 1px; align-items: stretch; }
          .crm-row-title, .crm-row-ctx { max-width: 100%; flex: none; }
          .crm-row-meta { justify-content: flex-start; flex-wrap: wrap; gap: 6px 10px; }
        }
      `}</style>

      {/* ── Header: search, add, refresh ─────────────────────────────────── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
          CRM
        </h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search any name, company, subject or note"
          aria-label="Search the CRM"
          style={{
            ...inputStyle, flex: "1 1 240px",
            border: `1px solid ${q.trim() ? "var(--accent)" : "var(--border)"}`,
          }}
        />
        <button
          type="button"
          onClick={() => { setAddOpen((o) => !o); setAddErr(""); }}
          aria-expanded={addOpen}
          style={{
            padding: "7px 15px", borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
            border: "1px solid var(--accent)", background: addOpen ? "var(--accent-glow)" : "transparent",
            color: "var(--accent)", whiteSpace: "nowrap",
          }}
        >
          {addOpen ? "Close" : "Add contact"}
        </button>
        <button
          type="button"
          onClick={() => { void load(); }}
          style={{ ...chipBase, border: "1px solid var(--border)", color: "var(--text-muted)" }}
        >
          {loading ? "Loading" : "Refresh"}
        </button>
      </div>

      {addOpen && (
        <div style={{
          border: "1px solid var(--accent)", borderRadius: 12, padding: "12px 14px",
          background: "var(--bg-card)", display: "grid", gap: 10,
        }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>New contact</div>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
            <input value={addForm.business_name} onChange={(e) => addField("business_name", e.target.value)} placeholder="Business name (required)" style={inputStyle} />
            <input value={addForm.contact_name} onChange={(e) => addField("contact_name", e.target.value)} placeholder="Person" style={inputStyle} />
            <input value={addForm.email} onChange={(e) => addField("email", e.target.value)} placeholder="Email" type="email" style={inputStyle} />
            <input value={addForm.phone} onChange={(e) => addField("phone", e.target.value)} placeholder="Phone" type="tel" style={inputStyle} />
            <input value={addForm.city} onChange={(e) => addField("city", e.target.value)} placeholder="City" style={inputStyle} />
            <input value={addForm.state} onChange={(e) => addField("state", e.target.value)} placeholder="State" style={inputStyle} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <PrimaryButton label="Save contact" busy={addBusy} onClick={() => { void submitAdd(); }} />
            <QuietButton label="Cancel" onClick={() => { setAddOpen(false); setAddErr(""); }} />
            {addErr && <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--red)" }}>{addErr}</span>}
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Saving adds the contact to Wing&rsquo;s own book. It does not send anything.
            </span>
          </div>
        </div>
      )}

      {/* ── What could not be read. Never silent. ───────────────────────── */}
      {crmErr && (
        <Note tone="var(--red)" text={`Drafted outbound could not be read: ${crmErr} Nothing below includes it.`} />
      )}
      {pipeErr && (
        <Note tone="var(--red)" text={`The contact book and deals could not be read: ${pipeErr} Their records are missing from the list below; this is a failure, not an empty CRM.`} />
      )}
      {crm?.itemsMeta?.capped && crm.itemsMeta.note && <Note text={crm.itemsMeta.note} />}
      {crm?.scan && !crm.scan.complete && crm.scan.note && <Note text={crm.scan.note} />}
      {pipe?.contactsMeta && !pipe.contactsMeta.complete && pipe.contactsMeta.note && (
        <Note text={pipe.contactsMeta.note} />
      )}
      {crm && crm.sendPolicy?.available === false && (
        <Note text={
          `The send-policy table could not be read (${crm.sendPolicy.reason ?? "no reason given"}), so ` +
          `no row below can show whether its client permits Wing to send. Absence of that blocker ` +
          `here does not mean permission exists.`
        } />
      )}

      {/* ── The three pills + filters ────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {pills.map((p) => {
          const on = pane === p.id;
          return (
            <button
              key={p.id}
              type="button"
              className="crm-pane-pill"
              onClick={() => choosePane(p.id)}
              aria-pressed={on}
              style={{
                fontWeight: on ? 700 : 500,
                border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                background: on ? "var(--accent-glow)" : "transparent",
                color: on ? "var(--accent)" : "var(--text-secondary)",
              }}
            >
              {p.label}
              <span style={{ marginLeft: 6, fontWeight: 700, color: on ? "var(--accent)" : "var(--text-muted)" }}>
                {loading && rows.length === 0 ? "" : p.count.toLocaleString("en-US")}
              </span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setMore((m) => !m)}
          aria-expanded={more}
          style={{
            marginLeft: "auto", padding: "7px 13px", borderRadius: 9, fontSize: 12.5, cursor: "pointer",
            border: `1px solid ${hiddenFacets > 0 ? "var(--accent)" : "var(--border)"}`,
            color: hiddenFacets > 0 ? "var(--accent)" : "var(--text-muted)",
            fontWeight: hiddenFacets > 0 ? 700 : 500,
            background: "var(--bg-secondary)", whiteSpace: "nowrap",
          }}
        >
          {more ? "Fewer filters" : "More filters"}
          {hiddenFacets > 0 && !more ? ` (${hiddenFacets} on)` : ""}
        </button>
      </div>

      {more && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 12, padding: "12px 14px",
          background: "var(--bg-card)", display: "grid", gap: 10,
        }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
            {pane !== "contacts" && (
              <Select name={pane === "deals" ? "Deal status" : "Draft status"} value={status} options={statusOptions} wide
                      onChange={(v) => setStatus(v as StatusKey | "all")} />
            )}
            <Select name="Client" value={client} options={clientOptions} wide onChange={setClient} />
            {pane === "drafts" && (
              <Select name="Channel" value={channel} options={channelOptions} onChange={setChannel} />
            )}
            <Select name="Blockers" value={blocked} options={blockedOptions} wide
                    onChange={(v) => setBlocked(v as "all" | "blocked" | "clear")} />
            {active.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                style={{
                  padding: "7px 13px", borderRadius: 9, fontSize: 12.5, cursor: "pointer",
                  border: "1px solid var(--accent)", color: "var(--accent)",
                  fontWeight: 700, background: "var(--bg-secondary)", whiteSpace: "nowrap",
                }}
              >
                Clear all filters
              </button>
            )}
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}>
          Showing: {active.join(" · ")}
          <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>
            {"  "}({filtered.length} of {paneTotal} {pane === "deals" ? "deals" : pane === "contacts" ? "contacts" : "drafts"})
          </span>
        </div>
      )}

      {/* ── Drafts: the one-line status ──────────────────────────────────── */}
      {pane === "drafts" && !loading && (
        <div style={{ display: "grid", gap: 3 }}>
          <div style={{
            fontSize: 14, fontWeight: 700,
            color: counts.readyN > 0 ? "var(--green)" : "var(--text-secondary)",
          }}>
            {needsN === 0
              ? "No draft needs a decision."
              : `${needsN} draft${needsN === 1 ? " needs" : "s need"} your decision` +
                (counts.readyN > 0 ? `, ${counts.readyN} ready to approve` : "") +
                (counts.stuckN > 0 ? `, ${counts.stuckN} blocked` : "") + "."}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{NO_SEND_NOTE}</div>
        </div>
      )}

      {/* ── The list ─────────────────────────────────────────────────────── */}
      {/* rowActions is a plain JSX helper rather than a nested component, so the
          buttons are not remounted (and their busy state lost) on every render. */}
      {loading && rows.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading every CRM record</div>
      ) : pane === null ? null : filtered.length === 0 ? (
        <div style={{
          border: "1px dashed var(--border)", borderRadius: 12, padding: 18,
          fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6,
        }}>
          {rows.length === 0 ? (
            "No CRM records were returned at all. That is not the same as an empty CRM: read the errors above before treating this as nothing to do."
          ) : paneTotal === 0 ? (
            pane === "contacts" ? "No contacts are on file yet. Add one with the button above."
              : pane === "deals" ? "No deals are on file yet. Open a contact to start one."
              : "No drafts have been written yet."
          ) : pane === "drafts" && status === "needs_decision" && active.length === 0 ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>
                Nothing is waiting on you. The {paneTotal.toLocaleString("en-US")} drafts on file were all
                already approved, sent or skipped.
              </span>
              <button
                type="button"
                onClick={() => setStatus("all")}
                style={{
                  padding: "6px 12px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid var(--accent)", background: "transparent",
                  color: "var(--accent)", fontSize: 12.5, fontWeight: 600,
                }}
              >
                Show every draft
              </button>
            </span>
          ) : (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span>
                Nothing matches these filters. Clear them to see all {paneTotal.toLocaleString("en-US")}{" "}
                {pane === "deals" ? "deals" : pane === "contacts" ? "contacts" : "drafts"}.
              </span>
              <button
                type="button"
                onClick={clearAll}
                style={{
                  padding: "6px 12px", borderRadius: 8, cursor: "pointer",
                  border: "1px solid var(--accent)", background: "transparent",
                  color: "var(--accent)", fontSize: 12.5, fontWeight: 600,
                }}
              >
                Clear filters
              </button>
            </span>
          )}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {filtered.length} {pane === "deals" ? "deal" : pane === "contacts" ? "contact" : "draft"}{filtered.length === 1 ? "" : "s"}
            {filtered.length > shown ? `, showing the first ${shown}` : ""}
          </div>

          {filtered.slice(0, shown).map(renderRow)}

          {filtered.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE_SIZE)}
              style={{
                ...chipBase, justifySelf: "start",
                border: "1px solid var(--border)", color: "var(--text-secondary)",
              }}
            >
              Show {Math.min(PAGE_SIZE, filtered.length - shown)} more
            </button>
          )}
        </div>
      )}

      {/* ── Handover leads, collapsed under the drafts list ───────────────
             These drafts are working exactly as intended: the client's
             contract says Wing does not send for them, so the output is a lead
             to hand over, not outbound waiting on a decision. Counted out of
             the status line above on purpose. Nothing is hidden and the
             drafter keeps producing them. */}
      {pane === "drafts" && !loading && (
        <div style={{
          border: `1px solid ${handoverOpen ? "var(--accent-2)" : "var(--border)"}`, borderRadius: 12,
          background: "var(--bg-card)", display: "grid", gap: 10, padding: "10px 14px",
        }}>
          <button
            type="button"
            onClick={() => setHandoverOpen((o) => !o)}
            aria-expanded={handoverOpen}
            style={{
              background: "transparent", border: "none", padding: 0, cursor: "pointer",
              textAlign: "left", fontSize: 13, fontWeight: 700, color: "var(--accent-2)",
              display: "flex", gap: 8, alignItems: "center", minHeight: 0,
            }}
          >
            <span aria-hidden="true">{handoverOpen ? "▾" : "▸"}</span>
            Leads for clients who do not allow sending ({counts.handoverN})
          </button>
          {handoverOpen && (
            counts.handoverN === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                None right now.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {handoverClients.length === 1
                    ? `${handoverClients[0]} does not permit Wing to send on their behalf, so these are `
                    : `${handoverClients.join(", ")} do not permit Wing to send on their behalf, so these are `}
                  leads to pass over, not outbound Wing is deciding whether to mail. Nothing here will ever be sent from this screen.
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <QuietButton
                    label={`Copy all ${handoverRows.length}`}
                    tone="var(--accent-2)"
                    onClick={() => {
                      void copyLead(
                        "__lane__",
                        handoverRows.map(handoverText).join("\n\n----------------\n\n"),
                        `All ${handoverRows.length} leads copied. Paste them to the client.`,
                      );
                    }}
                  />
                  {copied.__lane__ && (
                    <span style={{
                      fontSize: 11.5, fontWeight: 600,
                      color: copied.__lane__.startsWith("The copy failed") ? "var(--red)" : "var(--green)",
                    }}>
                      {copied.__lane__}
                    </span>
                  )}
                </div>
                {handoverRows.length === 0 && q.trim() && (
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
                    None match the search. Clear it to see all {counts.handoverN}.
                  </div>
                )}
                <div style={{ display: "grid", gap: 6 }}>
                  {handoverRows.map(renderRow)}
                </div>
              </>
            )
          )}
        </div>
      )}

      {contactView !== null && (
        <ContactDetail contactId={contactView} onClose={() => setContactView(null)} />
      )}
    </div>
  );
}
