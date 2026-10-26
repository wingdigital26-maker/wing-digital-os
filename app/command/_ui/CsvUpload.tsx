"use client";
import { useState } from "react";
import { parseCsv } from "@/app/lib/csv";
import { useAct } from "./act";

// Map loose CSV headers onto prospect fields. First match wins.
const MAP: Record<string, string[]> = {
  business: ["business", "company", "name", "business name", "company name", "organization"],
  contact: ["contact", "owner", "owner_name", "owner name", "first name", "contact name", "person"],
  phone: ["phone", "phone number", "mobile", "cell", "telephone", "direct phone", "company phone"],
  email: ["email", "email address", "e-mail"],
  website: ["website", "url", "site", "domain"],
  city: ["city", "location", "town"],
  niche: ["niche", "vertical", "industry", "trade", "category"],
  hook: ["hook", "call_hook", "opener", "notes"],
};

export default function CsvUpload() {
  const a = useAct();
  const [rows, setRows] = useState<Record<string, string>[] | null>(null);
  const [name, setName] = useState("");

  function read(file: File) {
    file.text().then((t) => {
      const raw = parseCsv(t);
      const mapped = raw.map((r) => {
        const o: Record<string, string> = {};
        for (const [field, keys] of Object.entries(MAP)) {
          const k = keys.find((k) => r[k]);
          if (k) o[field] = r[k];
        }
        return o;
      });
      setRows(mapped.filter((r) => r.business && (r.phone || r.email)));
      setName(file.name);
    });
  }

  return (
    <details className="cc-more-info">
      <summary>Upload a CSV of prospects</summary>
      <div className="cc-card">
        <p className="cc-sub" style={{ marginTop: 0 }}>Needs a business name and a phone or email per row. Common column names (company, phone, owner, city) are matched for you. Re-uploading the same list updates it and never wipes call notes.</p>
        <input className="cc-input" type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
        {rows ? (
          <div style={{ marginTop: 10 }}>
            <p className="cc-sub">{name}: {rows.length} usable rows.</p>
            <button className="cc-btn primary" disabled={a.busy || !rows.length} onClick={async () => {
              const r = await a.run("/api/command/prospects", "POST", { rows });
              if (r.ok) a.setMsg({ ok: true, text: `Added ${r.data.added}, updated ${r.data.updated}, skipped ${r.data.skipped}.` });
            }}>Add to call list</button>
          </div>
        ) : null}
        {a.msg ? <p className={`cc-msg ${a.msg.ok ? "ok" : "err"}`}>{a.msg.text}</p> : null}
      </div>
    </details>
  );
}
