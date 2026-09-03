"use client";
import { useCallback, useState } from "react";
import type { FormRow } from "@/lib/automations/types";
import {
  api,
  btn,
  btnPrimary,
  btnSmall,
  card,
  EmptyState,
  ErrorBox,
  errText,
  fmtWhen,
  h1,
  input,
  jsonInit,
  label,
  muted,
  Notice,
  pickList,
  StatusPill,
  useLoad,
  useOrigin,
} from "../_ui";

// /automations/forms: the lead-capture forms a client site posts to. Each
// one has a URL, an embed snippet, and its last submissions.

type Submission = {
  id: number;
  created_at: string;
  data: Record<string, unknown>;
  contact_id?: number | null;
};

function htmlSnippet(origin: string, slug: string): string {
  return [
    `<form method="POST" action="${origin}/api/forms/${slug}">`,
    `  <input name="name" placeholder="Your name" required>`,
    `  <input name="email" type="email" placeholder="Email">`,
    `  <input name="phone" type="tel" placeholder="Phone">`,
    `  <textarea name="message" placeholder="How can we help?"></textarea>`,
    `  <input name="_hp" type="text" style="display:none" tabindex="-1" autocomplete="off">`,
    `  <label><input name="sms_consent" type="checkbox" value="yes"> It is OK to text me about this</label>`,
    `  <button type="submit">Send</button>`,
    `</form>`,
  ].join("\n");
}

function fetchSnippet(origin: string, slug: string): string {
  return [
    `fetch("${origin}/api/forms/${slug}", {`,
    `  method: "POST",`,
    `  headers: { "Content-Type": "application/json" },`,
    `  body: JSON.stringify({`,
    `    name: "Jane Doe",`,
    `    email: "jane@example.com",`,
    `    phone: "+12145550100",`,
    `    message: "I need a quote",`,
    `    sms_consent: true,`,
    `    _hp: ""`,
    `  })`,
    `});`,
  ].join("\n");
}

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

export default function FormsPage() {
  const [forms, setForms] = useState<FormRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const origin = useOrigin();
  const [open, setOpen] = useState<string | null>(null);
  const [subs, setSubs] = useState<Record<string, { rows: Submission[] | null; error: string | null }>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const [draft, setDraft] = useState({ slug: "", name: "", client_slug: "", redirect_url: "" });

  const load = useCallback(async () => {
    try {
      const d = await api<unknown>("/api/forms");
      setForms(pickList<FormRow>(d, "forms", "items", "rows"));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useLoad(load);

  const loadSubs = useCallback(async (formId: string) => {
    setSubs((s) => ({ ...s, [formId]: { rows: null, error: null } }));
    try {
      const d = await api<unknown>(`/api/forms/submissions?form_id=${encodeURIComponent(formId)}&limit=20`);
      const rows = pickList<Submission>(d, "submissions", "items", "rows").slice(0, 20);
      setSubs((s) => ({ ...s, [formId]: { rows, error: null } }));
    } catch (e) {
      setSubs((s) => ({ ...s, [formId]: { rows: null, error: errText(e) } }));
    }
  }, []);

  const toggle = (formId: string) => {
    if (open === formId) {
      setOpen(null);
      return;
    }
    setOpen(formId);
    if (!subs[formId]) loadSubs(formId);
  };

  const create = async () => {
    const slug = draft.slug.trim().toLowerCase();
    const name = draft.name.trim();
    if (!slug || !name) return;
    if (!/^[a-z0-9-]+$/.test(slug)) {
      setNotice({ kind: "warn", text: "The slug can only use lowercase letters, digits, and dashes." });
      return;
    }
    setBusy("create");
    setNotice(null);
    try {
      await api("/api/forms", jsonInit("POST", { slug, name, client_slug: draft.client_slug, redirect_url: draft.redirect_url }));
      setDraft({ slug: "", name: "", client_slug: "", redirect_url: "" });
      setNotice({ kind: "ok", text: `Created the "${name}" form. Its address is ${origin}/api/forms/${slug}` });
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (f: FormRow, status: "active" | "paused") => {
    setBusy(f.id);
    setNotice(null);
    try {
      await api("/api/forms", jsonInit("PATCH", { id: f.id, status }));
      await load();
      setNotice({
        kind: "ok",
        text: status === "paused" ? `Paused "${f.name}". It now rejects submissions and stores nothing.` : `"${f.name}" is accepting submissions again.`,
      });
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      setNotice({ kind: "warn", text: "Could not copy automatically. Select the code and copy it by hand." });
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={h1}>Forms</h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          A form is an address a website can send a lead to. Every submission is stored, becomes a contact, and can start an automation.
        </span>
      </div>

      <div style={{ ...card, margin: "18px 0" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Create a form</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 160px" }}>
            <span style={label}>Slug (goes in the URL)</span>
            <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="contact" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <span style={label}>Name</span>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Contact page form" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <span style={label}>Client (optional)</span>
            <input value={draft.client_slug} onChange={(e) => setDraft({ ...draft, client_slug: e.target.value })} placeholder="heros-junk" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 220px" }}>
            <span style={label}>Send them here afterwards (optional)</span>
            <input value={draft.redirect_url} onChange={(e) => setDraft({ ...draft, redirect_url: e.target.value })} placeholder="https://client-site.com/thanks" style={{ ...input, width: "100%" }} />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={create} disabled={busy === "create" || !draft.slug.trim() || !draft.name.trim()} style={btnPrimary}>
            Create form
          </button>
        </div>
      </div>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {error && <ErrorBox what="forms" error={error} />}
      {forms === null && !error && <div style={muted}>Loading...</div>}
      {forms?.length === 0 && <EmptyState>No forms yet. Create one above, then paste its embed code into the client&apos;s site.</EmptyState>}

      <div style={{ display: "grid", gap: 10 }}>
        {forms?.map((f) => {
          const isOpen = open === f.id;
          const s = subs[f.id];
          const url = `${origin}/api/forms/${f.slug}`;
          return (
            <div key={f.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{f.name}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3, overflowWrap: "anywhere" }}>
                    {url}
                    {f.client_slug ? ` · for ${f.client_slug}` : ""}
                    {" · "}
                    {f.submissions === 0 ? "no submissions yet" : `${f.submissions} submission${f.submissions === 1 ? "" : "s"}`}
                  </div>
                </div>
                <StatusPill status={f.status === "active" ? "active" : "paused"} text={f.status === "active" ? "Accepting" : "Paused"} />
                {f.status === "active" ? (
                  <button onClick={() => setStatus(f, "paused")} disabled={busy === f.id} style={btn}>Pause</button>
                ) : (
                  <button onClick={() => setStatus(f, "active")} disabled={busy === f.id} style={btnPrimary}>Resume</button>
                )}
                <button onClick={() => toggle(f.id)} style={btn}>{isOpen ? "Hide embed code" : "Show embed code"}</button>
              </div>

              {isOpen && (
                <div style={{ marginTop: 14, display: "grid", gap: 14 }}>
                  <Snippet
                    title="Plain HTML form (paste into any page)"
                    code={htmlSnippet(origin, f.slug)}
                    copied={copied === `${f.id}:html`}
                    onCopy={() => copy(`${f.id}:html`, htmlSnippet(origin, f.slug))}
                  />
                  <Snippet
                    title="JavaScript fetch (for a site that already has its own form)"
                    code={fetchSnippet(origin, f.slug)}
                    copied={copied === `${f.id}:js`}
                    onCopy={() => copy(`${f.id}:js`, fetchSnippet(origin, f.slug))}
                  />
                  <div style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
                    The hidden <code>_hp</code> field is a bot trap: real people leave it empty. Keep it in.
                    {f.redirect_url ? ` After an HTML post, visitors are sent to ${f.redirect_url}.` : " Set a redirect URL to send visitors to a thank-you page after an HTML post."}
                  </div>

                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>Last 20 submissions</span>
                      <button onClick={() => loadSubs(f.id)} style={btnSmall}>Refresh</button>
                    </div>
                    {!s || (s.rows === null && !s.error) ? (
                      <div style={muted}>Loading...</div>
                    ) : s.error ? (
                      <div style={{ ...card, borderColor: "var(--red)", fontSize: 13 }}>Could not load submissions: {s.error}</div>
                    ) : s.rows && s.rows.length === 0 ? (
                      <div style={muted}>Nothing has been submitted to this form yet.</div>
                    ) : (
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
                          <thead>
                            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
                              <th style={th}>When</th>
                              <th style={th}>Name</th>
                              <th style={th}>Email</th>
                              <th style={th}>Phone</th>
                              <th style={th}>Message</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.rows?.map((r) => {
                              const d = r.data ?? {};
                              const msg = str(d.message);
                              return (
                                <tr key={r.id} style={{ borderTop: "1px solid var(--border)" }}>
                                  <td style={td}>{fmtWhen(r.created_at)}</td>
                                  <td style={td}>{str(d.name) || str(d.first_name) || <span style={muted}>blank</span>}</td>
                                  <td style={td}>{str(d.email) || <span style={muted}>blank</span>}</td>
                                  <td style={td}>{str(d.phone) || <span style={muted}>blank</span>}</td>
                                  <td style={{ ...td, maxWidth: 320 }} title={msg}>
                                    {msg ? (msg.length > 90 ? msg.slice(0, 90) + "..." : msg) : <span style={muted}>blank</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Snippet({ title, code, copied, onCopy }: { title: string; code: string; copied: boolean; onCopy: () => void }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{title}</span>
        <button onClick={onCopy} style={btnSmall}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 12,
          borderRadius: 9,
          border: "1px solid var(--border)",
          background: "var(--bg-hover)",
          color: "var(--text-secondary)",
          fontSize: 12,
          lineHeight: 1.5,
          overflowX: "auto",
          whiteSpace: "pre",
        }}
      >
        {code}
      </pre>
    </div>
  );
}

const th: React.CSSProperties = { padding: "6px 8px", fontWeight: 600, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "6px 8px", verticalAlign: "top", overflowWrap: "anywhere" };
