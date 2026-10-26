"use client";
import { useState } from "react";
import { useAct } from "./act";

export type CallProspect = {
  id: string; business: string; contact: string | null; phone: string | null; email: string | null; website: string | null;
  city: string | null; niche: string | null; hook: string | null; last_outcome: string | null; last_called_at: string | null;
  next_call_date: string | null; notes: string | null; calls: number;
};

const OUTCOMES = [
  ["no_answer", "No answer"],
  ["voicemail", "Voicemail"],
  ["call_back", "Call back"],
  ["meeting", "Meeting booked"],
  ["not_interested", "Not interested"],
] as const;
const LABEL: Record<string, string> = Object.fromEntries(OUTCOMES);

export default function CallCard({ p }: { p: CallProspect }) {
  const a = useAct();
  const [note, setNote] = useState(p.notes ?? "");
  const [next, setNext] = useState(p.next_call_date ?? "");
  const tel = p.phone ? p.phone.replace(/[^\d+]/g, "") : null;

  async function log(outcome?: string) {
    const r = await a.run("/api/command/calls", "POST", { prospect_id: p.id, outcome, note, next_call_date: next || null });
    if (r.ok) a.setMsg({ ok: true, text: outcome ? `Logged ${LABEL[outcome]}.${r.data.next_call_date ? ` Next call ${r.data.next_call_date}.` : ""}${outcome === "meeting" ? " Added to the pipeline." : ""}` : "Notes saved." });
  }

  return (
    <div className="cc-card">
      <div className="cc-spread">
        <div>
          <h3>{p.business}</h3>
          <div className="cc-sub">{[p.contact, p.city, p.niche].filter(Boolean).join(", ") || "No details"}</div>
        </div>
        {p.last_outcome ? <span className={`cc-tag ${p.last_outcome === "meeting" ? "green" : p.last_outcome === "call_back" ? "yellow" : ""}`}>{LABEL[p.last_outcome]}</span> : <span className="cc-tag blue">New</span>}
      </div>
      {p.hook ? <p className="cc-sub" style={{ margin: "8px 0 0" }}><strong>Opener:</strong> {p.hook}</p> : null}
      <div className="cc-row" style={{ margin: "12px 0" }}>
        {tel ? <a className="cc-btn cc-call" href={`tel:${tel}`}>Call {p.phone}</a> : <span className="cc-muted">No phone on file</span>}
        {p.website ? <a className="cc-btn small" href={p.website} target="_blank" rel="noreferrer">Website</a> : null}
      </div>
      <div className="cc-btns">
        {OUTCOMES.map(([k, l]) => (
          <button key={k} type="button" className={`cc-btn${k === "meeting" ? " primary" : ""}`} disabled={a.busy} onClick={() => log(k)}>{l}</button>
        ))}
      </div>
      <div className="cc-grid two" style={{ marginTop: 10, gap: "0 10px" }}>
        <label className="cc-field">Notes<textarea className="cc-textarea" style={{ minHeight: 60 }} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <label className="cc-field">Next call date<input className="cc-input" type="date" value={next} onChange={(e) => setNext(e.target.value)} />
          <button type="button" className="cc-btn small" disabled={a.busy} onClick={() => log()}>Save notes and date</button>
        </label>
      </div>
      <div className="cc-muted">{p.calls ? `${p.calls} call${p.calls === 1 ? "" : "s"} logged` : "Never called"}{p.next_call_date ? `. Next: ${p.next_call_date}` : ""}</div>
      {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
    </div>
  );
}
