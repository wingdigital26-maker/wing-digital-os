"use client";
import { useState } from "react";
import { notifyLine, useAct } from "./act";

// Shrink a photo/screenshot in the browser so it stays well under the 1.5 MB cap.
async function toDataUrl(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.8);
}

export default function ReportProblem({ clients, fixedClient }: { clients: { slug: string; name: string }[]; fixedClient?: string }) {
  const a = useAct();
  const [client, setClient] = useState(fixedClient ?? "");
  const [urgency, setUrgency] = useState("normal");
  const [body, setBody] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [shotErr, setShotErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const name = clients.find((c) => c.slug === client)?.name ?? null;
    const r = await a.run("/api/command/problems", "POST", { client_slug: client || null, client_name: name, urgency, body, screenshot: shot });
    if (r.ok) {
      setBody("");
      setShot(null);
      a.setMsg({ ok: true, text: `Saved as #${r.data.id}.${notifyLine(r.data.notify)}` });
    }
  }

  return (
    <form className="cc-card cc-form" onSubmit={submit}>
      {fixedClient ? null : (
        <label className="cc-field">
          Client
          <select className="cc-select" value={client} onChange={(e) => setClient(e.target.value)}>
            <option value="">Wing (not one client)</option>
            {clients.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
          </select>
        </label>
      )}
      <div className="cc-seg" role="group" aria-label="Urgency">
        {[["low", "Can wait"], ["normal", "Normal"], ["urgent", "Urgent"]].map(([k, l]) => (
          <button key={k} type="button" aria-pressed={urgency === k} onClick={() => setUrgency(k)}>{l}</button>
        ))}
      </div>
      <label className="cc-field">
        What is wrong
        <textarea className="cc-textarea" value={body} onChange={(e) => setBody(e.target.value)} required placeholder="What happened, where, and who noticed" />
      </label>
      <label className="cc-field">
        Screenshot (optional)
        <input
          className="cc-input"
          type="file"
          accept="image/*"
          onChange={async (e) => {
            setShotErr(null);
            const f = e.target.files?.[0];
            if (!f) return setShot(null);
            try {
              const d = await toDataUrl(f);
              if (d.length > 1_900_000) throw new Error("big");
              setShot(d);
            } catch {
              setShot(null);
              setShotErr("That image could not be used. Try a smaller screenshot.");
            }
          }}
        />
      </label>
      {shotErr ? <p className="cc-msg err">{shotErr}</p> : null}
      <button className="cc-btn primary block" disabled={a.busy || !body.trim()}>{a.busy ? "Sending" : "Report and text the team"}</button>
      {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
    </form>
  );
}
