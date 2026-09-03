"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ACTION_DEFS,
  ACTION_TYPES,
  EVENT_LABELS,
  EVENT_TYPES,
  MERGE_TAGS,
  TRIGGER_FILTER_KEYS,
  type ActionConfigField,
  type ActionType,
  type EventType,
  type WorkflowActionRow,
  type WorkflowRow,
  type WorkflowRunRow,
} from "@/lib/automations/types";
import {
  ACTIVATE_WARNING,
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
  RunLog,
  StatusPill,
  useLoad,
} from "../_ui";

// /automations/[id]: the editor. Reads top to bottom as one sentence:
// "When <trigger> (only if <filter>), then <action>, <action>, ..." with the
// recent runs underneath as proof of what it actually did.

type RunWithContact = WorkflowRunRow & { contact?: { id: number; business_name: string; contact_name: string | null } | null };
type StageOpt = { key: string; label: string };
type SeqOpt = { id: string; name: string };
type Config = Record<string, string>;

function toConfig(raw: Record<string, unknown> | null | undefined): Config {
  const out: Config = {};
  for (const [k, v] of Object.entries(raw ?? {})) out[k] = v === null || v === undefined ? "" : String(v);
  return out;
}

export default function AutomationEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [wf, setWf] = useState<WorkflowRow | null>(null);
  const [actions, setActions] = useState<WorkflowActionRow[]>([]);
  const [runs, setRuns] = useState<RunWithContact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Section 1: name + description
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [clientSlug, setClientSlug] = useState("");

  // Section 2: trigger
  const [trigger, setTrigger] = useState<EventType>("form.submitted");
  const [filter, setFilter] = useState<Config>({});

  // Section 3: actions
  const [stages, setStages] = useState<StageOpt[] | null>(null);
  const [sequences, setSequences] = useState<SeqOpt[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Config>>({});
  const [adding, setAdding] = useState<ActionType | "pick" | null>(null);
  const [newConfig, setNewConfig] = useState<Config>({});
  const [openRun, setOpenRun] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const d = await api<{ workflow: WorkflowRow; actions: WorkflowActionRow[]; runs: RunWithContact[] }>(
        `/api/automations/${encodeURIComponent(id)}`
      );
      setWf(d.workflow);
      setActions(d.actions ?? []);
      setRuns(d.runs ?? []);
      setName(d.workflow.name);
      setDescription(d.workflow.description ?? "");
      setClientSlug(d.workflow.client_slug ?? "");
      setTrigger((EVENT_TYPES as readonly string[]).includes(d.workflow.trigger_type) ? (d.workflow.trigger_type as EventType) : "manual.trigger");
      setFilter(toConfig(d.workflow.trigger_filter));
      const nextDrafts: Record<string, Config> = {};
      for (const a of d.actions ?? []) nextDrafts[a.id] = toConfig(a.config);
      setDrafts(nextDrafts);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, [id]);

  useLoad(load);

  // Stage and sequence pickers. Either failing falls back to a text input,
  // so the editor still works when the pipeline is unreachable.
  useEffect(() => {
    api<{ stages?: { key: string; label: string }[] }>("/api/pipeline")
      .then((d) => setStages((d.stages ?? []).map((s) => ({ key: s.key, label: s.label }))))
      .catch(() => setStages(null));
    api<{ sequences?: { id: string; name: string }[] }>("/api/sequences")
      .then((d) => setSequences((d.sequences ?? []).map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setSequences(null));
  }, []);

  const call = async (fn: () => Promise<unknown>, okText?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await load();
      if (okText) setNotice({ kind: "ok", text: okText });
      return true;
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveBasics = () =>
    call(
      () =>
        api("/api/automations", jsonInit("PATCH", { id, name: name.trim(), description, client_slug: clientSlug })),
      "Saved."
    );

  const saveTrigger = () =>
    call(() => api("/api/automations", jsonInit("PATCH", { id, trigger_type: trigger, trigger_filter: filter })), "Trigger saved.");

  const saveAction = (actionId: string) =>
    call(() => api("/api/automations/actions", jsonInit("PATCH", { id: actionId, config: drafts[actionId] ?? {} })), "Action saved.");

  const move = (actionId: string, dir: "up" | "down") =>
    call(() => api("/api/automations/actions", jsonInit("PATCH", { id: actionId, move: dir })));

  const removeAction = (actionId: string) => {
    if (!window.confirm("Remove this action from the automation?")) return;
    call(() => api(`/api/automations/actions?id=${encodeURIComponent(actionId)}`, { method: "DELETE" }));
  };

  const addAction = async () => {
    if (!adding || adding === "pick") return;
    const ok = await call(
      () => api("/api/automations/actions", jsonInit("POST", { workflow_id: id, action_type: adding, config: newConfig })),
      "Action added."
    );
    if (ok) {
      setAdding(null);
      setNewConfig({});
    }
  };

  const setStatus = (status: "active" | "paused") => {
    if (status === "active" && !window.confirm(ACTIVATE_WARNING)) return;
    return call(
      () => api("/api/automations", jsonInit("PATCH", { id, status })),
      status === "active" ? "Activated. It will run the next time its trigger happens." : "Paused."
    );
  };

  const removeWorkflow = async () => {
    if (!window.confirm("Delete this whole automation and its history? This cannot be undone.")) return;
    const ok = await call(() => api(`/api/automations?id=${encodeURIComponent(id)}`, { method: "DELETE" }));
    if (ok) window.location.href = "/automations";
  };

  const runOnContact = async () => {
    const raw = window.prompt("Run this automation on which contact? Enter the contact id (a number from the CRM).");
    if (raw === null) return;
    const contactId = Number(raw.trim());
    if (!Number.isInteger(contactId) || contactId <= 0) {
      setNotice({ kind: "warn", text: "That is not a contact id. It should be a whole number, like 4127." });
      return;
    }
    await call(
      () => api("/api/automations/run", jsonInit("POST", { workflow_id: id, contact_id: contactId })),
      `Ran on contact ${contactId}. The result is in Recent runs below.`
    );
  };

  if (error) return <ErrorBox what="this automation" error={error} />;
  if (!wf) return <div style={muted}>Loading...</div>;

  const filterKeys = TRIGGER_FILTER_KEYS[trigger] ?? [];
  const dirty =
    name.trim() !== wf.name || description !== (wf.description ?? "") || clientSlug !== (wf.client_slug ?? "");
  const triggerDirty =
    trigger !== wf.trigger_type || JSON.stringify(filter) !== JSON.stringify(toConfig(wf.trigger_filter));

  return (
    <div>
      <Link href="/automations" style={{ fontSize: 13, color: "var(--text-muted)", textDecoration: "none" }}>
        &larr; All automations
      </Link>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "10px 0 18px" }}>
        <h1 style={{ ...h1, overflowWrap: "anywhere" }}>{wf.name}</h1>
        <StatusPill status={wf.status} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {wf.status === "active" ? (
            <button onClick={() => setStatus("paused")} disabled={busy} style={btn}>Pause</button>
          ) : (
            <button
              onClick={() => setStatus("active")}
              disabled={busy || actions.length === 0}
              title={actions.length === 0 ? "Add at least one action first" : undefined}
              style={btnPrimary}
            >
              Activate
            </button>
          )}
          <button onClick={runOnContact} disabled={busy} style={btn} title="Fire this automation once, by hand, for one contact">
            Run on a contact
          </button>
          <button onClick={removeWorkflow} disabled={busy} style={{ ...btn, color: "var(--red)" }}>Delete</button>
        </div>
      </div>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}

      {/* 1. Name + description */}
      <Section title="What is it called?">
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <span style={label}>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, width: "100%" }} />
          </div>
          <div>
            <span style={label}>What it is for (optional, shown only to staff)</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              style={{ ...input, width: "100%", fontFamily: "inherit", resize: "vertical" }}
            />
          </div>
          <div>
            <span style={label}>Client (optional, leave blank for Wing itself)</span>
            <input
              value={clientSlug}
              onChange={(e) => setClientSlug(e.target.value)}
              placeholder="client slug, e.g. heros-junk"
              style={{ ...input, width: "100%", maxWidth: 320 }}
            />
          </div>
          <div>
            <button onClick={saveBasics} disabled={busy || !dirty || !name.trim()} style={btnPrimary}>Save</button>
          </div>
        </div>
      </Section>

      {/* 2. Trigger */}
      <Section title="When should it run?">
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <span style={label}>When this happens</span>
            <select
              value={trigger}
              onChange={(e) => {
                setTrigger(e.target.value as EventType);
                setFilter({});
              }}
              style={{ ...input, width: "100%", maxWidth: 480 }}
            >
              {EVENT_TYPES.map((t) => (
                <option key={t} value={t}>{EVENT_LABELS[t].label}</option>
              ))}
            </select>
            {EVENT_LABELS[trigger].hint && (
              <div style={{ ...muted, marginTop: 4 }}>{EVENT_LABELS[trigger].hint}</div>
            )}
          </div>
          {filterKeys.map((f) => (
            <div key={f.key}>
              <span style={label}>{f.label}</span>
              <input
                value={filter[f.key] ?? ""}
                onChange={(e) => setFilter({ ...filter, [f.key]: e.target.value })}
                placeholder="blank = any"
                style={{ ...input, width: "100%", maxWidth: 480 }}
              />
            </div>
          ))}
          {filterKeys.length === 0 && (
            <div style={muted}>This trigger runs on every event of its kind. There is nothing to narrow.</div>
          )}
          <div>
            <button onClick={saveTrigger} disabled={busy || !triggerDirty} style={btnPrimary}>Save trigger</button>
          </div>
        </div>
      </Section>

      {/* 3. Actions */}
      <Section title="Then do these things, in order">
        {actions.length === 0 && adding === null && (
          <EmptyState>This automation does nothing yet. Add the first action below.</EmptyState>
        )}
        <div style={{ display: "grid", gap: 10 }}>
          {actions.map((a, i) => {
            const def = ACTION_DEFS[a.action_type as ActionType];
            const draft = drafts[a.id] ?? {};
            const changed = JSON.stringify(draft) !== JSON.stringify(toConfig(a.config));
            return (
              <div key={a.id} style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-muted)" }}>{i + 1}.</span>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{def?.label ?? "An action this OS no longer recognises"}</span>
                  {def?.contacts_human && <HumanTag />}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button onClick={() => move(a.id, "up")} disabled={busy || i === 0} style={btnSmall}>Move up</button>
                    <button onClick={() => move(a.id, "down")} disabled={busy || i === actions.length - 1} style={btnSmall}>Move down</button>
                    <button onClick={() => removeAction(a.id)} disabled={busy} style={{ ...btnSmall, color: "var(--red)" }}>Delete</button>
                  </div>
                </div>
                {def?.hint && <div style={{ ...muted, marginTop: 4 }}>{def.hint}</div>}
                {def ? (
                  <>
                    <ConfigFields
                      fields={def.fields}
                      value={draft}
                      onChange={(next) => setDrafts({ ...drafts, [a.id]: next })}
                      stages={stages}
                      sequences={sequences}
                    />
                    <div style={{ marginTop: 10 }}>
                      <button onClick={() => saveAction(a.id)} disabled={busy || !changed} style={btnPrimary}>Save</button>
                    </div>
                  </>
                ) : (
                  <pre style={{ ...muted, whiteSpace: "pre-wrap", marginTop: 8 }}>{JSON.stringify(a.config, null, 2)}</pre>
                )}
              </div>
            );
          })}

          {adding === null && (
            <button onClick={() => setAdding("pick")} disabled={busy} style={{ ...btnPrimary, justifySelf: "start" }}>
              + Add an action
            </button>
          )}

          {adding === "pick" && (
            <div style={{ ...card, borderColor: "var(--accent)" }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>What should it do?</div>
              <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
                {ACTION_TYPES.map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setAdding(t);
                      setNewConfig({});
                    }}
                    style={{ ...btn, textAlign: "left", display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}
                  >
                    <span style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {ACTION_DEFS[t].label}
                      {ACTION_DEFS[t].contacts_human && <HumanTag />}
                    </span>
                    {ACTION_DEFS[t].hint && <span style={{ fontSize: 11.5, fontWeight: 500, color: "var(--text-muted)" }}>{ACTION_DEFS[t].hint}</span>}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 10 }}>
                <button onClick={() => setAdding(null)} disabled={busy} style={btn}>Cancel</button>
              </div>
            </div>
          )}

          {adding !== null && adding !== "pick" && (
            <div style={{ ...card, borderColor: "var(--accent)" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{ACTION_DEFS[adding].label}</span>
                {ACTION_DEFS[adding].contacts_human && <HumanTag />}
              </div>
              {ACTION_DEFS[adding].hint && <div style={{ ...muted, marginTop: 4 }}>{ACTION_DEFS[adding].hint}</div>}
              <ConfigFields
                fields={ACTION_DEFS[adding].fields}
                value={newConfig}
                onChange={setNewConfig}
                stages={stages}
                sequences={sequences}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button onClick={addAction} disabled={busy} style={btnPrimary}>Add this action</button>
                <button onClick={() => setAdding("pick")} disabled={busy} style={btn}>Pick a different one</button>
                <button onClick={() => setAdding(null)} disabled={busy} style={btn}>Cancel</button>
              </div>
            </div>
          )}
        </div>

        <div style={{ ...card, marginTop: 14, fontSize: 12.5, color: "var(--text-secondary)" }}>
          <strong>Personalization:</strong> write {MERGE_TAGS.map((t, i) => (
            <span key={t}>
              {i > 0 ? ", " : " "}
              <code>{t}</code>
            </span>
          ))}{" "}
          anywhere in a message, title, or note and the contact&apos;s real details fill in when it runs.
        </div>
      </Section>

      {/* 4. Recent runs */}
      <Section title="Recent runs">
        {runs.length === 0 ? (
          <EmptyState>This automation has not run yet. It runs when its trigger happens, or when you press Run on a contact.</EmptyState>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {runs.map((r) => {
              const open = openRun === r.id;
              return (
                <div key={r.id} style={card}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <StatusPill status={r.status} />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {r.contact ? r.contact.business_name : r.contact_id != null ? `Contact ${r.contact_id}` : "No contact"}
                    </span>
                    <span style={muted}>{fmtWhen(r.started_at)}</span>
                    <button onClick={() => setOpenRun(open ? null : r.id)} style={{ ...btnSmall, marginLeft: "auto" }}>
                      {open ? "Hide details" : "Show details"}
                    </button>
                  </div>
                  {open && <RunLog run={r} />}
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 26 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: "0 0 10px" }}>{title}</h2>
      {children}
    </section>
  );
}

function HumanTag() {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: "var(--orange)",
        border: "1px solid var(--orange)",
        borderRadius: 999,
        padding: "1px 8px",
        whiteSpace: "nowrap",
      }}
    >
      contacts the person
    </span>
  );
}

function ConfigFields({
  fields,
  value,
  onChange,
  stages,
  sequences,
}: {
  fields: ActionConfigField[];
  value: Config;
  onChange: (next: Config) => void;
  stages: StageOpt[] | null;
  sequences: SeqOpt[] | null;
}) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v });
  return (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      {fields.map((f) => {
        const v = value[f.key] ?? "";
        const lab = (
          <span style={label}>
            {f.label}
            {f.required ? "" : " (optional)"}
          </span>
        );
        if (f.kind === "textarea") {
          return (
            <div key={f.key}>
              {lab}
              <textarea value={v} onChange={(e) => set(f.key, e.target.value)} rows={4} style={{ ...input, width: "100%", fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }} />
              {f.hint && <div style={{ ...muted, marginTop: 3 }}>{f.hint}</div>}
            </div>
          );
        }
        if (f.kind === "number") {
          return (
            <div key={f.key}>
              {lab}
              <input type="number" min={0} value={v} onChange={(e) => set(f.key, e.target.value)} style={{ ...input, width: 120 }} />
              {f.hint && <div style={{ ...muted, marginTop: 3 }}>{f.hint}</div>}
            </div>
          );
        }
        if (f.kind === "stage" && stages && stages.length) {
          return (
            <div key={f.key}>
              {lab}
              <select value={v} onChange={(e) => set(f.key, e.target.value)} style={{ ...input, width: "100%", maxWidth: 360 }}>
                <option value="">Pick a stage</option>
                {stages.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          );
        }
        if (f.kind === "sequence" && sequences && sequences.length) {
          return (
            <div key={f.key}>
              {lab}
              <select value={v} onChange={(e) => set(f.key, e.target.value)} style={{ ...input, width: "100%", maxWidth: 360 }}>
                <option value="">Pick a sequence</option>
                {sequences.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          );
        }
        // text, url, or a stage/sequence picker whose list could not load.
        const fallbackHint =
          f.kind === "stage"
            ? "The pipeline stages could not be loaded, so type the stage key (for example: new, booked)."
            : f.kind === "sequence"
            ? "The sequence list could not be loaded, so paste the sequence id."
            : f.kind === "url"
            ? "Must start with https://"
            : f.hint;
        return (
          <div key={f.key}>
            {lab}
            <input value={v} onChange={(e) => set(f.key, e.target.value)} style={{ ...input, width: "100%" }} placeholder={f.kind === "url" ? "https://" : undefined} />
            {fallbackHint && <div style={{ ...muted, marginTop: 3 }}>{fallbackHint}</div>}
          </div>
        );
      })}
    </div>
  );
}
