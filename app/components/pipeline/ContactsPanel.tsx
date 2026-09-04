"use client";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import LogActivity from "./LogActivity";
import { UnifiedTimeline } from "./Timeline";
import {
  Contact, ContactDetailPayload, ContactsPayload, Stage, TaskItem, TimelineGroup,
  UNKNOWN_EMAIL, UNKNOWN_PERSON, UNKNOWN_PHONE, money, whenText,
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
        <ContactDetail
          key={`${open.id}-${reloadKey}`}
          contactId={open.id}
          stages={stages}
          onClose={() => setOpen(null)}
          onDealCreated={() => { onChanged(); }}
        />
      )}
    </div>
  );
}

// ── Contact detail ─────────────────────────────────────────────────────────
// The unified view: one fetch to /api/pipeline/contact brings the row, tags,
// tasks, deals and every kind of history, merged into one timeline. Anything
// that failed to load is named as such. Nothing here sends a message: the
// phone and email are plain tel: and mailto: links for the reader's own device.

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "8px 10px", fontSize: 14, borderRadius: 8,
  border: "1px solid var(--border)", background: "var(--bg-card)",
  color: "inherit", boxSizing: "border-box",
};

const smallBtn: React.CSSProperties = {
  padding: "6px 10px", borderRadius: 8, fontSize: 12, cursor: "pointer",
  border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>{children}</div>;
}

function ListFailed({ what, message }: { what: string; message?: string }) {
  return (
    <div style={{ fontSize: 12, color: "var(--red)" }} title={message}>
      {what} could not be loaded{message ? `: ${message}` : ""}
    </div>
  );
}

export function ContactDetail({
  contactId,
  stages,
  onClose,
  onDealCreated,
}: {
  contactId: number;
  // Optional: without stages the "start a deal" box is hidden rather than
  // shown broken.
  stages?: Stage[];
  onClose: () => void;
  onDealCreated?: () => void;
}) {
  const [data, setData] = useState<ContactDetailPayload | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | TimelineGroup>("all");

  const [tagText, setTagText] = useState("");
  const [tagErr, setTagErr] = useState("");
  const [taskText, setTaskText] = useState("");
  const [taskErr, setTaskErr] = useState("");
  const [busy, setBusy] = useState("");

  const [title, setTitle] = useState("");
  const [stageId, setStageId] = useState<string>(stages && stages.length ? String(stages[0].id) : "");
  const [dealErr, setDealErr] = useState("");
  const [dealOk, setDealOk] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    try {
      const res = await fetch(`/api/pipeline/contact?id=${contactId}`);
      const d = (await res.json().catch(() => null)) as ContactDetailPayload | null;
      if (!res.ok || !d || d.error) {
        setErr(d?.message || d?.error || `Contact unavailable (HTTP ${res.status})`);
        setData(null);
        return;
      }
      setData(d);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [contactId]);

  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function addTag() {
    const tag = tagText.trim();
    if (!tag) return;
    setBusy("tag"); setTagErr("");
    try {
      const res = await fetch("/api/automations/tags", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, tag }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) { setTagErr(d?.message || d?.error || `Could not add the tag (HTTP ${res.status})`); return; }
      setTagText("");
      await load();
    } catch (e) {
      setTagErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  async function removeTag(tag: string) {
    setBusy(`tag:${tag}`); setTagErr("");
    try {
      const qs = new URLSearchParams({ contact_id: String(contactId), tag });
      const res = await fetch(`/api/automations/tags?${qs.toString()}`, { method: "DELETE" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) { setTagErr(d?.message || d?.error || `Could not remove the tag (HTTP ${res.status})`); }
      await load();
    } catch (e) {
      setTagErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  async function addTask() {
    const t = taskText.trim();
    if (!t) return;
    setBusy("task"); setTaskErr("");
    try {
      const res = await fetch("/api/automations/tasks", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, title: t }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) { setTaskErr(d?.message || d?.error || `Could not add the task (HTTP ${res.status})`); return; }
      setTaskText("");
      await load();
    } catch (e) {
      setTaskErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  async function markDone(id: number) {
    setBusy(`task:${id}`); setTaskErr("");
    try {
      const res = await fetch("/api/automations/tasks", {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, done: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) { setTaskErr(d?.message || d?.error || `Could not mark it done (HTTP ${res.status})`); return; }
      await load();
    } catch (e) {
      setTaskErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  async function createDeal() {
    if (!title.trim()) { setDealErr("Give the deal a title first."); return; }
    if (!stageId) { setDealErr("No stage to create the deal in."); return; }
    setBusy("deal"); setDealErr(""); setDealOk(false);
    try {
      const res = await fetch("/api/pipeline/deals", {
        method: "POST", headers: { "content-type": "application/json" },
        // Value deliberately omitted: an unquoted deal stores NULL, which
        // reads as "not quoted" instead of a fabricated zero.
        body: JSON.stringify({ contact_id: contactId, stage_id: Number(stageId), title: title.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d?.error) { setDealErr(d?.message || d?.error || `Could not create the deal (HTTP ${res.status})`); return; }
      setDealOk(true); setTitle("");
      onDealCreated?.();
      await load();
    } catch (e) {
      setDealErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(""); }
  }

  const c = data?.contact ?? null;
  const failed = (name: string) => data?.errors?.find((e) => e.list === name);
  const openTasks = (data?.tasks ?? []).filter((t: TaskItem) => !t.done_at);
  const doneTasks = (data?.tasks ?? []).filter((t: TaskItem) => !!t.done_at);
  const anyCapped = !!data?.capped && Object.values(data.capped).some(Boolean);
  const timeline = Array.isArray(data?.timeline) ? data!.timeline! : [];

  // Rendered through a portal: the app shell animates its view with a
  // transform, and a transformed ancestor turns position:fixed into
  // position:absolute, which on a phone left this sheet under the header and
  // the bottom tab bar and stretched to the full scroll height.
  const sheet = (
    <div
      role="dialog"
      aria-label={c ? `Contact ${c.business_name}` : "Contact"}
      onClick={onClose}
      style={{
        // Above the phone's bottom tab bar (500) and its "More" sheet (600).
        position: "fixed", inset: 0, zIndex: 700, display: "flex",
        justifyContent: "flex-end", background: "var(--accent-glow)",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)", borderLeft: "1px solid var(--border)",
          width: "min(520px, 100%)", height: "100%", overflowY: "auto",
          padding: 16, boxSizing: "border-box", display: "grid", gap: 14,
          alignContent: "start",
        }}
      >
        {/* header */}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            {loading && !c && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading contact</div>}
            {c && (
              <>
                <div style={{ fontSize: 17, fontWeight: 700, overflowWrap: "anywhere" }}>{c.business_name}</div>
                <div style={{ fontSize: 13, color: c.contact_name ? "inherit" : "var(--text-muted)" }}>
                  {c.contact_name ? c.contact_name : UNKNOWN_PERSON}
                  {c.title ? <span style={{ color: "var(--text-muted)" }}> · {c.title}</span> : null}
                </div>
                <div style={{ fontSize: 13, marginTop: 2 }}>
                  {c.phone
                    ? <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} style={{ color: "var(--accent)" }}>{c.phone}</a>
                    : <span style={{ color: "var(--text-muted)" }}>{UNKNOWN_PHONE}</span>}
                </div>
                <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>
                  {c.email
                    ? <a href={`mailto:${c.email}`} style={{ color: "var(--accent)" }}>{c.email}</a>
                    : <span style={{ color: "var(--text-muted)" }}>{UNKNOWN_EMAIL}</span>}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  {c.city ? `${c.city}${c.state ? `, ${c.state}` : ""}` : "city unknown"}
                  {c.trade ? ` · ${c.trade}` : ""}
                </div>
                {c.do_not_contact && (
                  <div style={{
                    display: "inline-block", marginTop: 6, fontSize: 12, fontWeight: 700,
                    color: "var(--red)", border: "1px solid var(--red)", borderRadius: 6, padding: "2px 8px",
                  }}>
                    Do not contact{c.dnc_reason ? `: ${c.dnc_reason}` : ""}
                  </div>
                )}
              </>
            )}
          </div>
          <button type="button" onClick={onClose} style={{ ...smallBtn, height: 32, flexShrink: 0 }}>
            Close
          </button>
        </div>

        {err && (
          <div style={{
            border: "1px solid var(--red)", borderRadius: 10, padding: 12,
            color: "var(--red)", fontSize: 13,
          }}>
            {err}
          </div>
        )}

        {data && data.errors && data.errors.length > 0 && (
          <div style={{ border: "1px solid var(--orange)", borderRadius: 10, padding: 10, fontSize: 12, color: "var(--orange)" }}>
            Some of the history for this contact could not be loaded: {data.errors.map((e) => e.list).join(", ")}.
            What is shown below is incomplete.
          </div>
        )}

        {data && (
          <>
            {/* tags */}
            <div>
              <SectionTitle>Tags</SectionTitle>
              {data.tags === null || data.tags === undefined ? (
                <ListFailed what="Tags" message={failed("tags")?.message} />
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                  {data.tags.length === 0 && (
                    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No tags yet</span>
                  )}
                  {data.tags.map((t) => (
                    <span key={t.tag} style={{
                      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12,
                      border: "1px solid var(--accent)", color: "var(--accent)", borderRadius: 999,
                      padding: "3px 4px 3px 10px",
                    }}>
                      {t.tag}
                      <button
                        type="button"
                        aria-label={`Remove tag ${t.tag}`}
                        disabled={busy === `tag:${t.tag}`}
                        onClick={() => { void removeTag(t.tag); }}
                        style={{
                          border: "none", background: "transparent", color: "var(--accent)",
                          cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 5px",
                        }}
                      >
                        x
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addTag(); } }}
                  placeholder="Add tag"
                  style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }}
                />
                <button type="button" onClick={() => { void addTag(); }} disabled={busy === "tag" || !tagText.trim()} style={smallBtn}>
                  {busy === "tag" ? "Adding" : "Add"}
                </button>
              </div>
              {tagErr && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 4 }}>{tagErr}</div>}
            </div>

            {/* tasks */}
            <div>
              <SectionTitle>Open tasks</SectionTitle>
              {data.tasks === null || data.tasks === undefined ? (
                <ListFailed what="Tasks" message={failed("tasks")?.message} />
              ) : openTasks.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  No open tasks{doneTasks.length ? ` (${doneTasks.length} done)` : ""}
                </div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                  {openTasks.map((t) => (
                    <li key={t.id} style={{
                      display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center",
                      border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px",
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 13, overflowWrap: "anywhere" }}>{t.title}</div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {t.due_at ? `Due ${whenText(t.due_at)}` : "No due date"}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busy === `task:${t.id}`}
                        onClick={() => { void markDone(t.id); }}
                        style={{ ...smallBtn, border: "1px solid var(--green)", color: "var(--green)", flexShrink: 0 }}
                      >
                        Done
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <input
                  value={taskText}
                  onChange={(e) => setTaskText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addTask(); } }}
                  placeholder="Add task"
                  style={{ ...inputStyle, fontSize: 13, padding: "6px 10px" }}
                />
                <button type="button" onClick={() => { void addTask(); }} disabled={busy === "task" || !taskText.trim()} style={smallBtn}>
                  {busy === "task" ? "Adding" : "Add"}
                </button>
              </div>
              {taskErr && <div style={{ fontSize: 12, color: "var(--red)", marginTop: 4 }}>{taskErr}</div>}
            </div>

            {/* deals */}
            <div>
              <SectionTitle>Deals</SectionTitle>
              {data.deals === null || data.deals === undefined ? (
                <ListFailed what="Deals" message={failed("deals")?.message} />
              ) : data.deals.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No deals yet</div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                  {data.deals.map((d) => {
                    const unquoted = d.value_cents === null || d.value_cents === undefined;
                    const tone = d.status === "won" ? "var(--green)" : d.status === "lost" ? "var(--red)" : "var(--accent)";
                    return (
                      <li key={d.id} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "6px 10px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, overflowWrap: "anywhere" }}>{d.title}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: unquoted ? "var(--text-muted)" : "var(--green)", flexShrink: 0 }}>
                            {money(d.value_cents)}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          <span style={{ color: tone, fontWeight: 700 }}>{d.status || "status unknown"}</span>
                          {" · "}{d.crm_stages?.label || "stage unknown"}
                          {d.expected_close ? ` · expected ${d.expected_close}` : ""}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {/* enrollments, only when there is something to say */}
            {data.enrollments === null || data.enrollments === undefined ? (
              <ListFailed what="Email sequences" message={failed("enrollments")?.message} />
            ) : data.enrollments.length > 0 && (
              <div>
                <SectionTitle>Email sequences</SectionTitle>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
                  {data.enrollments.map((e) => (
                    <li key={e.id} style={{ fontSize: 12 }}>
                      {e.sequences?.name || "Unnamed sequence"}: {e.status}, step {e.current_step}
                      {e.next_send_at ? `, next ${whenText(e.next_send_at)}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <LogActivity contactId={contactId} onSaved={() => { void load(); }} />

            {stages && stages.length > 0 && (
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, display: "grid", gap: 8 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Start a deal</div>
                <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Deal title" style={inputStyle} />
                <select value={stageId} onChange={(e) => setStageId(e.target.value)} style={inputStyle}>
                  {stages.map((s) => <option key={s.id} value={String(s.id)}>{s.label}</option>)}
                </select>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => { void createDeal(); }}
                    disabled={busy === "deal"}
                    style={{
                      padding: "9px 16px", borderRadius: 8, fontSize: 14, fontWeight: 600,
                      cursor: busy === "deal" ? "default" : "pointer", background: "transparent",
                      border: "1px solid var(--accent)", color: "var(--accent)", opacity: busy === "deal" ? 0.6 : 1,
                    }}
                  >
                    {busy === "deal" ? "Creating" : "Create deal"}
                  </button>
                  {dealOk && <span style={{ fontSize: 12, color: "var(--green)" }}>Deal created</span>}
                  {dealErr && <span style={{ fontSize: 12, color: "var(--red)" }}>{dealErr}</span>}
                </div>
              </div>
            )}

            {/* timeline */}
            <div>
              <SectionTitle>Everything that has happened</SectionTitle>
              {(["activities", "messages", "submissions", "bookings", "runs", "events"] as const)
                .filter((n) => failed(n))
                .map((n) => (
                  <ListFailed
                    key={n}
                    what={{
                      activities: "Notes and calls", messages: "Messages", submissions: "Form submissions",
                      bookings: "Bookings", runs: "Automation runs", events: "Automation triggers",
                    }[n]}
                    message={failed(n)?.message}
                  />
                ))}
              <UnifiedTimeline items={timeline} capped={anyCapped} filter={filter} onFilter={setFilter} />
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (typeof document === "undefined") return sheet;
  return createPortal(sheet, document.body);
}

