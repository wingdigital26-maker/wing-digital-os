import { NextResponse } from "next/server";
import type { ActionType, EventType } from "@/lib/automations/types";
import {
  requireStaff,
  isAuthFailure,
  errorResponse,
  sbGet,
  sbPost,
  type WorkflowRow,
} from "../_workflows";

// POST /api/automations/seed: the starter pack. Four workflows that cover
// what GoHighLevel used to do for Wing on day one, created as DRAFTS so
// nothing runs until a human reads them and presses Activate. Idempotent by
// name: a workflow that already exists is skipped, never duplicated.
// client_slug is null on all four: these are Wing's own.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Starter = {
  name: string;
  description: string;
  trigger_type: EventType;
  trigger_filter?: Record<string, string>;
  actions: { action_type: ActionType; config: Record<string, unknown> }[];
};

const STARTER_PACK: Starter[] = [
  {
    name: "Missed call text-back",
    description: "When a tracked number rings out, text the caller right away, make a call-back task, and ping the phone.",
    trigger_type: "call.missed",
    actions: [
      {
        action_type: "send_sms",
        config: {
          body: "Hi {{first_name}}, sorry we missed your call to {{business}}. How can we help? Reply here and we will get right back to you.",
        },
      },
      { action_type: "create_task", config: { title: "Call back {{business}} (missed call)", due_in_hours: 1 } },
      { action_type: "notify_push", config: { title: "Missed call", body: "{{phone}} called and nobody answered" } },
    ],
  },
  {
    name: "New website lead",
    description: "A form comes in: open a deal, tag the contact, thank them by text, ping the phone, and set a follow-up.",
    trigger_type: "form.submitted",
    actions: [
      { action_type: "create_deal", config: { title: "Website lead: {{business}}", stage_key: "new" } },
      { action_type: "add_tag", config: { tag: "website-lead" } },
      {
        action_type: "send_sms",
        config: { body: "Hi {{first_name}}, thanks for reaching out. We got your message and will be in touch shortly." },
      },
      { action_type: "notify_push", config: { title: "New website lead", body: "{{business}} just filled out a form" } },
      { action_type: "create_task", config: { title: "Follow up with {{business}}", due_in_hours: 2 } },
    ],
  },
  {
    name: "Booking confirmation",
    description: "Someone books a call: open a deal in Booked, confirm by text, and set a prep task the day before.",
    trigger_type: "booking.created",
    actions: [
      { action_type: "create_deal", config: { title: "Call with {{business}}", stage_key: "booked" } },
      {
        action_type: "send_sms",
        config: {
          body: "Hi {{first_name}}, you are booked. We will call you at the time you picked. Reply here if anything changes.",
        },
      },
      { action_type: "create_task", config: { title: "Prep for call with {{business}}", due_in_hours: 24 } },
    ],
  },
  {
    name: "Cold call booked",
    description: "A caller marks Booked in the Call Room: open a deal in Booked, tag the contact, and ping the phone.",
    trigger_type: "call.logged",
    trigger_filter: { outcome: "booked" },
    actions: [
      { action_type: "create_deal", config: { title: "Booked from cold call: {{business}}", stage_key: "booked" } },
      { action_type: "add_tag", config: { tag: "cold-call-booked" } },
      { action_type: "notify_push", config: { title: "Call booked", body: "{{business}} booked from the Call Room" } },
    ],
  },
];

export async function POST() {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;
  try {
    const existing = await sbGet<Pick<WorkflowRow, "name">>("workflows", "name");
    const have = new Set(existing.map((w) => w.name.trim().toLowerCase()));
    const created: string[] = [];
    const skipped: string[] = [];
    for (const s of STARTER_PACK) {
      if (have.has(s.name.toLowerCase())) {
        skipped.push(s.name);
        continue;
      }
      const wf = await sbPost<WorkflowRow>("workflows", {
        name: s.name,
        description: s.description,
        client_slug: null,
        status: "draft",
        trigger_type: s.trigger_type,
        trigger_filter: s.trigger_filter ?? {},
      });
      for (let i = 0; i < s.actions.length; i++) {
        await sbPost("workflow_actions", {
          workflow_id: wf.id,
          step_order: i + 1,
          action_type: s.actions[i].action_type,
          config: s.actions[i].config,
        });
      }
      created.push(s.name);
    }
    return NextResponse.json({ created, skipped });
  } catch (e) {
    return errorResponse(e);
  }
}
