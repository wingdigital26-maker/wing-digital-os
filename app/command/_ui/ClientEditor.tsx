"use client";
import { useState } from "react";
import { useAct } from "./act";

type Props = {
  slug: string;
  name: string;
  meta: { plan: string | null; mrr: number | null; crm_url: string | null; next_action: string | null; is_roofer: boolean; roofer_contact: string | null; roofer_phone: string | null };
  billing: { status: string; amount: number | null; due_date: string | null; note: string | null } | null;
};

export default function ClientEditor({ slug, name, meta, billing }: Props) {
  const m = useAct();
  const b = useAct();
  const [f, setF] = useState({
    plan: meta.plan ?? "",
    mrr: meta.mrr != null ? String(meta.mrr) : "",
    crm_url: meta.crm_url ?? "",
    next_action: meta.next_action ?? "",
    is_roofer: meta.is_roofer,
    roofer_contact: meta.roofer_contact ?? "",
    roofer_phone: meta.roofer_phone ?? "",
  });
  const [bill, setBill] = useState({
    status: billing?.status ?? "due",
    amount: billing?.amount != null ? String(billing.amount) : "",
    due_date: billing?.due_date ?? "",
    note: billing?.note ?? "",
  });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  return (
    <div className="cc-grid two">
      <form
        className="cc-card cc-form"
        onSubmit={(e) => {
          e.preventDefault();
          m.run("/api/command/clients", "PATCH", { slug, display_name: null, ...f, active: true }, "Saved.");
        }}
      >
        <h3>Team notes</h3>
        <label className="cc-field">Next action<input className="cc-input" value={f.next_action} onChange={set("next_action")} placeholder="What happens next for this client" /></label>
        <div className="cc-grid two">
          <label className="cc-field">Plan<input className="cc-input" value={f.plan} onChange={set("plan")} placeholder="e.g. Roof Command Pro" /></label>
          <label className="cc-field">MRR ($/mo)<input className="cc-input" inputMode="decimal" value={f.mrr} onChange={set("mrr")} /></label>
        </div>
        <label className="cc-field">CRM or app link<input className="cc-input" type="url" value={f.crm_url} onChange={set("crm_url")} placeholder="https://" /></label>
        <label className="cc-field" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="checkbox" checked={f.is_roofer} onChange={set("is_roofer")} style={{ width: 22, height: 22 }} /> Roofer (gets a weekly check-in)
        </label>
        <div className="cc-grid two">
          <label className="cc-field">Main contact<input className="cc-input" value={f.roofer_contact} onChange={set("roofer_contact")} /></label>
          <label className="cc-field">Contact phone<input className="cc-input" type="tel" value={f.roofer_phone} onChange={set("roofer_phone")} /></label>
        </div>
        <button className="cc-btn primary" disabled={m.busy}>Save notes</button>
        {m.msg ? <p className={`cc-msg ${m.msg.ok ? "ok" : "err"}`}>{m.msg.text}</p> : null}
      </form>

      <form
        className="cc-card cc-form"
        onSubmit={(e) => {
          e.preventDefault();
          b.run("/api/command/billing", "POST", { client_key: slug, ...bill }, "Billing saved.");
        }}
      >
        <h3>Billing for {name}</h3>
        <p className="cc-muted" style={{ marginTop: 0 }}>Set by hand for now. Stripe can update this later.</p>
        <div className="cc-seg">
          {["paid", "due", "late"].map((s) => (
            <button key={s} type="button" aria-pressed={bill.status === s} onClick={() => setBill((x) => ({ ...x, status: s }))}>
              {s === "paid" ? "Paid" : s === "due" ? "Due" : "Late"}
            </button>
          ))}
        </div>
        <div className="cc-grid two">
          <label className="cc-field">Amount ($)<input className="cc-input" inputMode="decimal" value={bill.amount} onChange={(e) => setBill((x) => ({ ...x, amount: e.target.value }))} /></label>
          <label className="cc-field">Due date<input className="cc-input" type="date" value={bill.due_date} onChange={(e) => setBill((x) => ({ ...x, due_date: e.target.value }))} /></label>
        </div>
        <label className="cc-field">Note<input className="cc-input" value={bill.note} onChange={(e) => setBill((x) => ({ ...x, note: e.target.value }))} placeholder="Invoice number, how they pay" /></label>
        <button className="cc-btn primary" disabled={b.busy}>Save billing</button>
        {b.msg ? <p className={`cc-msg ${b.msg.ok ? "ok" : "err"}`}>{b.msg.text}</p> : null}
      </form>
    </div>
  );
}
