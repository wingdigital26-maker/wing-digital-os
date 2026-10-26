"use client";
import { useState } from "react";
import { useAct } from "./act";

export default function WeeklyInput({ person, metric, label, value }: { person: string; metric: string; label: string; value: number | null }) {
  const a = useAct();
  const [v, setV] = useState(value != null ? String(value) : "");
  return (
    <form className="cc-row" style={{ margin: "6px 0" }} onSubmit={(e) => { e.preventDefault(); a.run("/api/command/weekly", "POST", { person, metric, value: v }, "Saved."); }}>
      <label style={{ flex: 1, fontSize: 14 }}>{label}</label>
      <input className="cc-input" style={{ width: 110 }} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value)} aria-label={label} />
      <button className="cc-btn small" disabled={a.busy}>Save</button>
      {a.msg ? <span className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</span> : null}
    </form>
  );
}
