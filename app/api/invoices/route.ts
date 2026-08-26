import { NextResponse } from "next/server";

// ───────────────────────────────────────────────────────────────────────────
// Invoices API — what Wing has billed, what is still owed, and when the next
// recurring payment lands.
//
// Backed by the Sonar Supabase project's `invoices` table (SONAR_SUPABASE_*),
// so it works with the PC off. Money is stored in CENTS as integers and is
// never converted to a float anywhere in this file. Nothing here SENDS: there
// is no PDF generation and no email. `pdf_path` is carried but unused.
// ───────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function creds() {
  return {
    url: process.env.SONAR_SUPABASE_URL,
    key: process.env.SONAR_SUPABASE_SERVICE_KEY,
  };
}

async function sb(path: string, extra: Record<string, string> = {}) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key as string, Authorization: `Bearer ${key}`, ...extra },
    cache: "no-store",
  });
}

async function sbWrite(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
  prefer = "return=representation"
) {
  const { url, key } = creds();
  return fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: key as string,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
}

export type Recurring = "monthly" | "quarterly" | "annual";
const INTERVAL_MONTHS: Record<Recurring, number> = { monthly: 1, quarterly: 3, annual: 12 };

type InvoiceRow = {
  id: number;
  client: string;
  invoice_no: string;
  amount_cents: number;
  currency: string | null;
  description: string | null;
  status: string;
  issued_on: string | null;
  due_on: string | null;
  paid_on: string | null;
  recurring: Recurring | null;
  next_due_on: string | null;
  pdf_path: string | null;
  notes: string | null;
  created_at: string;
};

const SELECT =
  "id,client,invoice_no,amount_cents,currency,description,status," +
  "issued_on,due_on,paid_on,recurring,next_due_on,pdf_path,notes,created_at";

// ── Date helpers ───────────────────────────────────────────────────────────
// Everything is a plain YYYY-MM-DD calendar date. We deliberately do the math
// on the (y, m, d) triple rather than on a Date object, because constructing a
// Date from "2026-01-31" gives a UTC instant and any local-timezone read of it
// can land on the previous day. Strings in, strings out — no drift.

function todayISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate()
  ).padStart(2, "0")}`;
}

function parseISO(d: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.slice(0, 10));
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function daysInMonth(year: number, month1: number): number {
  // Day 0 of the NEXT month is the last day of this one.
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * Add `months` calendar months to a YYYY-MM-DD date, clamping the day to the
 * end of the target month. A Jan-31 monthly invoice becomes Feb-28 (or 29 in a
 * leap year), then Mar-31 is NOT recovered — it stays on the clamped 28th.
 * That is the honest, predictable behaviour: the anniversary can only ever move
 * earlier in the month, never silently jump into the following month (which is
 * what naive Date.setMonth does: Jan 31 + 1 month = Mar 3).
 */
function addMonths(iso: string, months: number): string {
  const p = parseISO(iso);
  if (!p) return iso;
  const [y, m, d] = p;
  const totalMonth0 = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(totalMonth0 / 12);
  const nm = (totalMonth0 % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/**
 * Advance a recurring schedule past today. Normally this is one hop, but if an
 * invoice was paid late — or the row sat untouched for two cycles — a single
 * hop could still leave next_due_on in the past, which would render as a
 * permanently overdue payment on the calendar. So we keep hopping whole
 * intervals until the date is strictly in the future. The loop is bounded so a
 * bad row can never spin.
 */
function advanceRecurring(from: string, recurring: Recurring, after: string): string {
  const step = INTERVAL_MONTHS[recurring];
  let next = addMonths(from, step);
  for (let i = 0; i < 120 && next <= after; i++) next = addMonths(next, step);
  return next;
}

/**
 * The last day of the month `monthsAhead` calendar months after `iso`.
 *
 * This is the payment-calendar horizon, and it is deliberately month-aligned
 * rather than "today + N days": the board draws whole month grids, so a horizon
 * that stops mid-month would count payments in its header that have no cell to
 * live in. Header and grid must describe the same window.
 */
function endOfMonthAhead(iso: string, monthsAhead: number): string {
  const p = parseISO(iso);
  if (!p) return iso;
  const total0 = p[0] * 12 + (p[1] - 1) + monthsAhead;
  const y = Math.floor(total0 / 12);
  const m1 = (total0 % 12) + 1;
  return `${y}-${String(m1).padStart(2, "0")}-${String(daysInMonth(y, m1)).padStart(2, "0")}`;
}

// The board renders exactly this many month grids, starting with the current
// month. The API horizon is derived from it so the two can never disagree.
const CALENDAR_MONTHS = 3;

// ── Invoice numbering ──────────────────────────────────────────────────────
// WD-YYYY-NNN, sequential within the calendar year. We read the highest number
// already issued this year and add one. This is racy by nature (two creates in
// the same instant read the same max), which is exactly why invoice_no has a
// unique constraint — see POST, which retries once on a 409/23505.

async function nextInvoiceNo(year: number, bump = 0): Promise<string> {
  const prefix = `WD-${year}-`;
  const res = await sb(
    `invoices?invoice_no=like.${encodeURIComponent(prefix + "*")}` +
      `&select=invoice_no&order=invoice_no.desc&limit=1`
  );
  let max = 0;
  if (res.ok) {
    const rows = (await res.json()) as { invoice_no: string }[];
    if (rows.length) {
      const n = Number(rows[0].invoice_no.slice(prefix.length));
      if (Number.isFinite(n)) max = n;
    }
  }
  return `${prefix}${String(max + 1 + bump).padStart(3, "0")}`;
}

// ── GET ────────────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  const { url, key } = creds();
  if (!url || !key) {
    return NextResponse.json({
      configured: false,
      items: [],
      clients: [],
      totals: { outstanding_cents: 0, paid_this_month_cents: 0, overdue_count: 0 },
      upcoming: [],
    });
  }
  const { searchParams } = new URL(req.url);
  const client = searchParams.get("client") || "";
  const status = searchParams.get("status") || "";

  try {
    // One read of everything; the rollups below are cheap in memory and keep
    // the totals consistent with the list the board is showing.
    const allRes = await sb(`invoices?select=${SELECT}&order=created_at.desc&limit=5000`);
    const all = allRes.ok ? ((await allRes.json()) as InvoiceRow[]) : [];

    const today = todayISO();
    const monthStart = today.slice(0, 7) + "-01";
    const horizon = endOfMonthAhead(today, CALENDAR_MONTHS - 1);

    let outstanding_cents = 0;
    let paid_this_month_cents = 0;
    let overdue_count = 0;
    const clientSet = new Set<string>();

    for (const r of all) {
      clientSet.add(r.client);
      const amt = Number.isFinite(r.amount_cents) ? r.amount_cents : 0;
      if (r.status === "sent" || r.status === "overdue") {
        outstanding_cents += amt;
        // A "sent" invoice whose due date has passed counts as overdue even if
        // nobody has flipped its status yet — the board shouldn't need a cron.
        if (r.status === "overdue" || (r.due_on && r.due_on < today)) overdue_count++;
      }
      if (r.status === "paid" && r.paid_on && r.paid_on >= monthStart && r.paid_on <= today) {
        paid_this_month_cents += amt;
      }
    }

    // Upcoming payments: every live recurring schedule whose next_due_on falls
    // between today and the end of the last month the board draws. This is
    // exactly what the payment calendar draws — no counted-but-uncelled money.
    const upcoming = all
      .filter(
        (r) =>
          r.recurring &&
          r.next_due_on &&
          r.status !== "void" &&
          r.next_due_on >= today &&
          r.next_due_on <= horizon
      )
      .map((r) => ({
        id: r.id,
        client: r.client,
        invoice_no: r.invoice_no,
        amount_cents: r.amount_cents,
        currency: r.currency || "USD",
        recurring: r.recurring as Recurring,
        due_on: r.next_due_on as string,
      }))
      .sort((a, b) => (a.due_on < b.due_on ? -1 : a.due_on > b.due_on ? 1 : 0));

    const items = all.filter(
      (r) => (!client || r.client === client) && (!status || r.status === status)
    );

    return NextResponse.json({
      configured: true,
      items,
      clients: Array.from(clientSet).sort(),
      totals: {
        outstanding_cents,
        paid_this_month_cents,
        overdue_count,
        next_payment: upcoming[0] ?? null,
      },
      upcoming,
      today,
      // The window the `upcoming` list actually covers, so the board can label
      // its header with the truth instead of a hardcoded "90 days".
      horizon,
      calendar_months: CALENDAR_MONTHS,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      configured: true,
      error: msg,
      items: [],
      clients: [],
      totals: { outstanding_cents: 0, paid_this_month_cents: 0, overdue_count: 0 },
      upcoming: [],
    });
  }
}

// ── POST ───────────────────────────────────────────────────────────────────
// action: create | sent | paid | void | recurring | delete
// Nothing here transmits anything to anyone.
export async function POST(req: Request) {
  const { url, key } = creds();
  if (!url || !key) return NextResponse.json({ ok: false, error: "not configured" });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(b.action || "");
  const today = todayISO();

  // ── create ───────────────────────────────────────────────────────────────
  if (action === "create") {
    const client = String(b.client || "").trim();
    if (!client) return NextResponse.json({ ok: false, error: "client required" }, { status: 400 });
    // Validate the RAW value before touching it. Rounding first would make the
    // whole-number guard unfireable and would silently bill a cent nobody
    // quoted (1250.7 → 1251). Money is only ever whole cents.
    const rawAmount = Number(b.amount_cents);
    if (!Number.isInteger(rawAmount)) {
      return NextResponse.json(
        { ok: false, error: "amount_cents must be a whole number of cents (no fractions) — received " + String(b.amount_cents) },
        { status: 400 }
      );
    }
    if (rawAmount < 0) {
      return NextResponse.json({ ok: false, error: "amount_cents must not be negative" }, { status: 400 });
    }
    const amount_cents = rawAmount;
    const recurring = (["monthly", "quarterly", "annual"] as const).includes(b.recurring as Recurring)
      ? (b.recurring as Recurring)
      : null;
    const due_on = typeof b.due_on === "string" && parseISO(b.due_on) ? b.due_on.slice(0, 10) : null;
    const issued_on =
      typeof b.issued_on === "string" && parseISO(b.issued_on) ? b.issued_on.slice(0, 10) : today;

    const supplied = typeof b.invoice_no === "string" && b.invoice_no.trim() ? b.invoice_no.trim() : "";
    const year = Number(issued_on.slice(0, 4));

    // A recurring invoice's first expected payment is its own due date; the
    // schedule only starts hopping once it is marked paid.
    const base = {
      client,
      amount_cents,
      currency: typeof b.currency === "string" && b.currency ? b.currency : "USD",
      description: typeof b.description === "string" ? b.description : null,
      status: "draft",
      issued_on,
      due_on,
      recurring,
      next_due_on: recurring ? due_on : null,
      notes: typeof b.notes === "string" ? b.notes : null,
    };

    // Race handling: the max-scan above can hand the same number to two
    // concurrent creates. The unique constraint rejects the loser, so we take
    // the rejection at face value and retry exactly once with the next number.
    for (let attempt = 0; attempt < 2; attempt++) {
      const invoice_no = supplied || (await nextInvoiceNo(year, attempt));
      const res = await sbWrite(`invoices?select=${SELECT}`, "POST", { ...base, invoice_no });
      if (res.ok) {
        const rows = (await res.json()) as InvoiceRow[];
        return NextResponse.json({ ok: true, invoice: rows[0] ?? null });
      }
      const text = await res.text();
      const isDup = res.status === 409 || text.includes("23505") || text.includes("duplicate key");
      if (!isDup || supplied || attempt === 1) {
        // Never hand the raw Postgres body to the board — it renders whatever
        // it gets, and "code 23505 / constraint invoices_invoice_no_key" means
        // nothing to Jack. Name the actual conflict instead.
        const error = isDup
          ? `Invoice number ${invoice_no} already exists.`
          : `Could not create the invoice (${res.status}). Please try again.`;
        return NextResponse.json({ ok: false, error }, { status: isDup ? 409 : 400 });
      }
    }
    return NextResponse.json({ ok: false, error: "invoice_no collision" }, { status: 409 });
  }

  const id = Number(b.id);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  // Delete exists so test rows never linger in a money view.
  if (action === "delete") {
    const res = await sbWrite(`invoices?id=eq.${id}`, "DELETE", undefined, "return=minimal");
    return NextResponse.json({ ok: res.ok });
  }

  // Everything below needs the current row: paid/recurring depend on its state.
  const curRes = await sb(`invoices?id=eq.${id}&select=${SELECT}`);
  const cur = curRes.ok ? ((await curRes.json()) as InvoiceRow[])[0] : undefined;
  if (!cur) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });

  let patch: Record<string, unknown> = {};

  if (action === "sent") {
    patch = { status: "sent", issued_on: cur.issued_on || today };
  } else if (action === "void") {
    patch = { status: "void", next_due_on: null };
  } else if (action === "paid") {
    // IDEMPOTENCY. Advancing the schedule is destructive: a second "paid" would
    // hop next_due_on another whole interval and silently erase a month of
    // expected revenue. The UI disables the button, but a retried or duplicated
    // network request must be safe too. Already paid → succeed, change nothing.
    if (cur.status === "paid") {
      return NextResponse.json({ ok: true, invoice: cur, unchanged: true });
    }
    if (typeof b.paid_on === "string" && b.paid_on && !parseISO(b.paid_on)) {
      return NextResponse.json({ ok: false, error: "paid_on must be a YYYY-MM-DD date" }, { status: 400 });
    }
    const paid_on =
      typeof b.paid_on === "string" && parseISO(b.paid_on) ? b.paid_on.slice(0, 10) : today;
    // A future paid_on is money that would be recorded and then displayed
    // nowhere: "paid this month" only counts paid_on <= today. Refuse it rather
    // than swallow it.
    if (paid_on > today) {
      return NextResponse.json(
        { ok: false, error: `paid_on cannot be in the future (${paid_on} is after today, ${today}).` },
        { status: 400 }
      );
    }
    patch = { status: "paid", paid_on };
    if (cur.recurring) {
      // THE CALENDAR DRIVER. Marking a recurring invoice paid rolls its
      // schedule forward one interval from the payment we just settled. We
      // anchor on the existing next_due_on (the date that was owed) rather than
      // on paid_on, so paying five days late does not permanently shift the
      // billing anniversary. If there is no anchor, fall back to due_on, then
      // to the payment date. advanceRecurring then guarantees the result is in
      // the future even if several cycles were missed.
      const anchor = cur.next_due_on || cur.due_on || paid_on;
      patch.next_due_on = advanceRecurring(anchor, cur.recurring, today);
    }
  } else if (action === "recurring") {
    const raw = b.recurring;
    const recurring = (["monthly", "quarterly", "annual"] as const).includes(raw as Recurring)
      ? (raw as Recurring)
      : null;
    if (!recurring) {
      // Clearing it also clears the schedule, so it drops off the calendar.
      patch = { recurring: null, next_due_on: null };
    } else {
      // Setting/changing an interval re-bases the schedule on the best anchor
      // we have. Already-paid invoices hop forward from their due date; unpaid
      // ones simply expect payment on their own due date.
      const anchor = cur.next_due_on || cur.due_on || cur.issued_on || today;
      patch = {
        recurring,
        next_due_on:
          cur.status === "paid" ? advanceRecurring(anchor, recurring, today) : anchor,
      };
    }
  } else {
    return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
  }

  const res = await sbWrite(`invoices?id=eq.${id}&select=${SELECT}`, "PATCH", patch);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: await res.text() }, { status: 400 });
  }
  const rows = (await res.json()) as InvoiceRow[];
  return NextResponse.json({ ok: true, invoice: rows[0] ?? null });
}
