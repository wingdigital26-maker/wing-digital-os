"use client";
import { useState } from "react";
import { useAct } from "./act";

export type Job = {
  id: number; client: string; brief_url: string | null; status: string; due_date: string | null; delivered_url: string | null;
  delivered_at: string | null; paid: boolean; price: number | null; notes: string | null; late: boolean;
};
const STATUS = [["brief_sent", "Brief sent"], ["building", "Building"], ["review", "In review"], ["delivered", "Delivered"], ["cancelled", "Cancelled"]];

export function NewJob() {
  const a = useAct();
  const [f, setF] = useState({ client: "", brief_url: "", due_date: "", price: "", notes: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <details className="cc-more-info">
      <summary>Send Pansh a new site</summary>
      <form className="cc-card cc-form" onSubmit={async (e) => {
        e.preventDefault();
        const r = await a.run("/api/command/websites", "POST", f, "Job added.");
        if (r.ok) setF({ client: "", brief_url: "", due_date: "", price: "", notes: "" });
      }}>
        <label className="cc-field">Client<input className="cc-input" value={f.client} onChange={set("client")} required /></label>
        <label className="cc-field">Brief link<input className="cc-input" type="url" value={f.brief_url} onChange={set("brief_url")} placeholder="https://" /></label>
        <div className="cc-grid two">
          <label className="cc-field">Due date<input className="cc-input" type="date" value={f.due_date} onChange={set("due_date")} /></label>
          <label className="cc-field">Price ($)<input className="cc-input" inputMode="decimal" value={f.price} onChange={set("price")} /></label>
        </div>
        <label className="cc-field">Notes<input className="cc-input" value={f.notes} onChange={set("notes")} /></label>
        <button className="cc-btn primary" disabled={a.busy}>Add job</button>
        {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
      </form>
    </details>
  );
}

export function JobCard({ j }: { j: Job }) {
  const a = useAct();
  const [url, setUrl] = useState(j.delivered_url ?? "");
  const patch = (p: Record<string, unknown>) => a.run("/api/command/websites", "PATCH", { id: j.id, ...p });
  return (
    <div className={`cc-card ${j.late ? "edge-red" : j.status === "delivered" ? "edge-green" : ""}`}>
      <div className="cc-spread">
        <h3>{j.client}</h3>
        <div className="cc-row">
          {j.late ? <span className="cc-tag red">Late</span> : null}
          <span className={`cc-tag ${j.paid ? "green" : "yellow"}`}>{j.paid ? "Paid" : "Not paid"}</span>
        </div>
      </div>
      <dl className="cc-kv">
        <dt>Due</dt><dd>{j.due_date ?? "No date"}</dd>
        <dt>Price</dt><dd>{j.price != null ? `$${j.price}` : "Not set"}</dd>
        <dt>Brief</dt><dd>{j.brief_url ? <a href={j.brief_url} target="_blank" rel="noreferrer">Open brief</a> : "No link"}</dd>
        {j.delivered_at ? (<><dt>Delivered</dt><dd>{j.delivered_at}</dd></>) : null}
        {j.notes ? (<><dt>Notes</dt><dd>{j.notes}</dd></>) : null}
      </dl>
      <div className="cc-seg" style={{ marginTop: 12 }}>
        {STATUS.map(([k, l]) => <button key={k} type="button" aria-pressed={j.status === k} disabled={a.busy} onClick={() => patch({ status: k })}>{l}</button>)}
      </div>
      <div className="cc-row">
        <input className="cc-input" style={{ flex: 1, minWidth: 180 }} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Delivered link https://" />
        <button type="button" className="cc-btn small" disabled={a.busy} onClick={() => patch({ delivered_url: url })}>Save link</button>
        {j.delivered_url ? <a className="cc-btn small" href={j.delivered_url} target="_blank" rel="noreferrer">Open site</a> : null}
        <button type="button" className="cc-btn small" disabled={a.busy} onClick={() => patch({ paid: !j.paid })}>{j.paid ? "Mark not paid" : "Mark paid"}</button>
      </div>
      {a.msg && !a.msg.ok ? <p className="cc-msg err">{a.msg.text}</p> : null}
    </div>
  );
}
