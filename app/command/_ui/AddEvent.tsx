"use client";
import { useState } from "react";
import { useAct } from "./act";

export default function AddEvent({ direct }: { direct: boolean }) {
  const a = useAct();
  const [f, setF] = useState({ title: "", date: "", start: "", minutes: "30", where: "", details: "" });
  const [link, setLink] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <details className="cc-more-info" open={false}>
      <summary>Add an event</summary>
      <form className="cc-card cc-form" onSubmit={async (e) => {
        e.preventDefault();
        setLink(null);
        const r = await a.run("/api/command/calendar", "POST", f);
        if (r.ok) {
          if (r.data.written) a.setMsg({ ok: true, text: "Added to the team calendar." });
          else {
            setLink(r.data.link);
            a.setMsg({ ok: true, text: "Tap the link below to save it to the team calendar." });
          }
        }
      }}>
        <label className="cc-field">What<input className="cc-input" value={f.title} onChange={set("title")} required placeholder="Meeting with ABC Roofing" /></label>
        <div className="cc-grid three">
          <label className="cc-field">Date<input className="cc-input" type="date" value={f.date} onChange={set("date")} required /></label>
          <label className="cc-field">Start (blank = all day)<input className="cc-input" type="time" value={f.start} onChange={set("start")} /></label>
          <label className="cc-field">Length
            <select className="cc-select" value={f.minutes} onChange={set("minutes")}>
              {["15", "30", "45", "60", "90", "120"].map((m) => <option key={m} value={m}>{m} min</option>)}
            </select>
          </label>
        </div>
        <label className="cc-field">Where or call link<input className="cc-input" value={f.where} onChange={set("where")} /></label>
        <label className="cc-field">Notes<input className="cc-input" value={f.details} onChange={set("details")} /></label>
        <button className="cc-btn primary" disabled={a.busy}>{direct ? "Add to calendar" : "Make calendar link"}</button>
        {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
        {link ? <a className="cc-btn" href={link} target="_blank" rel="noreferrer">Save in Google Calendar</a> : null}
      </form>
    </details>
  );
}
