"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import type { TaskRow } from "@/lib/automations/types";
import {
  api,
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
  useLoad,
} from "../_ui";

// /automations/tasks: the open follow-ups, grouped by when they are due.
// Automations create most of these; a human can add one by hand too.

// Shape matches app/api/automations/tasks/route.ts: the contact comes
// embedded as crm_contacts.
type Task = TaskRow & {
  crm_contacts?: { business_name: string; contact_name: string | null; phone: string | null } | null;
};

type Group = "Overdue" | "Today" | "Later" | "No date";

function groupOf(t: Task): Group {
  if (!t.due_at) return "No date";
  const due = new Date(t.due_at);
  if (Number.isNaN(due.getTime())) return "No date";
  const now = new Date();
  if (due.getTime() < now.getTime()) return "Overdue";
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (due.getTime() <= endOfToday.getTime()) return "Today";
  return "Later";
}

function contactName(t: Task): string | null {
  return t.crm_contacts?.business_name ?? null;
}

const ORDER: Group[] = ["Overdue", "Today", "Later", "No date"];

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState({ title: "", due_at: "", contact_id: "" });

  const load = useCallback(async () => {
    try {
      const d = await api<unknown>("/api/automations/tasks");
      setTasks(pickList<Task>(d, "tasks", "items", "rows").filter((t) => !t.done_at));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useLoad(load);

  const done = async (t: Task) => {
    setBusy(String(t.id));
    setNotice(null);
    try {
      await api("/api/automations/tasks", jsonInit("PATCH", { id: t.id, done: true }));
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const add = async () => {
    const title = draft.title.trim();
    if (!title) return;
    const body: Record<string, unknown> = { title };
    if (draft.due_at) {
      const d = new Date(draft.due_at);
      if (Number.isNaN(d.getTime())) {
        setNotice({ kind: "warn", text: "That due date could not be read." });
        return;
      }
      body.due_at = d.toISOString();
    }
    if (draft.contact_id.trim()) {
      const n = Number(draft.contact_id.trim());
      if (!Number.isInteger(n) || n <= 0) {
        setNotice({ kind: "warn", text: "The contact id should be a whole number from the CRM." });
        return;
      }
      body.contact_id = n;
    }
    setBusy("add");
    setNotice(null);
    try {
      await api("/api/automations/tasks", jsonInit("POST", body));
      setDraft({ title: "", due_at: "", contact_id: "" });
      setNotice({ kind: "ok", text: "Task added." });
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const grouped = new Map<Group, Task[]>();
  for (const t of tasks ?? []) {
    const g = groupOf(t);
    grouped.set(g, [...(grouped.get(g) ?? []), t]);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={h1}>Tasks</h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Follow-ups that still need a human. Automations create most of them; mark one Done when it is handled.
        </span>
      </div>

      <div style={{ ...card, margin: "18px 0" }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Add a task</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 240px" }}>
            <span style={label}>What needs doing</span>
            <input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="Call back Hero's about the quote"
              style={{ ...input, width: "100%" }}
            />
          </div>
          <div style={{ flex: "1 1 200px" }}>
            <span style={label}>Due (optional)</span>
            <input type="datetime-local" value={draft.due_at} onChange={(e) => setDraft({ ...draft, due_at: e.target.value })} style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ flex: "1 1 140px" }}>
            <span style={label}>Contact id (optional)</span>
            <input value={draft.contact_id} onChange={(e) => setDraft({ ...draft, contact_id: e.target.value })} placeholder="4127" style={{ ...input, width: "100%" }} />
          </div>
        </div>
        <div style={{ marginTop: 10 }}>
          <button onClick={add} disabled={busy === "add" || !draft.title.trim()} style={btnPrimary}>Add task</button>
        </div>
      </div>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {error && <ErrorBox what="tasks" error={error} />}
      {tasks === null && !error && <div style={muted}>Loading...</div>}
      {tasks?.length === 0 && <EmptyState>Nothing is waiting on you. Open tasks will show up here as automations create them.</EmptyState>}

      {ORDER.map((g) => {
        const list = grouped.get(g);
        if (!list || list.length === 0) return null;
        const color = g === "Overdue" ? "var(--red)" : g === "Today" ? "var(--orange)" : "var(--text-secondary)";
        return (
          <section key={g} style={{ marginBottom: 22 }}>
            <h2 style={{ fontSize: 14, fontWeight: 700, margin: "0 0 8px", color }}>
              {g} <span style={{ fontWeight: 500, color: "var(--text-muted)" }}>({list.length})</span>
            </h2>
            <div style={{ display: "grid", gap: 8 }}>
              {list.map((t) => (
                <div key={t.id} style={{ ...card, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, overflowWrap: "anywhere" }}>{t.title}</div>
                    <div style={{ ...muted, marginTop: 3 }}>
                      {contactName(t) ? (
                        <Link href={`/?view=crm&contact=${t.contact_id ?? ""}`} style={{ color: "inherit" }}>{contactName(t)}</Link>
                      ) : t.contact_id != null ? (
                        `Contact ${t.contact_id}`
                      ) : (
                        "No contact attached"
                      )}
                      {t.due_at ? ` · due ${fmtWhen(t.due_at)}` : ""}
                      {t.client_slug ? ` · ${t.client_slug}` : ""}
                      {t.source?.startsWith("workflow:") ? " · created by an automation" : ""}
                    </div>
                    {t.body && <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 4 }}>{t.body}</div>}
                  </div>
                  <button onClick={() => done(t)} disabled={busy === String(t.id)} style={btnSmall}>Done</button>
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
