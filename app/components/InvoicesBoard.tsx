"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

// Invoices — what Wing has billed, what is still owed, and a 3-month payment
// calendar so Jack can see when money is expected to land.
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

// One money marker on a calendar day, whatever its source.
type DayEntry = {
  id: number;
  client: string;
  amount_cents: number;
  currency: string;
};

type Payload = {
  configured: boolean;
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
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

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
  // Buckets every upcoming payment onto its due date, then lays out one real
  // month grid per month in the API's window, starting with the current month.
  // The month count comes from the API so the grid can never be shorter than
  // the horizon the header is counting.
  const calendarMonths = Math.max(1, data?.calendar_months ?? 3);
  const months = useMemo(() => {
    // Two sources land on the same grid: the API's recurring `upcoming`
    // schedule, and the real invoice rows due on a day (which is how a one-off
    // payment recorded from the day panel shows up at all). Deduped by invoice
    // id so a recurring row present in both is never counted twice.
    const byDate: Record<string, DayEntry[]> = {};
    const seen: Record<string, Set<number>> = {};
    const push = (date: string, e: DayEntry) => {
      const ids = (seen[date] ||= new Set());
      if (ids.has(e.id)) return;
      ids.add(e.id);
      (byDate[date] ||= []).push(e);
    };
    for (const u of data?.upcoming || []) {
      push(u.due_on, { id: u.id, client: u.client, amount_cents: u.amount_cents, currency: u.currency });
    }
    for (const [date, list] of Object.entries(byDay)) {
      for (const it of list) {
        if (it.status === "void") continue;
        push(date, {
          id: it.id,
          client: it.client,
          amount_cents: it.amount_cents,
          currency: it.currency || "USD",
        });
      }
    }

    const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    return Array.from({ length: calendarMonths }, (_, offset) => {
      const total0 = ty * 12 + (tm - 1) + offset;
      const y = Math.floor(total0 / 12);
      const m1 = (total0 % 12) + 1;
      const firstDow = new Date(Date.UTC(y, m1 - 1, 1)).getUTCDay();
      const days = new Date(Date.UTC(y, m1, 0)).getUTCDate();
      const cells: ({ day: number; date: string; pays: DayEntry[] } | null)[] = [];
      for (let i = 0; i < firstDow; i++) cells.push(null);
      for (let d = 1; d <= days; d++) {
        const date = iso(y, m1, d);
        cells.push({ day: d, date, pays: byDate[date] || [] });
      }
      const monthTotal = cells.reduce(
        (sum, c) => sum + (c ? c.pays.reduce((s, p) => s + p.amount_cents, 0) : 0),
        0
      );
      return { y, m1, cells, monthTotal, current: offset === 0 };
    });
  }, [data?.upcoming, byDay, today, calendarMonths]);

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
  if (!data.configured) {
    return (
      <div style={card}>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Invoices are not configured — SONAR_SUPABASE_URL / SONAR_SUPABASE_SERVICE_KEY are missing.
        </p>
      </div>
    );
  }

  const t = data.totals;
  const next = t.next_payment;

  // Describe the window that is actually drawn below, so the "N expected" count
  // beside it can never refer to money with no cell to land in.
  const lastMonth = months[months.length - 1];
  const windowLabel = `through ${MONTHS[lastMonth.m1 - 1]} ${lastMonth.y}`;

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
      `}</style>
      {err ? <p style={{ color: "var(--red)", fontSize: 13, margin: 0 }}>Invoices: {err}</p> : null}

      {/* Summary tiles */}
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
          value={next ? shortDate(next.due_on) : "—"}
          sub={next ? `${next.client} · ${money(next.amount_cents, next.currency)}` : "no recurring schedule"}
          tone={next ? "var(--accent)" : "var(--text-muted)"}
        />
      </div>

      {/* Payment calendar */}
      <section style={card}>
        <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 14, letterSpacing: 0.3, color: "var(--text-primary)" }}>
            Payment calendar
          </h3>
          <span style={{ ...num, fontSize: 12, color: "var(--text-muted)" }}>
            {windowLabel} · {data.upcoming.length} expected
          </span>
        </header>

        <div style={{ display: "grid", gap: 14, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          {months.map((m) => (
            <div
              key={`${m.y}-${m.m1}`}
              style={{
                border: `1px solid ${m.current ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 12,
                padding: m.current ? 12 : 10,
                background: m.current ? "var(--bg-card)" : "var(--bg-secondary)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span
                  style={{
                    fontSize: m.current ? 14 : 13,
                    fontWeight: m.current ? 600 : 500,
                    color: m.current ? "var(--text-primary)" : "var(--text-secondary)",
                  }}
                >
                  {MONTHS[m.m1 - 1]} <span style={num}>{m.y}</span>
                </span>
                <span style={{ ...num, fontSize: 12, color: m.monthTotal ? "var(--green)" : "var(--text-muted)" }}>
                  {m.monthTotal ? money(m.monthTotal) : "—"}
                </span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
                {DOW.map((d, i) => (
                  <div
                    key={i}
                    style={{ ...num, fontSize: 10, textAlign: "center", color: "var(--text-muted)", paddingBottom: 2 }}
                  >
                    {d}
                  </div>
                ))}
                {m.cells.map((c, i) => {
                  if (!c) return <div key={i} />;
                  const has = c.pays.length > 0;
                  const isToday = c.date === today;
                  const isOpen = openDay === c.date;
                  const sum = c.pays.reduce((s, p) => s + p.amount_cents, 0);
                  return (
                    <button
                      key={i}
                      type="button"
                      className="day-cell"
                      aria-expanded={isOpen}
                      aria-label={
                        has
                          ? `${shortDate(c.date)} — ${money(sum)} across ${c.pays.length} payment${c.pays.length === 1 ? "" : "s"}`
                          : `${shortDate(c.date)} — no payments, add one`
                      }
                      onClick={() => toggleDay(c.date)}
                      title={
                        has
                          ? c.pays.map((p) => `${p.client} — ${money(p.amount_cents, p.currency)}`).join("\n")
                          : undefined
                      }
                      style={{
                        ...num,
                        minHeight: m.current ? 42 : 32,
                        borderRadius: 6,
                        padding: "2px 3px",
                        fontSize: 10,
                        textAlign: "left",
                        cursor: "pointer",
                        font: "inherit",
                        fontVariantNumeric: "tabular-nums",
                        border: isOpen
                          ? "1px solid var(--accent)"
                          : isToday
                          ? "1px solid var(--accent)"
                          : "1px solid transparent",
                        background: isOpen
                          ? "var(--bg-hover)"
                          : has
                          ? "var(--accent-glow)"
                          : "transparent",
                        color: "var(--text-secondary)",
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          ...num,
                          fontSize: 10,
                          color: has ? "var(--text-primary)" : "var(--text-muted)",
                          fontWeight: has || isToday ? 600 : 400,
                        }}
                      >
                        {c.day}
                      </div>
                      {has && m.current ? (
                        <div style={{ ...num, fontSize: 9, color: "var(--green)", lineHeight: 1.15 }}>
                          {money(sum)}
                        </div>
                      ) : null}
                      {has && !m.current ? (
                        <div
                          style={{
                            width: 5, height: 5, borderRadius: 99,
                            background: "var(--green)", margin: "1px auto 0",
                          }}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/* Day panel — anchored under the month whose day is open. */}
              {openDay && openDay.startsWith(`${m.y}-${String(m.m1).padStart(2, "0")}`) ? (
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
              ) : null}

              {/* The legend that makes the grid readable: who is paying, when. */}
              <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 4 }}>
                {m.cells
                  .flatMap((c) => (c ? c.pays.map((p) => ({ ...p, day: c.day })) : []))
                  .map((p) => (
                    <li
                      key={`${p.id}-${p.day}`}
                      style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11 }}
                    >
                      <span style={{ ...num, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--text-muted)" }}>{String(p.day).padStart(2, "0")}</span>{" "}
                        {p.client}
                      </span>
                      <span style={{ ...num, color: "var(--green)", flexShrink: 0 }}>
                        {money(p.amount_cents, p.currency)}
                      </span>
                    </li>
                  ))}
                {m.cells.every((c) => !c || c.pays.length === 0) ? (
                  <li style={{ fontSize: 11, color: "var(--text-muted)" }}>No payments expected</li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      </section>

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
        <form onSubmit={create} style={{ ...card, display: "grid", gap: 10 }}>
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
        <div style={card}>
          <p style={{ margin: 0, fontSize: 13, color: "var(--text-secondary)" }}>No invoices yet.</p>
        </div>
      ) : null}

      {grouped.map((g) => (
        <section key={g.client} style={card}>
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
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 99,
                        border: `1px solid ${overdue ? "var(--red)" : STATUS_COLOR[it.status] || "var(--border)"}`,
                        color: overdue ? "var(--red)" : STATUS_COLOR[it.status] || "var(--text-secondary)",
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
                style={{
                  fontSize: 10,
                  padding: "1px 7px",
                  borderRadius: 99,
                  border: `1px solid ${STATUS_COLOR[it.status] || "var(--border)"}`,
                  color: STATUS_COLOR[it.status] || "var(--text-secondary)",
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
    <div style={{ ...card, padding: 14 }}>
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
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
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
