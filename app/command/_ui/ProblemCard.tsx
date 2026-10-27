"use client";
import { useState } from "react";
import { useAct } from "./act";

type P = {
  id: number; client: string; reported_by: string; urgency: string; body: string; has_screenshot: boolean;
  status: string; owner: string | null; source: string; created: string; comments: number;
};
const PEOPLE = [["jack", "Jack"], ["grant", "Grant"], ["dylan", "Dylan"], ["pansh", "Pansh"]];

export default function ProblemCard({ p, me }: { p: P; me: string }) {
  const a = useAct();
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState<{ id: number; by_user: string; body: string; created_at: string }[] | null>(null);
  const [text, setText] = useState("");
  const name = (id: string | null) => PEOPLE.find(([k]) => k === id)?.[1] ?? "Nobody";

  async function loadComments() {
    setOpen((o) => !o);
    if (comments) return;
    const r = await fetch(`/api/command/problems/${p.id}`).then((x) => x.json()).catch(() => null);
    setComments(r?.comments ?? []);
  }
  async function addComment(e: React.FormEvent) {
    e.preventDefault();
    const r = await a.run(`/api/command/problems/${p.id}`, "PATCH", { comment: text });
    if (r.ok) {
      setText("");
      const fresh = await fetch(`/api/command/problems/${p.id}`).then((x) => x.json()).catch(() => null);
      setComments(fresh?.comments ?? []);
    }
  }

  const edge = p.status === "fixed" ? "green" : p.urgency === "urgent" ? "red" : "yellow";
  return (
    <div id={`p${p.id}`} className={`cc-card edge-${edge}`}>
      <div className="cc-row">
        <strong>#{p.id}</strong>
        {p.urgency === "urgent" ? <span className="cc-tag red">Urgent</span> : p.urgency === "low" ? <span className="cc-tag">Can wait</span> : null}
        <span className="cc-tag">{p.client}</span>
        {p.source === "roofer-checkin" ? <span className="cc-tag blue">From a check-in</span> : null}
      </div>
      <p style={{ margin: "8px 0", fontSize: 15, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{p.body}</p>
      <div className="cc-muted">{name(p.reported_by)} reported it {p.created}. Owner: {name(p.owner)}.</div>
      {p.has_screenshot ? (
        <a href={`/api/command/problems/${p.id}/screenshot`} target="_blank" rel="noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- gated private API image, not optimisable */}
          <img src={`/api/command/problems/${p.id}/screenshot`} alt="Screenshot" style={{ maxWidth: "100%", maxHeight: 240, borderRadius: 10, marginTop: 8, border: "1px solid var(--border)" }} />
        </a>
      ) : null}
      <div className="cc-seg" style={{ marginTop: 12 }} role="group" aria-label="Status">
        {[["open", "Open"], ["working", "Working"], ["fixed", "Fixed"]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={p.status === k} disabled={a.busy} onClick={() => a.run(`/api/command/problems/${p.id}`, "PATCH", { status: k, ...(k === "working" && !p.owner ? { owner: me } : {}) })}>{l}</button>
        ))}
      </div>
      <div className="cc-row">
        <select className="cc-select" style={{ maxWidth: 220 }} value={p.owner ?? ""} disabled={a.busy}
          onChange={(e) => a.run(`/api/command/problems/${p.id}`, "PATCH", { owner: e.target.value })}>
          <option value="">No owner</option>
          {PEOPLE.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <button type="button" className="cc-btn small" onClick={loadComments}>{open ? "Hide comments" : `Comments (${p.comments})`}</button>
      </div>
      {open ? (
        <div style={{ marginTop: 10 }}>
          {comments === null ? <p className="cc-muted">Loading</p> : comments.length ? (
            <ul className="cc-list">{comments.map((c) => <li key={c.id}><strong>{name(c.by_user)}:</strong> {c.body}</li>)}</ul>
          ) : <p className="cc-muted">No comments yet.</p>}
          <form onSubmit={addComment} className="cc-row" style={{ marginTop: 8 }}>
            <input className="cc-input" style={{ flex: 1, minWidth: 180 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" />
            <button className="cc-btn small" disabled={a.busy || !text.trim()}>Add</button>
          </form>
        </div>
      ) : null}
      {a.msg && !a.msg.ok ? <p className="cc-msg err">{a.msg.text}</p> : null}
    </div>
  );
}
