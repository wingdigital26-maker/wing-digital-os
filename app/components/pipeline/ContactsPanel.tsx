"use client";
import { useCallback, useEffect, useState } from "react";
import LogActivity from "./LogActivity";
import Timeline from "./Timeline";
import {
  Contact, ContactsPayload, Stage, UNKNOWN_PERSON, UNKNOWN_PHONE,
} from "./types";

// Contact list and search, plus the per-contact detail where a call outcome or
// note gets logged. A contact with no human name shows that plainly; the
// business name is never reused as a person's name.

const PAGE = 25;

export default function ContactsPanel({
  stages,
  onChanged,
}: {
  stages: Stage[];
  onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [payload, setPayload] = useState<ContactsPayload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Contact | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (q.trim()) qs.set("q", q.trim());
      const res = await fetch(`/api/pipeline/contacts?${qs.toString()}`);
      const data = (await res.json().catch(() => null)) as ContactsPayload | null;
      if (!res.ok) {
        setErr(data?.error || `Contacts unavailable (HTTP ${res.status})`);
        setPayload(null);
        return;
      }
      if (!data || data.error) {
        setErr(data?.error || "Contacts unavailable: the API returned nothing readable.");
        setPayload(null);
        return;
      }
      setPayload(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [q, offset]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(t);
  }, [load]);

  const contacts = payload && Array.isArray(payload.contacts) ? payload.contacts : null;
  const total = payload && typeof payload.total === "number" ? payload.total : null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOffset(0); }}
        placeholder="Search business, person, phone, email"
        style={{
          width: "100%", padding: "10px 12px", fontSize: 15, borderRadius: 10,
          border: "1px solid var(--border)", background: "var(--bg-card)",
          color: "inherit", boxSizing: "border-box",
        }}
      />

      {err && (
        <div style={{
          border: "1px solid var(--red)", borderRadius: 10, padding: 12,
          color: "var(--red)", fontSize: 13,
        }}>
          {err}
        </div>
      )}

      {!err && loading && (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading contacts</div>
      )}

      {!err && !loading && contacts && contacts.length === 0 && (
        <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {q.trim() ? "No contacts match that search" : "No contacts in the database yet"}
        </div>
      )}

      {!err && contacts && contacts.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { setOpen(c); setReloadKey((k) => k + 1); }}
              style={{
                textAlign: "left", cursor: "pointer",
                border: "1px solid var(--border)", borderRadius: 10,
                background: "var(--bg-card)", padding: 12, color: "inherit",
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 15 }}>{c.business_name}</div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {c.contact_name ? c.contact_name : UNKNOWN_PERSON}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                {c.phone ? c.phone : UNKNOWN_PHONE}
                {c.city ? ` · ${c.city}` : ""}
              </div>
              {c.do_not_contact && (
                <div style={{ fontSize: 12, color: "var(--red)", marginTop: 4 }}>
                  Do not contact
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {!err && contacts && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
          <button
            type="button"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
            style={{
              padding: "6px 12px", borderRadius: 8, cursor: offset === 0 ? "default" : "pointer",
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)",
            }}
          >
            Previous
          </button>
          <button
            type="button"
            disabled={total !== null ? offset + PAGE >= total : contacts.length < PAGE}
            onClick={() => setOffset(offset + PAGE)}
            style={{
              padding: "6px 12px", borderRadius: 8, cursor: "pointer",
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)",
            }}
          >
            Next
          </button>
          <span style={{ color: "var(--text-muted)" }}>
            {total !== null
              ? `${offset + 1} to ${Math.min(offset + PAGE, total)} of ${total}`
              : "total unknown"}
          </span>
        </div>
      )}

      {open && (
        <ContactSheet
          contact={open}
          stages={stages}
          onClose={() => setOpen(null)}
          reloadKey={reloadKey}
          bumpReload={() => setReloadKey((k) => k + 1)}
          onDealCreated={() => { onChanged(); }}
        />
      )}
    </div>
  );
}

function ContactSheet({
  contact, stages, onClose, reloadKey, bumpReload, onDealCreated,
}: {
  contact: Contact;
  stages: Stage[];
  onClose: () => void;
  reloadKey: number;
  bumpReload: () => void;
  onDealCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [stageId, setStageId] = useState<string>(stages.length ? String(stages[0].id) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState(false);

  async function createDeal() {
    if (!title.trim()) { setErr("Give the deal a title first."); return; }
    if (!stageId) { setErr("No stage to create the deal in."); return; }
    setBusy(true); setErr(""); setOk(false);
    try {
      const res = await fetch("/api/pipeline/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact_id: contact.id,
          stage_id: Number(stageId),
          title: title.trim(),
          // Value is deliberately left out: an unquoted deal stores NULL, which
          // reads as "not quoted" instead of a fabricated zero.
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setErr(data?.error || `Could not create the deal (HTTP ${res.status})`);
      } else {
        setOk(true);
        setTitle("");
        onDealCreated();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label={`Contact ${contact.business_name}`}
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 60, display: "flex",
        justifyContent: "flex-end", background: "var(--accent-glow)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)", borderLeft: "1px solid var(--border)",
          width: "min(460px, 100%)", height: "100%", overflowY: "auto",
          padding: 16, boxSizing: "border-box", display: "grid", gap: 14,
          alignContent: "start",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>{contact.business_name}</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {contact.contact_name ? contact.contact_name : UNKNOWN_PERSON}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              {contact.phone ? contact.phone : UNKNOWN_PHONE}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)", borderRadius: 8, padding: "4px 10px",
              cursor: "pointer", height: 32,
            }}
          >
            Close
          </button>
        </div>

        <LogActivity contactId={contact.id} onSaved={bumpReload} />

        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: 12,
          display: "grid", gap: 8,
        }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Start a deal</div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Deal title"
            style={{
              width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 8,
              border: "1px solid var(--border)", background: "var(--bg-card)",
              color: "inherit", boxSizing: "border-box",
            }}
          />
          {stages.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              No stages loaded, so a deal cannot be placed anywhere yet.
            </div>
          ) : (
            <select
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              style={{
                width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 8,
                border: "1px solid var(--border)", background: "var(--bg-card)",
                color: "inherit",
              }}
            >
              {stages.map((s) => (
                <option key={s.id} value={String(s.id)}>{s.label}</option>
              ))}
            </select>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              onClick={createDeal}
              disabled={busy || stages.length === 0}
              style={{
                padding: "9px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600,
                cursor: busy ? "default" : "pointer", background: "transparent",
                border: "1px solid var(--accent)", color: "var(--accent)",
                opacity: busy ? 0.6 : 1,
              }}
            >
              {busy ? "Creating" : "Create deal"}
            </button>
            {ok && <span style={{ fontSize: 12, color: "var(--green)" }}>Deal created</span>}
            {err && <span style={{ fontSize: 12, color: "var(--red)" }}>{err}</span>}
          </div>
        </div>

        <div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            Activity timeline
          </div>
          <Timeline contactId={contact.id} reloadKey={reloadKey} />
        </div>
      </div>
    </div>
  );
}
