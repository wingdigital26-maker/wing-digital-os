"use client";
import { useState } from "react";
import { act, notifyLine } from "./act";

// Jack's manual trigger for the morning digest (the daily routine sends it on its own).
export default function DigestButton() {
  const [preview, setPreview] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="cc-card" style={{ marginTop: 16 }}>
      <h3>Morning digest</h3>
      <p className="cc-sub">The daily routine texts this every morning. Preview it or send it now.</p>
      <div className="cc-row">
        <button className="cc-btn small" type="button" onClick={async () => {
          const r = await fetch("/api/command/digest").then((x) => x.json()).catch(() => null);
          setPreview(r?.text ?? r?.error ?? "Could not build it.");
        }}>Preview</button>
        <button className="cc-btn small" type="button" onClick={async () => {
          const r = await act("/api/command/digest", "POST", {});
          setMsg(r.ok ? `Done.${notifyLine(r.data.notify)}` : r.error);
        }}>Send now</button>
      </div>
      {preview ? <pre className="cc-prose" style={{ whiteSpace: "pre-wrap", marginTop: 10 }}>{preview}</pre> : null}
      {msg ? <p className="cc-msg">{msg}</p> : null}
    </div>
  );
}
