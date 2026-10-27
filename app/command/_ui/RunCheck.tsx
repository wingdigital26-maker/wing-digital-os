"use client";
import { useState } from "react";
import { act, notifyLine } from "./act";

// Jack's manual run of the daily check route (the routine calls the same thing).
export default function RunCheck() {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="cc-row">
      <button className="cc-btn small" disabled={busy} onClick={async () => {
        setBusy(true);
        const r = await act("/api/command/check?quiet=1", "POST", {});
        setBusy(false);
        setMsg(r.ok ? `Recorded ${r.data.recorded} new snapshot${r.data.recorded === 1 ? "" : "s"}. ${r.data.flagged.length} flagged.${notifyLine(r.data.notify)}` : r.error);
      }}>Record today&apos;s snapshot</button>
      {msg ? <span className="cc-msg">{msg}</span> : null}
    </div>
  );
}
