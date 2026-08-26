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
    const m = /^\$?\s*(\d[\d,]*)(?:\.(\d{1,2}))?$/.exec(fAmount.trim());
    if (!m) return setFormErr("Amount must look like 1250 or 1250.00");
    const amount_cents =
      Number(m[1].replace(/,/g, "")) * 100 + Number((m[2] || "").padEnd(2, "0"));
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

  // ── 3-month payment calendar ─────────────────────────────────────────────
  // Buckets every upcoming payment onto its due date, then lays out three real
  // month grids starting with the current month.
  const months = useMemo(() => {
    const byDate: Record<string, Upcoming[]> = {};
    for (const u of data?.upcoming || []) (byDate[u.due_on] ||= []).push(u);

    const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
    return [0, 1, 2].map((offset) => {
      const total0 = ty * 12 + (tm - 1) + offset;
      const y = Math.floor(total0 / 12);
      const m1 = (total0 % 12) + 1;
      const firstDow = new Date(Date.UTC(y, m1 - 1, 1)).getUTCDay();
      const days = new Date(Date.UTC(y, m1, 0)).getUTCDate();
      const cells: ({ day: number; date: string; pays: Upcoming[] } | null)[] = [];
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
  }, [data?.upcoming, today]);

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

  return (
    <div style={{ display: "grid", gap: 16 }}>
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
            next 90 days · {data.upcoming.length} expected
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
                  const sum = c.pays.reduce((s, p) => s + p.amount_cents, 0);
                  return (
                    <div
                      key={i}
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
                        border: isToday ? "1px solid var(--accent)" : "1px solid transparent",
                        background: has ? "var(--accent-glow)" : "transparent",
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
                    </div>
                  );
                })}
              </div>

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
