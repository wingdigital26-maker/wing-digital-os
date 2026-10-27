"use client";
import { useState } from "react";
import { DEAL_STAGES } from "@/lib/command/onboarding";
import { useAct } from "./act";

const STAGES = DEAL_STAGES;

export type Deal = {
  id: number; business: string; contact: string | null; phone: string | null; stage: string; product: string | null;
  value_monthly: number | null; owner: string | null; notes: string | null; days_in_stage: number;
};

export function NewDeal() {
  const a = useAct();
  const [f, setF] = useState({ business: "", contact: "", phone: "", product: "roof-command", value_monthly: "", stage: "lead", notes: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <details className="cc-more-info">
      <summary>Add a deal</summary>
      <form className="cc-card cc-form" onSubmit={async (e) => {
        e.preventDefault();
        const r = await a.run("/api/command/deals", "POST", f, "Deal added.");
        if (r.ok) setF((x) => ({ ...x, business: "", contact: "", phone: "", value_monthly: "", notes: "" }));
      }}>
        <label className="cc-field">Business<input className="cc-input" value={f.business} onChange={set("business")} required /></label>
        <div className="cc-grid two">
          <label className="cc-field">Contact<input className="cc-input" value={f.contact} onChange={set("contact")} /></label>
          <label className="cc-field">Phone<input className="cc-input" type="tel" value={f.phone} onChange={set("phone")} /></label>
        </div>
        <div className="cc-grid three">
          <label className="cc-field">Product
            <select className="cc-select" value={f.product} onChange={set("product")}>
              <option value="roof-command">Roof Command</option><option value="seo">SEO</option><option value="website">Website</option><option value="seo+website">SEO and website</option>
            </select>
          </label>
          <label className="cc-field">$/month<input className="cc-input" inputMode="decimal" value={f.value_monthly} onChange={set("value_monthly")} /></label>
          <label className="cc-field">Stage
            <select className="cc-select" value={f.stage} onChange={set("stage")}>
              {STAGES.slice(0, 4).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              <option value="signed">Signed (starts onboarding)</option>
            </select>
          </label>
        </div>
        <label className="cc-field">Notes<input className="cc-input" value={f.notes} onChange={set("notes")} /></label>
        <button className="cc-btn primary" disabled={a.busy}>Add deal</button>
        {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
      </form>
    </details>
  );
}

export function DealCard({ d }: { d: Deal }) {
  const a = useAct();
  const idx = STAGES.findIndex(([k]) => k === d.stage);
  const next = idx >= 0 && idx < 4 ? STAGES[idx + 1] : null;
  const tel = d.phone?.replace(/[^\d+]/g, "");
  return (
    <div className="cc-card">
      <div className="cc-spread">
        <h3>{d.business}</h3>
        <span className="cc-tag blue">{STAGES[idx]?.[1] ?? d.stage}</span>
      </div>
      <div className="cc-sub">
        {[d.contact, d.product, d.value_monthly != null ? `$${d.value_monthly}/mo` : null].filter(Boolean).join(", ") || "No details"}. {d.days_in_stage} days in this stage.
      </div>
      {d.notes ? <p className="cc-sub" style={{ margin: "6px 0 0" }}>{d.notes}</p> : null}
      <div className="cc-row" style={{ marginTop: 10 }}>
        {tel ? <a className="cc-btn small cc-call" href={`tel:${tel}`}>Call</a> : null}
        {next ? (
          <button className="cc-btn small primary" disabled={a.busy} onClick={() => a.run("/api/command/deals", "PATCH", { id: d.id, stage: next[0] === "onboarding" ? "signed" : next[0] })}>
            {next[0] === "onboarding" ? "Signed: start onboarding" : `Move to ${next[1]}`}
          </button>
        ) : null}
        {d.stage !== "lost" && d.stage !== "live" ? (
          <button className="cc-btn small" disabled={a.busy} onClick={() => a.run("/api/command/deals", "PATCH", { id: d.id, stage: "lost" })}>Lost</button>
        ) : null}
      </div>
      {a.msg && !a.msg.ok ? <p className="cc-msg err">{a.msg.text}</p> : null}
    </div>
  );
}

export function Checklist({ dealId, items, done, day }: { dealId: number; items: { key: string; day: number; who: string; text: string }[]; done: Record<string, boolean>; day: number }) {
  const a = useAct();
  return (
    <ul className="cc-list">
      {items.map((i) => {
        const isDone = Boolean(done[i.key]);
        const late = !isDone && i.day < day;
        return (
          <li key={i.key}>
            <label style={{ display: "flex", gap: 12, alignItems: "flex-start", minHeight: 44, cursor: "pointer" }}>
              <input type="checkbox" checked={isDone} disabled={a.busy} style={{ width: 24, height: 24, flex: "none", marginTop: 2 }}
                onChange={(e) => a.run("/api/command/onboarding", "POST", { deal_id: dealId, item_key: i.key, done: e.target.checked })} />
              <span>
                <strong>Day {i.day}</strong> {i.text}
                <span className="cc-muted"> ({i.who})</span>
                {late ? <span className="cc-tag red" style={{ marginLeft: 6 }}>Behind</span> : null}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
