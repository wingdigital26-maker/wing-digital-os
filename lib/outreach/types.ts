// Shared shapes for the outreach review queue and the Instantly sync.
//
// TYPES ONLY. This file must never grow a runtime value: the pure mappers in
// lib/outreach/mappers.ts and lib/outreach/stats.ts import it with
// `import type`, which is what lets `node --test` run them straight from the
// .ts source (Node strips type-only imports; a runtime import would need a
// .ts extension that Next's type-check refuses).

export type QaStatus = "passed" | "failed" | "pending";
export type ApprovalStatus = "pending" | "approved" | "rejected";

/** Permanent stops never get another email. `handoff` = a human owns the thread now. */
export type StopReason =
  | "unsubscribed"
  | "negative_reply"
  | "spam_complaint"
  | "hard_bounce"
  | "handoff";

export type OutreachEventType =
  | "sent"
  | "opened"
  | "clicked"
  | "replied"
  | "auto_replied"
  | "bounced"
  | "unsubscribed"
  | "complaint"
  | "interested"
  | "not_interested"
  | "meeting_booked";

export type DraftStep = {
  step: number;
  subject: string;
  body: string;
  /** Days after the previous step (step 1 = 0). Null when the engine did not say. */
  delayDays: number | null;
  /** The research fact this email is built on (engine fact id), and its angle. */
  factId?: string | null;
  angle?: string | null;
};

export type ResearchFact = {
  id: string | null;
  kind: string | null;
  text: string;
  source: string | null;
  /** True when at least one email in the sequence cites this fact. */
  used: boolean;
};

/** One lead's drafted sequence, as the ingest writes it. */
export type DraftInput = {
  tenant: string;
  leadId: string;
  batchDate: string; // YYYY-MM-DD
  round: number;
  company: string | null;
  contactName: string | null;
  contactEmail: string | null;
  website: string | null;
  city: string | null;
  trade: string | null;
  facts: ResearchFact[];
  research: Record<string, unknown> | null;
  steps: DraftStep[];
  engineStatus: string | null;
  qaStatus: QaStatus;
  qaReasons: string[];
  /** Set only when the engine file itself says it was approved (e.g. approved in the CLI). */
  engineApproval: { approver: string | null; at: string | null } | null;
  nextRoundDue: string | null;
  /** Stop the engine itself recorded on this lead (e.g. suppressed before drafting). */
  stopReason: StopReason | null;
  /** When the engine pushed it to Instantly, per the file. */
  pushedAt: string | null;
  sourcePath: string | null;
  sourceUpdatedAt: string | null;
};

/** A draft as stored and shown on /outreach. */
export type DraftRow = DraftInput & {
  id: number;
  originalSteps: DraftStep[];
  approvalStatus: ApprovalStatus;
  approver: string | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  editedBy: string | null;
  editedAt: string | null;
  pushRequestedAt: string | null;
  pushRequestedBy: string | null;
  pushedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutreachEventInput = {
  eventType: OutreachEventType;
  occurredAt: string;
  contactEmail: string | null;
  tenant: string | null;
  campaignId: string | null;
  mailbox: string | null;
  step: number | null;
  instantlyEmailId: string | null;
  threadId: string | null;
  subject: string | null;
  bodyText: string | null;
  /** Instantly interest label in words, when the event is a reply or label. */
  interest: string | null;
  /** Stop this event puts on the lead (null = none). */
  stopReason: StopReason | null;
  source: "poll" | "webhook" | "ingest";
  dedupeKey: string;
  payload: Record<string, unknown> | null;
};

export type OutreachEventRow = OutreachEventInput & {
  id: number;
  draftId: number | null;
  leadId: string | null;
  round: number | null;
};

export type LeadRow = {
  tenant: string;
  email: string;
  leadId: string | null;
  company: string | null;
  contactName: string | null;
  currentRound: number;
  lastSentAt: string | null;
  nextRoundDue: string | null;
  stopReason: StopReason | null;
  stoppedAt: string | null;
  stopSource: string | null;
  stopDetail: string | null;
};

export type MailboxState = {
  mailbox: string;
  tenant: string | null;
  paused: boolean;
  pausedReason: string | null;
  pausedAt: string | null;
  updatedAt: string;
};

/** One row of the engine's lead_state, as the ingest mirrors it. */
export type LeadStateInput = {
  tenant: string;
  email: string;
  leadId: string | null;
  round: number | null;
  lastSentAt: string | null;
  nextRoundDue: string | null;
};

export type SuppressionInput = {
  tenant: string;
  email: string;
  reason: StopReason;
  at: string | null;
  detail: string | null;
  source: string;
};
