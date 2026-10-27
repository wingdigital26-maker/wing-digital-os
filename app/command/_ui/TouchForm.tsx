"use client";
import { useState } from "react";
import { notifyLine, useAct } from "./act";

export default function TouchForm({ slug, name }: { slug: string; name: string }) {
  const a = useAct();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState("call");
  const [mood, setMood] = useState("");
  const [problems, setProblems] = useState("");
  const [note, setNote] = useState("");

  if (!open) return <button type="button" className="cc-btn primary block" onClick={() => setOpen(true)}>Log this week&apos;s check-in</button>;

  return (
    <form
      className="cc-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await a.run("/api/command/roofers", "POST", { client_slug: slug, client_name: name, channel, mood, problems, note });
        if (r.ok) {
          a.setMsg({ ok: true, text: r.data.problem_id ? `Saved. Problem #${r.data.problem_id} opened.${notifyLine(r.data.notify)}` : "Saved." });
          setProblems("");
          setNote("");
          setMood("");
          setOpen(false);
        }
      }}
    >
      <div className="cc-seg" role="group" aria-label="How">
        {[["call", "Call"], ["text", "Text"], ["visit", "Visit"]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={channel === k} onClick={() => setChannel(k)}>{l}</button>
        ))}
      </div>
      <div className="cc-seg" role="group" aria-label="Mood">
        {[["happy", "Happy"], ["ok", "OK"], ["unhappy", "Unhappy"]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={mood === k} onClick={() => setMood(k)}>{l}</button>
        ))}
      </div>
      <label className="cc-field">Problems they raised (becomes a Problem and texts the team)
        <textarea className="cc-textarea" style={{ minHeight: 70 }} value={problems} onChange={(e) => setProblems(e.target.value)} placeholder="Leave empty if none" />
      </label>
      <label className="cc-field">Notes<input className="cc-input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <div className="cc-row">
        <button className="cc-btn primary" disabled={a.busy || !mood}>Save check-in</button>
        <button type="button" className="cc-btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {!mood ? <p className="cc-muted">Pick how they felt.</p> : null}
      {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
    </form>
  );
}
