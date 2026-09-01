import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  errorResponse,
  sbGet,
  sbPost,
  type SequenceRow,
} from "../_lib";

// ───────────────────────────────────────────────────────────────────────────
// POST /api/sequences/seed — one-click import of the current cold email
// cadence. Staff only, idempotent: if ANY sequence already exists it does
// nothing and says so, so clicking Seed twice can never duplicate.
//
// The three emails below are a faithful port of the B2B D1/D3/D7 templates in
// app/api/messaging/route.ts (itself a port of wing-outreach-cloud/
// daily_outreach.py, ported 2026-08-31). Only the placeholder syntax changed:
// the sender's {greeting} became "Hi {{first_name}}," and {company} became
// {{company}}, matching the merge tags sequence_steps documents. The words
// are otherwise verbatim. Once seeded, THESE rows are the source of truth and
// edits happen in the sequence editor, not in code.
//
// The sequence is created as a DRAFT. Seeding sends nothing, schedules
// nothing, enrolls no one.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const D1_BODY =
  "Hi {{first_name}},\n\n" +
  "I am Jack with Wing Digital. We build the growth engine for local businesses: lead " +
  "generation, custom software, SEO and AEO to get you found in Google and in AI answers.\n\n" +
  "For an operation like {{company}}, the math is different. One new commercial account can be " +
  "worth more than a year of small jobs, so we focus on two things: getting you in front of " +
  "the companies already searching for what you do, then building the systems that turn those " +
  "inquiries into signed contracts.\n\n" +
  "That means qualified leads coming in steadily, custom tools that handle your follow-up, and " +
  "a presence that makes a serious business trust you with a contract.\n\n" +
  "Would you be open to a quick 10 to 15 minute call this week? Whatever day works for you " +
  "works for me. Just reply and I will make it happen.\n\nThanks,\nJack";

const D3_BODY =
  "Hi {{first_name}},\n\n" +
  "Following up on my note from earlier this week.\n\n" +
  "The businesses winning the best commercial accounts in DFW are usually not the biggest. " +
  "They are the ones a buyer finds first, the ones that answer fast, the ones with systems " +
  "doing the follow-up so nothing slips. That is a visibility problem, a lead gen problem, a " +
  "software problem, all fixable.\n\n" +
  "For {{company}}, we build the whole stack: SEO and AEO so you show up first in search, lead " +
  "gen that keeps qualified inquiries coming in, custom tools that follow up for you. Open to " +
  "a quick call to walk through it? Name any day that works and I will fit your schedule." +
  "\n\nThanks,\nJack";

const D7_BODY =
  "Hi {{first_name}},\n\n" +
  "I have reached out a couple of times now so I will keep this short.\n\n" +
  "One commercial contract can carry a whole year. The businesses that keep landing them are " +
  "easy to find, quick to respond, backed by systems that never drop a lead. That is exactly " +
  "what we build: lead generation, custom software, SEO and AEO, all working together.\n\n" +
  "If you want to see what that looks like for {{company}}, reply with any day that works and I " +
  "will be there. If not, no worries at all, and I wish you a strong rest of the year." +
  "\n\nThanks,\nJack";

// Day 1 / Day 3 / Day 7 cadence expressed as waits AFTER the previous send:
// step 1 fires on enrollment, step 2 fires 2 days later, step 3 fires 4 days
// after that.
const STEPS = [
  { wait_days: 0, subject: "quick idea for {{company}}", body: D1_BODY },
  { wait_days: 2, subject: "a couple things on {{company}}", body: D3_BODY },
  { wait_days: 4, subject: "last note on {{company}}", body: D7_BODY },
];

export async function POST() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const existing = await sbGet<Pick<SequenceRow, "id" | "name">>("sequences", "id,name", "limit=1");
    if (existing.length) {
      return NextResponse.json({
        seeded: false,
        reason: `Sequences already exist (e.g. "${existing[0].name}"), so nothing was imported. Delete every sequence first if you truly want to re-seed.`,
      });
    }

    const sequence = await sbPost<SequenceRow>("sequences", {
      name: "Wing B2B Cold Outreach",
      client_slug: null,
      status: "draft",
      description:
        "The D1/D3/D7 B2B cold email cadence, imported from the hardcoded sender templates. " +
        "Created as a draft: review the copy, then Activate when the sender should see it.",
    });

    for (let i = 0; i < STEPS.length; i++) {
      await sbPost("sequence_steps", {
        sequence_id: sequence.id,
        step_order: i + 1,
        channel: "email",
        ...STEPS[i],
      });
    }

    return NextResponse.json({ seeded: true, sequence_id: sequence.id, steps: STEPS.length }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
