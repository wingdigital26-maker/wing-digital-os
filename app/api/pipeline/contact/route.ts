// GET /api/pipeline/contact?id=<contact id> — everything known about one
// contact, in one response, staff only.
//
// Every list is its own query. A list whose query failed comes back as `null`
// and its name lands in `errors`, so the UI can say "messages could not be
// loaded" instead of "no messages". An empty array always means the query ran
// and genuinely found nothing.
//
// Read-only. Nothing here sends, drafts, or changes a row.
import { NextResponse } from "next/server";
import {
  requireStaff,
  isAuthFailure,
  sbGet,
  errorResponse,
  badRequest,
  esc,
} from "../_lib";
import {
  buildTimeline,
  type Activity,
  type BookingItem,
  type ContactFull,
  type ContactListName,
  type DealWithStage,
  type EnrollmentItem,
  type EventItem,
  type MessageItem,
  type RunItem,
  type SubmissionItem,
  type TagRow,
  type TaskItem,
} from "@/app/components/pipeline/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONTACT_SELECT =
  "id,business_name,contact_name,title,email,phone,website,city,state,trade," +
  "source,source_ref,verified_at,do_not_contact,dnc_reason,notes,owner_id,created_at,updated_at";

const CAPS: Record<ContactListName, number> = {
  tags: 200, tasks: 50, deals: 100, activities: 100, messages: 100,
  submissions: 20, bookings: 20, enrollments: 20, runs: 20, events: 50,
};

// Messages store E.164 phones; a contact's phone may be typed any way. Both
// forms are matched so a text to "(972) 555-1234" is found under +19725551234.
function phoneVariants(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>([raw.trim()]);
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) out.add(`+1${digits}`);
  else if (digits.length === 11 && digits.startsWith("1")) out.add(`+${digits}`);
  return Array.from(out).filter(Boolean);
}

type Settled<T> = { rows: T[] | null; error: string | null };

async function attempt<T>(fn: () => Promise<T[]>): Promise<Settled<T>> {
  try {
    const rows = await fn();
    return { rows: Array.isArray(rows) ? rows : null, error: Array.isArray(rows) ? null : "The database returned something that was not a list." };
  } catch (e) {
    return { rows: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(req: Request) {
  const auth = await requireStaff();
  if (isAuthFailure(auth)) return auth;

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return badRequest("Pass id, the contact's id.");

  let contact: ContactFull | undefined;
  try {
    contact = (await sbGet<ContactFull>("crm_contacts", CONTACT_SELECT, `id=eq.${id}`))[0];
  } catch (e) {
    return errorResponse(e);
  }
  if (!contact) {
    return NextResponse.json(
      { error: "not_found", message: `No contact with id ${id}.` },
      { status: 404 }
    );
  }

  const email = contact.email ? contact.email.trim() : null;
  const phones = phoneVariants(contact.phone);

  // messages: by contact_id, or by either address matching the contact's phone
  // or email. PostgREST `or=` takes a comma list of filters.
  const addrFilters: string[] = [`contact_id.eq.${id}`];
  for (const p of phones) {
    addrFilters.push(`to_addr.eq.${esc(p)}`, `from_addr.eq.${esc(p)}`);
  }
  if (email) {
    addrFilters.push(`to_addr.ilike.${esc(email)}`, `from_addr.ilike.${esc(email)}`);
  }

  const [tags, tasks, deals, activities, messages, submissions, bookings, enrollments, runs, events] =
    await Promise.all([
      attempt<TagRow>(() => sbGet("contact_tags", "contact_id,tag,created_at",
        `contact_id=eq.${id}&order=created_at.desc&limit=${CAPS.tags}`)),
      attempt<TaskItem>(() => sbGet("tasks", "id,contact_id,deal_id,title,body,due_at,done_at,source,created_at",
        `contact_id=eq.${id}&order=created_at.desc&limit=${CAPS.tasks}`)),
      attempt<DealWithStage>(() => sbGet("crm_deals",
        "id,title,value_cents,status,stage_id,expected_close,won_at,lost_at,lost_reason,created_at,updated_at,crm_stages(id,key,label,is_won,is_lost)",
        `contact_id=eq.${id}&order=updated_at.desc&limit=${CAPS.deals}`)),
      attempt<Activity>(() => sbGet("crm_activities", "id,contact_id,deal_id,kind,outcome,body,occurred_at,source",
        `contact_id=eq.${id}&order=occurred_at.desc&limit=${CAPS.activities}`)),
      attempt<MessageItem>(() => sbGet("messages",
        "id,contact_id,channel,direction,to_addr,from_addr,body,status,error,created_at,status_updated_at",
        `or=(${addrFilters.join(",")})&order=created_at.desc&limit=${CAPS.messages}`)),
      attempt<SubmissionItem>(() => sbGet("form_submissions", "id,form_id,data,source_url,created_at,forms(slug,name)",
        `contact_id=eq.${id}&order=created_at.desc&limit=${CAPS.submissions}`)),
      // Bookings and enrollments key on email. No email means nothing can
      // match, which is an honest empty list, not a failure.
      attempt<BookingItem>(() => email
        ? sbGet("bookings", "id,name,email,phone,starts_at,ends_at,status,source,notes,created_at",
          `email=ilike.${esc(email)}&order=starts_at.desc&limit=${CAPS.bookings}`)
        : Promise.resolve([])),
      attempt<EnrollmentItem>(() => email
        ? sbGet("sequence_enrollments", "id,sequence_id,email,current_step,status,next_send_at,enrolled_at,sequences(name)",
          `email=ilike.${esc(email)}&order=enrolled_at.desc&limit=${CAPS.enrollments}`)
        : Promise.resolve([])),
      attempt<RunItem>(() => sbGet("workflow_runs", "id,workflow_id,event_id,status,log,error,started_at,finished_at,workflows(name)",
        `contact_id=eq.${id}&order=started_at.desc&limit=${CAPS.runs}`)),
      attempt<EventItem>(() => sbGet("events", "id,type,payload,occurred_at,processed_at",
        `contact_id=eq.${id}&order=occurred_at.desc&limit=${CAPS.events}`)),
    ]);

  const lists: Record<ContactListName, Settled<unknown>> = {
    tags, tasks, deals, activities, messages, submissions, bookings, enrollments, runs, events,
  };
  const errors: { list: ContactListName; message: string }[] = [];
  const capped: Partial<Record<ContactListName, boolean>> = {};
  for (const name of Object.keys(lists) as ContactListName[]) {
    const l = lists[name];
    if (l.error) errors.push({ list: name, message: l.error });
    if (l.rows && l.rows.length >= CAPS[name]) capped[name] = true;
  }

  const timeline = buildTimeline({
    activities: activities.rows,
    messages: messages.rows,
    submissions: submissions.rows,
    bookings: bookings.rows,
    runs: runs.rows,
    events: events.rows,
  });

  return NextResponse.json({
    ok: true,
    contact,
    tags: tags.rows,
    tasks: tasks.rows,
    deals: deals.rows,
    activities: activities.rows,
    messages: messages.rows,
    submissions: submissions.rows,
    bookings: bookings.rows,
    enrollments: enrollments.rows,
    runs: runs.rows,
    events: events.rows,
    timeline,
    capped,
    errors,
  });
}
