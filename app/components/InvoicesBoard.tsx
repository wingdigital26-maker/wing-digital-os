"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// Invoices — a month calendar of money: what Wing has billed, what is still
// owed, and which day each payment lands on.
//
// Reads /api/invoices (Sonar Supabase), so it works PC-off. Amounts are CENTS
// as integers everywhere; they are only turned into a dollar string at render
// time and no arithmetic is ever done on the formatted value. Nothing on this
// board sends anything — no PDF, no email. It records and tracks.

type Recurring = "monthly" | "quarterly" | "annual";

type Invoice = {
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
  notes: string | null;
  created_at: string;
};

type Upcoming = {
  id: number;
  client: string;
  invoice_no: string;
  amount_cents: number;
  currency: string;
  recurring: Recurring;
  due_on: string;
};

// A chip drawn on a calendar day: which invoice, what kind of money event,
// and which colour edge marks that kind (paid / due / overdue / upcoming).
type Chip = {
  id: number;
  key: string;
  label: "Paid" | "Due" | "Overdue" | "Upcoming";
  edge: string;
  amount_cents: number;
  currency: string;
  client: string;
  invoice_no: string;
  status: string;
};

type Payload = {
  configured: boolean;
  // Set when the book is configured but could not be READ (2026-09-22). The
  // distinction matters on this screen more than anywhere else in the OS: an
  // unreadable ledger and a ledger with nothing in it are the same picture if
  // you draw $0.00 for both, and one of them is a lie about money.
  unavailable?: boolean;
  error?: string;
  items: Invoice[];
  clients: string[];
  totals: {
    outstanding_cents: number;
    paid_this_month_cents: number;
    overdue_count: number;
    next_payment?: Upcoming | null;
  };
  upcoming: Upcoming[];
  today?: string;
  // Last date the API's `upcoming` list covers, and how many month grids that
  // window is worth. The board draws exactly this many months so the header
  // count and the cells always describe the same window.
  horizon?: string;
  calendar_months?: number;
};

const STATUS_COLOR: Record<string, string> = {
  draft: "var(--text-muted)",
  sent: "var(--accent)",
  paid: "var(--green)",
  overdue: "var(--red)",
  void: "var(--text-muted)",
};

const RECURRING_LABEL: Record<Recurring, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  annual: "Annual",
};

const num: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };

// Cents → "$1,250.00". Integer division only; the fractional part is built from
// the remainder, so no float ever touches a money value.
function money(cents: number, currency = "USD"): string {
  const n = Number.isFinite(cents) ? Math.round(cents) : 0;
  const neg = n < 0;
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  const sym = currency === "USD" ? "$" : `${currency} `;
  return `${neg ? "-" : ""}${sym}${whole.toLocaleString("en-US")}.${String(frac).padStart(2, "0")}`;
}

function todayISO(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(
    n.getDate()
  ).padStart(2, "0")}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 26px filled circle marking today's date number, used in both grid views.
const todayCircle: React.CSSProperties = {
  width: 26, height: 26, borderRadius: "50%", background: "var(--accent)",
  color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center",
  fontSize: 12, fontWeight: 700, flexShrink: 0,
};

// Pretty date from a plain YYYY-MM-DD, without going through Date (which would
// reinterpret it as UTC and can render the day before).
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${MONTHS[Number(m[2]) - 1].slice(0, 3)} ${Number(m[3])}, ${m[1]}`;
}

function iso(y: number, m1: number, d: number): string {
  return `${y}-${String(m1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * A typed dollar string → whole cents, as an integer.
 *
 * Parsed straight out of the digits the user typed: the whole part is
 * multiplied by 100 (integer × integer) and the two fraction digits are added
 * on. No float is ever built and then scaled, so "1250.75" is exactly 125075
 * and never 125074.99999999999. Returns null if the text isn't money.
 */
function dollarsToCents(text: string): number | null {
  const m = /^\$?\s*(\d[\d,]*)(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  if (!Number.isSafeInteger(whole)) return null;
  const frac = Number((m[2] || "0").padEnd(2, "0"));
  return whole * 100 + frac;
}

export default function InvoicesBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState("");
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [fClient, setFClient] = useState("");
  const [fAmount, setFAmount] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fDue, setFDue] = useState("");
  const [fRecurring, setFRecurring] = useState<"" | Recurring>("");
  const [formErr, setFormErr] = useState("");

  // Which month the calendar is showing, as an offset from the current one.
  // 2026-09-22 (Jack): "make the invoices a calendar". It was three cramped
  // read-only minis under a row of tiles; now it is one month you navigate,
  // so the horizon is however far you care to look rather than a fixed three.
  const [monthOffset, setMonthOffset] = useState(0);

  // Month grid vs. a single scrollable week. "Today" resets whichever offset
  // the active view is using; switching views keeps each view's own place.
  const [view, setView] = useState<"month" | "week">("month");
  const [weekOffset, setWeekOffset] = useState(0);

  // ── Day panel state ──────────────────────────────────────────────────────
  // The open day is a plain YYYY-MM-DD string, so it identifies a calendar day
  // and never a timezone-shifted instant.
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [dClient, setDClient] = useState("");
  const [dNewClient, setDNewClient] = useState("");
  const [dAmount, setDAmount] = useState("");
  const [dDesc, setDDesc] = useState("");
  const [dRecurring, setDRecurring] = useState<"" | Recurring>("");
  const [dErr, setDErr] = useState("");
  const [dBusy, setDBusy] = useState(false);

  // CRM client names for the day-panel picker. Purely a convenience: if the
  // call fails we simply show the free-text field, never a blocked form.
  const [crmClients, setCrmClients] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    fetch("/api/crm")
      .then((r) => r.json())
      .then((d: { clients?: { client?: string }[] }) => {
        if (!live || !Array.isArray(d?.clients)) return;
        const names = d.clients
          .map((c) => (typeof c?.client === "string" ? c.client.trim() : ""))
          .filter(Boolean);
        setCrmClients(Array.from(new Set(names)).sort());
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (clientFilter) qs.set("client", clientFilter);
    if (statusFilter) qs.set("status", statusFilter);
    fetch(`/api/invoices?${qs}`)
      .then((r) => r.json())
      .then((d: Payload) => {
        setData(d);
        setErr(d.error || "");
      })
      .catch((e) => setErr(String(e)));
  }, [clientFilter, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const today = data?.today || todayISO();

  async function act(id: number, action: "sent" | "paid" | "void") {
    setBusy(id);
    await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    }).catch(() => {});
    setBusy(null);
    load();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormErr("");
    const client = fClient.trim();
    if (!client) return setFormErr("Client is required.");
    // Dollars → cents as an integer, parsed from the typed string so we never
    // multiply a float by 100 and land on 1249.9999.
    const amount_cents = dollarsToCents(fAmount);
    if (amount_cents === null) return setFormErr("Amount must look like 1250 or 1250.00");
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        client,
        amount_cents,
        description: fDesc.trim() || null,
        due_on: fDue || null,
        recurring: fRecurring || null,
      }),
    })
      .then((r) => r.json())
      .catch((e) => ({ ok: false, error: String(e) }));
    if (!res.ok) return setFormErr(String(res.error || "Create failed."));
    setFClient("");
    setFAmount("");
    setFDesc("");
    setFDue("");
    setFRecurring("");
    setShowForm(false);
    load();
  }

  // ── Day panel ────────────────────────────────────────────────────────────
  function toggleDay(date: string) {
    setDErr("");
    setOpenDay((cur) => {
      if (cur === date) return null;
      // A fresh day starts with a clean form; nothing carries over from the
      // last day the user peeked at.
      setDClient("");
      setDNewClient("");
      setDAmount("");
      setDDesc("");
      setDRecurring("");
      return date;
    });
  }

  // Every invoice that touches a given calendar day: either it is due then, or
  // its recurring schedule expects the next payment then. Real rows only —
  // an empty day stays empty.
  const byDay = useMemo(() => {
    const g: Record<string, Invoice[]> = {};
    for (const it of data?.items || []) {
      const dates = new Set<string>();
      if (it.due_on) dates.add(it.due_on.slice(0, 10));
      if (it.next_due_on) dates.add(it.next_due_on.slice(0, 10));
      for (const d of dates) (g[d] ||= []).push(it);
    }
    return g;
  }, [data?.items]);

  // Every chip the calendar draws, bucketed by the day it belongs on. Paid
  // invoices land on paid_on ("Paid", green), unpaid ones on due_on ("Due", or
  // "Overdue" once due_on is behind today), and live recurring schedules land
  // on their next_due_on ("Upcoming"). Deduped by invoice id + day so a
  // recurring row that is both due today and upcoming today never draws twice.
  const dayChips = useMemo(() => {
    const map: Record<string, Chip[]> = {};
    const seen = new Set<string>();
    const add = (date: string, chip: Omit<Chip, "key">) => {
      const key = `${chip.id}:${date}`;
      if (seen.has(key)) return;
      seen.add(key);
      (map[date] ||= []).push({ ...chip, key });
    };
    for (const it of data?.items || []) {
      if (it.status === "void") continue;
      if (it.status === "paid" && it.paid_on) {
        add(it.paid_on.slice(0, 10), {
          id: it.id, label: "Paid", edge: "var(--green)",
          amount_cents: it.amount_cents, currency: it.currency || "USD",
          client: it.client, invoice_no: it.invoice_no, status: it.status,
        });
      } else if (it.due_on) {
        const date = it.due_on.slice(0, 10);
        const overdue = date < today;
        add(date, {
          id: it.id, label: overdue ? "Overdue" : "Due", edge: overdue ? "var(--red)" : "var(--accent)",
          amount_cents: it.amount_cents, currency: it.currency || "USD",
          client: it.client, invoice_no: it.invoice_no, status: it.status,
        });
      }
    }
    for (const u of data?.upcoming || []) {
      add(u.due_on.slice(0, 10), {
        id: u.id, label: "Upcoming", edge: "var(--accent-2)",
        amount_cents: u.amount_cents, currency: u.currency,
        client: u.client, invoice_no: u.invoice_no, status: "upcoming",
      });
    }
    return map;
  }, [data?.items, data?.upcoming, today]);

  // Records a payment on the clicked day through the SAME create action the
  // main form uses. This never sends anything to anyone — it writes a row.
  async function createOnDay(e: React.FormEvent) {
    e.preventDefault();
    if (!openDay) return;
    setDErr("");
    // The select carries the name unless the user chose "+ New client"; when
    // there is no client list at all the free-text box is the only input, so it
    // wins whenever the select is empty.
    const client = (dClient && dClient !== "__new__" ? dClient : dNewClient).trim();
    if (!client) return setDErr("Pick a client or type a new one.");
    const amount_cents = dollarsToCents(dAmount);
    if (amount_cents === null) return setDErr("Amount must look like 1250 or 1250.75");
    if (amount_cents <= 0) return setDErr("Amount must be more than zero.");
    setDBusy(true);
    const res = await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create",
        client,
        amount_cents,
        description: dDesc.trim() || null,
        due_on: openDay,
        recurring: dRecurring || null,
      }),
    })
      .then((r) => r.json())
      .catch((err) => ({ ok: false, error: String(err) }));
    setDBusy(false);
    if (!res.ok) return setDErr(String(res.error || "Could not record that payment."));
    setDAmount("");
    setDDesc("");
    setDRecurring("");
    setDNewClient("");
    load();
  }

  async function actOnDay(id: number, action: "sent" | "paid") {
    setDBusy(true);
    await fetch("/api/invoices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    }).catch(() => {});
    setDBusy(false);
    load();
  }

  // ── Payment calendar ─────────────────────────────────────────────────────
  // A real Google-Calendar-style month grid for the offset month: full weeks,
  // padded with the tail of the previous month and the head of the next so
  // every row has 7 days, exactly like a normal calendar.
  const month = useMemo(() => {
    const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    const total0 = ty * 12 + (tm - 1) + monthOffset;
    const y = Math.floor(total0 / 12);
    const m1 = (total0 % 12) + 1;
    const prevTotal0 = total0 - 1;
    const py = Math.floor(prevTotal0 / 12);
    const pm1 = (prevTotal0 % 12) + 1;
    const nextTotal0 = total0 + 1;
    const ny = Math.floor(nextTotal0 / 12);
    const nm1 = (nextTotal0 % 12) + 1;

    const firstDow = new Date(Date.UTC(y, m1 - 1, 1)).getUTCDay();
    const daysInThis = new Date(Date.UTC(y, m1, 0)).getUTCDate();
    const daysInPrev = new Date(Date.UTC(y, m1 - 1, 0)).getUTCDate();
    const leading = firstDow;
    const totalCells = Math.ceil((leading + daysInThis) / 7) * 7;
    const trailing = totalCells - leading - daysInThis;

    const cells: { day: number; date: string; inMonth: boolean }[] = [];
    for (let i = 0; i < leading; i++) {
      const day = daysInPrev - leading + 1 + i;
      cells.push({ day, date: iso(py, pm1, day), inMonth: false });
    }
    for (let d = 1; d <= daysInThis; d++) cells.push({ day: d, date: iso(y, m1, d), inMonth: true });
    for (let i = 1; i <= trailing; i++) cells.push({ day: i, date: iso(ny, nm1, i), inMonth: false });

    const monthTotal = cells.reduce((sum, c) => {
      if (!c.inMonth) return sum;
      const chips = dayChips[c.date] || [];
      return sum + chips.reduce((s, p) => s + p.amount_cents, 0);
    }, 0);

    return { y, m1, cells, monthTotal, current: monthOffset === 0 };
  }, [dayChips, today, monthOffset]);

  // The single week shown in week view: 7 days starting Sunday, stepped by
  // `weekOffset` weeks from the week that contains today.
  const weekCells = useMemo(() => {
    const [ty, tm, td] = [Number(today.slice(0, 4)), Number(today.slice(5, 7)), Number(today.slice(8, 10))];
    const base = Date.UTC(ty, tm - 1, td);
    const dow = new Date(base).getUTCDay();
    const sunday = base - dow * 86400000 + weekOffset * 7 * 86400000;
    const cells: { day: number; date: string; month: number; year: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sunday + i * 86400000);
      cells.push({ day: d.getUTCDate(), date: iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), month: d.getUTCMonth() + 1, year: d.getUTCFullYear() });
    }
    return cells;
  }, [today, weekOffset]);

  const grouped = useMemo(() => {
    const g: Record<string, Invoice[]> = {};
    for (const it of data?.items || []) (g[it.client] ||= []).push(it);
    return Object.entries(g)
      .map(([client, list]) => ({
        client,
        list: list.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
        owed: list
          .filter((i) => i.status === "sent" || i.status === "overdue")
          .reduce((s, i) => s + i.amount_cents, 0),
      }))
      .sort((a, b) => b.owed - a.owed || a.client.localeCompare(b.client));
  }, [data?.items]);

  if (!data) {
    return (
      <div style={{ display: "grid", gap: 14 }} aria-label="Loading invoices">
        <div className="skel" style={{ height: 92, borderRadius: 14 }} />
        <div className="skel" style={{ height: 300, borderRadius: 14 }} />
      </div>
    );
  }
  // The calendar always renders — a missing/unconfigured/errored book just
  // means an empty grid with one explanatory line above it, never a screen
  // with nothing to navigate.
  const bannerMsg = !data.configured
    ? "Invoices are not configured: SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are missing."
    : data.unavailable
    ? data.error || "The invoice database did not answer. Nothing here is known to be zero."
    : "";

  const t = data.totals;
  const next = t.next_payment;

  const weekTotal = weekCells.reduce(
    (s, c) => s + (dayChips[c.date] || []).reduce((ss, p) => ss + p.amount_cents, 0),
    0
  );
  const headerTotal = view === "month" ? month.monthTotal : weekTotal;

  let headerTitle: string;
  if (view === "month") {
    headerTitle = `${MONTHS[month.m1 - 1]} ${month.y}`;
  } else {
    const first = weekCells[0];
    const last = weekCells[6];
    if (first.year !== last.year) {
      headerTitle = `${MONTHS[first.month - 1]} ${first.day}, ${first.year} – ${MONTHS[last.month - 1]} ${last.day}, ${last.year}`;
    } else if (first.month !== last.month) {
      headerTitle = `${MONTHS[first.month - 1]} ${first.day} – ${MONTHS[last.month - 1]} ${last.day}, ${first.year}`;
    } else {
      headerTitle = `${MONTHS[first.month - 1]} ${first.day}–${last.day}, ${first.year}`;
    }
  }
  const isCurrent = view === "month" ? month.current : weekOffset === 0;

  return (
    <div
      style={{ display: "grid", gap: 16 }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && openDay) setOpenDay(null);
      }}
    >
      {/* Keyboard focus must be visible on the day buttons — they are the only
          way into the day panel without a mouse. */}
      <style>{`
        .day-cell:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .day-cell:hover {
          background: var(--bg-hover) !important;
        }
        .day-chips { display: grid; gap: 3px; }
        .day-count-badge { display: none; }
        @media (max-width: 600px) {
          .day-chips { display: none; }
          .day-count-badge {
            display: inline-flex; align-items: center; justify-content: center;
            min-width: 16px; height: 16px; padding: 0 4px; border-radius: 999px;
            background: var(--accent-glow); color: var(--accent); font-size: 9px; font-weight: 700;
          }
        }
      `}</style>
      {err && !bannerMsg ? <p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>Invoices: {err}</p> : null}

      {/* ── The calendar ──────────────────────────────────────────────────
          2026-09-22 (Jack): "make the invoices a calendar". It leads now, at
          full width, one month at a time, with each payment drawn ON its day
          as a readable chip instead of a dot you had to hover to decode. The
          summary tiles moved below it: they are the footnote, the month is
          the screen. Clicking any day still opens the same day panel, so a
          payment gets recorded where you are already looking. */}
      <section className="v2-card" style={card}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <h3 className="v2-h" style={{ margin: 0, fontSize: 22 }}>{headerTitle}</h3>
          <span style={{ ...num, fontSize: 13, fontWeight: 700, color: headerTotal ? "var(--green)" : "var(--text-muted)" }}>
            {headerTotal ? money(headerTotal) : "nothing expected"}
          </span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <div className="v2-pills" role="tablist" aria-label="Calendar view">
              <button type="button" role="tab" aria-selected={view === "month"} onClick={() => setView("month")}>
                Month
              </button>
              <button type="button" role="tab" aria-selected={view === "week"} onClick={() => setView("week")}>
                Week
              </button>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => { setOpenDay(null); view === "month" ? setMonthOffset((o) => o - 1) : setWeekOffset((o) => o - 1); }}
                style={navBtn}
                aria-label={view === "month" ? "Previous month" : "Previous week"}
              >
                &#8249;
              </button>
              <button
                type="button"
                onClick={() => { setOpenDay(null); setMonthOffset(0); setWeekOffset(0); }}
                style={{ ...navBtn, width: "auto", padding: "0 12px", opacity: isCurrent ? 0.45 : 1 }}
                disabled={isCurrent}
                aria-label="Back to today"
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => { setOpenDay(null); view === "month" ? setMonthOffset((o) => o + 1) : setWeekOffset((o) => o + 1); }}
                style={navBtn}
                aria-label={view === "month" ? "Next month" : "Next week"}
              >
                &#8250;
              </button>
            </div>
          </div>
        </header>

        {bannerMsg ? (
          <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-secondary)" }}>{bannerMsg}</p>
        ) : null}

        {view === "month" ? (
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: "var(--border)" }}>
              {DOW_ABBR.map((d) => (
                <div key={d} style={{ background: "var(--bg-card)", padding: "6px 4px", fontSize: 11, fontWeight: 700, textAlign: "center", color: "var(--text-muted)" }}>
                  {d}
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: "var(--border)" }}>
              {month.cells.map((c, i) => {
                const chips = dayChips[c.date] || [];
                const isToday = c.inMonth && c.date === today;
                const isOpen = c.inMonth && openDay === c.date;
                if (!c.inMonth) {
                  return (
                    <div key={i} style={{ background: "var(--bg-card)", minHeight: 116, padding: 6, opacity: 0.45 }}>
                      <span style={{ ...num, fontSize: 12, color: "var(--text-muted)" }}>{c.day}</span>
                    </div>
                  );
                }
                const shown = chips.slice(0, 3);
                const rest = chips.length - shown.length;
                return (
                  <button
                    key={i}
                    type="button"
                    className="day-cell"
                    aria-expanded={isOpen}
                    aria-label={
                      chips.length
                        ? `${shortDate(c.date)}, ${chips.length} payment${chips.length === 1 ? "" : "s"}`
                        : `${shortDate(c.date)}, no payments, add one`
                    }
                    onClick={() => toggleDay(c.date)}
                    style={{
                      minHeight: 116, padding: 6, textAlign: "left", minWidth: 0,
                      cursor: "pointer", font: "inherit", display: "flex",
                      flexDirection: "column", gap: 3, alignItems: "stretch", overflow: "hidden", border: "none",
                      background: isOpen ? "var(--bg-hover)" : "var(--bg-card)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 4 }}>
                      {isToday ? (
                        <span style={todayCircle}>{c.day}</span>
                      ) : (
                        <span style={{ ...num, fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>{c.day}</span>
                      )}
                      <span className="day-count-badge">{chips.length || ""}</span>
                    </div>
                    <div className="day-chips">
                      {shown.map((chip) => (
                        <div
                          key={chip.key}
                          title={`${chip.label}: ${money(chip.amount_cents, chip.currency)} ${chip.client}`}
                          aria-label={`${chip.label}, ${money(chip.amount_cents, chip.currency)}, ${chip.client}`}
                          style={{
                            borderRadius: 6, padding: "2px 5px", borderLeft: `3px solid ${chip.edge}`,
                            background: `color-mix(in srgb, ${chip.edge} 12%, var(--bg-card))`,
                            fontSize: 10, lineHeight: 1.3, color: "var(--text-primary)",
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}
                        >
                          <span style={{ ...num, fontWeight: 700 }}>{money(chip.amount_cents, chip.currency)}</span> {chip.client}
                        </div>
                      ))}
                      {rest > 0 ? (
                        <span style={{ fontSize: 10, color: "var(--text-muted)", paddingLeft: 2 }}>+{rest} more</span>
                      ) : null}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, background: "var(--border)", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {weekCells.map((c, wi) => {
              const chips = dayChips[c.date] || [];
              const isToday = c.date === today;
              const isOpen = openDay === c.date;
              return (
                <button
                  key={c.date}
                  type="button"
                  className="day-cell"
                  aria-expanded={isOpen}
                  aria-label={
                    chips.length
                      ? `${shortDate(c.date)}, ${chips.length} payment${chips.length === 1 ? "" : "s"}`
                      : `${shortDate(c.date)}, no payments, add one`
                  }
                  onClick={() => toggleDay(c.date)}
                  style={{
                    minHeight: 280, minWidth: 0, padding: 8, textAlign: "left", cursor: "pointer", font: "inherit",
                    display: "flex", flexDirection: "column", gap: 8, alignItems: "stretch", overflow: "hidden", border: "none",
                    background: isOpen ? "var(--bg-hover)" : "var(--bg-card)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)" }}>{DOW_ABBR[wi]}</span>
                    <span className="day-count-badge">{chips.length || ""}</span>
                  </div>
                  {isToday ? (
                    <span style={todayCircle}>{c.day}</span>
                  ) : (
                    <span style={{ ...num, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{c.day}</span>
                  )}
                  <div className="day-chips">
                    {chips.length === 0 ? (
                      <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Nothing scheduled</span>
                    ) : null}
                    {chips.map((chip) => (
                      <div
                        key={chip.key}
                        title={`${chip.label}: ${money(chip.amount_cents, chip.currency)} ${chip.client}`}
                        style={{
                          borderRadius: 6, padding: "4px 6px", borderLeft: `3px solid ${chip.edge}`,
                          background: `color-mix(in srgb, ${chip.edge} 12%, var(--bg-card))`,
                          display: "grid", gap: 3, overflow: "hidden",
                        }}
                      >
                        <span style={{ ...num, fontSize: 11, fontWeight: 700, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {money(chip.amount_cents, chip.currency)} {chip.client}
                        </span>
                        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span
                            className="v2-status"
                            style={{ fontSize: 9, padding: "2px 7px", color: chip.edge, background: `color-mix(in srgb, ${chip.edge} 12%, var(--bg-card))` }}
                          >
                            {chip.label}
                          </span>
                          <span style={{ ...num, fontSize: 10, color: "var(--text-muted)" }}>{chip.invoice_no}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* Day panel, full width under whichever grid it belongs to. */}
        {openDay ? (
          <div style={{ marginTop: 12 }}>
            <DayPanel
              date={openDay}
              invoices={byDay[openDay] || []}
              clients={crmClients.length ? crmClients : data.clients}
              busy={dBusy}
              err={dErr}
              today={today}
              client={dClient}
              newClient={dNewClient}
              amount={dAmount}
              desc={dDesc}
              recurring={dRecurring}
              onClient={setDClient}
              onNewClient={setDNewClient}
              onAmount={setDAmount}
              onDesc={setDDesc}
              onRecurring={setDRecurring}
              onSubmit={createOnDay}
              onAct={actOnDay}
              onClose={() => setOpenDay(null)}
            />
          </div>
        ) : null}
      </section>

      {/* Summary tiles — the footnote under the month, not the headline. */}
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
        }}
      >
        <Tile label="Outstanding" value={money(t.outstanding_cents)} tone="var(--text-primary)" />
        <Tile label="Paid this month" value={money(t.paid_this_month_cents)} tone="var(--green)" />
        <Tile
          label="Overdue"
          value={String(t.overdue_count)}
          sub={t.overdue_count === 1 ? "invoice past due" : "invoices past due"}
          tone={t.overdue_count ? "var(--red)" : "var(--text-primary)"}
        />
        <Tile
          label="Next payment due"
          value={next ? shortDate(next.due_on) : "none"}
          sub={next ? `${next.client} · ${money(next.amount_cents, next.currency)}` : "no recurring schedule"}
          tone={next ? "var(--accent)" : "var(--text-muted)"}
        />
      </div>

      {/* Filters + create */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} style={input}>
          <option value="">All clients</option>
          {data.clients.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={input}>
          <option value="">All statuses</option>
          {["draft", "sent", "paid", "overdue", "void"].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <button type="button" onClick={() => setShowForm((v) => !v)} style={btnPrimary}>
          {showForm ? "Cancel" : "New invoice"}
        </button>
      </div>

      {showForm ? (
        <form onSubmit={create} className="v2-card" style={{ ...card, display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
            <label style={lbl}>
              Client
              <input value={fClient} onChange={(e) => setFClient(e.target.value)} style={input} placeholder="Hero's Junk Removal" />
            </label>
            <label style={lbl}>
              Amount (USD)
              <input value={fAmount} onChange={(e) => setFAmount(e.target.value)} style={{ ...input, ...num }} placeholder="2500.00" inputMode="decimal" />
            </label>
            <label style={lbl}>
              Due date
              <input type="date" value={fDue} onChange={(e) => setFDue(e.target.value)} style={{ ...input, ...num }} />
            </label>
            <label style={lbl}>
              Recurring
              <select value={fRecurring} onChange={(e) => setFRecurring(e.target.value as "" | Recurring)} style={input}>
                <option value="">One-off</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annual">Annual</option>
              </select>
            </label>
          </div>
          <label style={lbl}>
            Description
            <input value={fDesc} onChange={(e) => setFDesc(e.target.value)} style={input} placeholder="SEO retainer" />
          </label>
          {formErr ? <p style={{ margin: 0, color: "var(--red)", fontSize: 12 }}>{formErr}</p> : null}
          <div>
            <button type="submit" style={btnPrimary}>Create invoice</button>
          </div>
        </form>
      ) : null}

      {/* Invoice list, grouped by client */}
      {grouped.length === 0 ? (
        <div className="v2-card" style={card}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>No invoices yet.</p>
        </div>
      ) : null}

      {grouped.map((g) => (
        <section key={g.client} className="v2-card" style={card}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 14, color: "var(--text-primary)" }}>{g.client}</h3>
            <span style={{ ...num, fontSize: 12, color: g.owed ? "var(--orange)" : "var(--text-muted)" }}>
              {g.owed ? `${money(g.owed)} owed` : "nothing owed"}
            </span>
          </header>

          <div style={{ display: "grid", gap: 8 }}>
            {g.list.map((it) => {
              const overdue =
                it.status === "overdue" || (it.status === "sent" && it.due_on && it.due_on < today);
              return (
                <div
                  key={it.id}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: 10,
                    background: "var(--bg-secondary)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ ...num, fontSize: 12, color: "var(--text-muted)" }}>{it.invoice_no}</span>
                    <span
                      className="v2-status"
                      style={{
                        color: overdue ? "var(--red)" : STATUS_COLOR[it.status] || "var(--text-secondary)",
                        background: `color-mix(in srgb, ${overdue ? "var(--red)" : STATUS_COLOR[it.status] || "var(--text-secondary)"} 12%, var(--bg-card))`,
                      }}
                    >
                      {overdue ? "overdue" : it.status}
                    </span>
                    {it.recurring ? (
                      <span style={{ fontSize: 11, color: "var(--accent)" }}>
                        {RECURRING_LABEL[it.recurring]}
                      </span>
                    ) : null}
                    <span style={{ ...num, marginLeft: "auto", fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
                      {money(it.amount_cents, it.currency || "USD")}
                    </span>
                  </div>

                  {it.description ? (
                    <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>{it.description}</p>
                  ) : null}

                  <div style={{ ...num, display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
                    <span>Issued {shortDate(it.issued_on)}</span>
                    <span>Due {shortDate(it.due_on)}</span>
                    {it.paid_on ? <span>Paid {shortDate(it.paid_on)}</span> : null}
                    {it.next_due_on ? <span>Next {shortDate(it.next_due_on)}</span> : null}
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      disabled={busy === it.id || it.status === "sent" || it.status === "void"}
                      onClick={() => act(it.id, "sent")}
                      style={btn}
                    >
                      Mark sent
                    </button>
                    <button
                      type="button"
                      disabled={busy === it.id || it.status === "paid" || it.status === "void"}
                      onClick={() => act(it.id, "paid")}
                      style={btn}
                    >
                      Mark paid
                    </button>
                    <button
                      type="button"
                      disabled={busy === it.id || it.status === "void"}
                      onClick={() => act(it.id, "void")}
                      style={btn}
                    >
                      Void
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * The panel that opens under a clicked calendar day.
 *
 * Left half is the truth about that date — every invoice actually due or
 * scheduled then, with inline mark-sent / mark-paid. Right half records a new
 * payment on that same date. Nothing here sends anything; "record" writes a
 * row through the normal create action.
 */
function DayPanel(props: {
  date: string;
  invoices: Invoice[];
  clients: string[];
  busy: boolean;
  err: string;
  today: string;
  client: string;
  newClient: string;
  amount: string;
  desc: string;
  recurring: "" | Recurring;
  onClient: (v: string) => void;
  onNewClient: (v: string) => void;
  onAmount: (v: string) => void;
  onDesc: (v: string) => void;
  onRecurring: (v: "" | Recurring) => void;
  onSubmit: (e: React.FormEvent) => void;
  onAct: (id: number, action: "sent" | "paid") => void;
  onClose: () => void;
}) {
  const live = props.invoices.filter((i) => i.status !== "void");
  const total = live.reduce((s, i) => s + i.amount_cents, 0);
  return (
    <div
      role="group"
      aria-label={`Payments on ${shortDate(props.date)}`}
      style={{
        marginTop: 10,
        border: "1px solid var(--accent)",
        borderRadius: 10,
        background: "var(--bg-card)",
        padding: 10,
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <strong style={{ ...num, fontSize: 12, color: "var(--text-primary)" }}>
          {shortDate(props.date)}
        </strong>
        <span style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ ...num, fontSize: 11, color: total ? "var(--green)" : "var(--text-muted)" }}>
            {total ? money(total) : "nothing scheduled"}
          </span>
          <button type="button" onClick={props.onClose} style={{ ...btn, padding: "2px 7px", fontSize: 11 }}>
            Close
          </button>
        </span>
      </div>

      {/* What already exists on this date. Empty stays empty. */}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {live.length === 0 ? (
          <li style={{ fontSize: 11, color: "var(--text-muted)" }}>No payments on this day.</li>
        ) : null}
        {live.map((it) => (
          <li
            key={it.id}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              background: "var(--bg-secondary)",
              padding: 8,
              display: "grid",
              gap: 4,
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-primary)" }}>{it.client}</span>
              <span
                className="v2-status"
                style={{
                  fontSize: 10,
                  color: STATUS_COLOR[it.status] || "var(--text-secondary)",
                  background: `color-mix(in srgb, ${STATUS_COLOR[it.status] || "var(--text-secondary)"} 12%, var(--bg-card))`,
                }}
              >
                {it.status}
              </span>
              {it.recurring ? (
                <span style={{ fontSize: 10, color: "var(--accent)" }}>{RECURRING_LABEL[it.recurring]}</span>
              ) : null}
              <span style={{ ...num, marginLeft: "auto", fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
                {money(it.amount_cents, it.currency || "USD")}
              </span>
            </div>
            <div style={{ ...num, fontSize: 10, color: "var(--text-muted)" }}>
              {it.invoice_no}
              {it.description ? ` · ${it.description}` : ""}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                type="button"
                disabled={props.busy || it.status === "sent" || it.status === "paid"}
                onClick={() => props.onAct(it.id, "sent")}
                style={{ ...btn, padding: "3px 8px", fontSize: 11 }}
              >
                Mark sent
              </button>
              <button
                type="button"
                disabled={props.busy || it.status === "paid"}
                onClick={() => props.onAct(it.id, "paid")}
                style={{ ...btn, padding: "3px 8px", fontSize: 11 }}
              >
                Mark paid
              </button>
            </div>
          </li>
        ))}
      </ul>

      {/* Record a payment on this day. */}
      <form onSubmit={props.onSubmit} style={{ display: "grid", gap: 8, borderTop: "1px solid var(--border)", paddingTop: 8 }}>
        <label style={lbl}>
          Client
          <select value={props.client} onChange={(e) => props.onClient(e.target.value)} style={{ ...input, fontSize: 12 }}>
            <option value="">Select a client…</option>
            {props.clients.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
            <option value="__new__">+ New client…</option>
          </select>
        </label>
        {props.client === "__new__" || props.clients.length === 0 ? (
          <label style={lbl}>
            New client name
            <input
              value={props.newClient}
              onChange={(e) => props.onNewClient(e.target.value)}
              style={{ ...input, fontSize: 12 }}
              placeholder="Business name"
            />
          </label>
        ) : null}
        <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))" }}>
          <label style={lbl}>
            Amount (USD)
            <input
              value={props.amount}
              onChange={(e) => props.onAmount(e.target.value)}
              style={{ ...input, ...num, fontSize: 12 }}
              placeholder="1250.00"
              inputMode="decimal"
            />
          </label>
          <label style={lbl}>
            Recurring
            <select
              value={props.recurring}
              onChange={(e) => props.onRecurring(e.target.value as "" | Recurring)}
              style={{ ...input, fontSize: 12 }}
            >
              <option value="">One-off</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="annual">Annual</option>
            </select>
          </label>
        </div>
        <label style={lbl}>
          Description
          <input
            value={props.desc}
            onChange={(e) => props.onDesc(e.target.value)}
            style={{ ...input, fontSize: 12 }}
            placeholder="SEO retainer (optional)"
          />
        </label>
        {props.err ? <p style={{ margin: 0, color: "var(--red)", fontSize: 11 }}>{props.err}</p> : null}
        <div>
          <button type="submit" disabled={props.busy} style={{ ...btnPrimary, padding: "5px 10px" }}>
            {props.busy ? "Recording…" : "Record payment"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: string }) {
  return (
    <div className="v2-card" style={{ ...card, padding: 14 }}>
      <div style={{ fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-muted)" }}>
        {label}
      </div>
      <div style={{ ...num, fontSize: 22, fontWeight: 600, color: tone, marginTop: 4 }}>{value}</div>
      {sub ? (
        <div style={{ ...num, fontSize: 11, color: "var(--text-secondary)", marginTop: 2 }}>{sub}</div>
      ) : null}
    </div>
  );
}

const card: React.CSSProperties = {
  padding: 16,
};

const input: React.CSSProperties = {
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-primary)",
  padding: "7px 10px",
  fontSize: 13,
  width: "100%",
};

const lbl: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 11,
  color: "var(--text-muted)",
};

const btn: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-secondary)",
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const btnPrimary: React.CSSProperties = {
  ...btn,
  borderColor: "var(--accent)",
  color: "var(--accent)",
};

// The month stepper. Square so the two arrows read as a pair; "Today" widens
// itself where it is used.
const navBtn: React.CSSProperties = {
  ...btn,
  width: 30,
  height: 30,
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 16,
  lineHeight: 1,
  fontFamily: "inherit",
};
