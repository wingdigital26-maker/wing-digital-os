"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { EVENT_LABELS, EVENT_TYPES, type EventType, type WorkflowRow } from "@/lib/automations/types";
import {
  ACTIVATE_WARNING,
  api,
  btn,
  btnPrimary,
  card,
  EmptyState,
  ErrorBox,
  errText,
  h1,
  input,
  jsonInit,
  muted,
  Notice,
  StatusPill,
  useLoad,
} from "./_ui";

// /automations: the list. One row per workflow, trigger in plain English,
// how many things it does, and what it did in the last week.

type Item = WorkflowRow & {
  actionCount: number;
  runs7d: { done: number; failed: number; total: number };
};

export default function AutomationsPage() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newTrigger, setNewTrigger] = useState<EventType>("form.submitted");
  const [notice, setNotice] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ workflows: Item[] }>("/api/automations");
      setItems(d.workflows ?? []);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useLoad(load);

  const setStatus = async (id: string, status: "active" | "paused") => {
    if (status === "active" && !window.confirm(ACTIVATE_WARNING)) return;
    setBusy(id);
    setNotice(null);
    try {
      await api("/api/automations", jsonInit("PATCH", { id, status }));
      await load();
      setNotice({
        kind: "ok",
        text: status === "active" ? "Activated. It will run the next time its trigger happens." : "Paused. It will not run until you activate it again.",
      });
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("create");
    try {
      const d = await api<{ workflow: WorkflowRow }>("/api/automations", jsonInit("POST", { name, trigger_type: newTrigger }));
      window.location.href = `/automations/${d.workflow.id}`;
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
      setBusy(null);
    }
  };

  const seed = async () => {
    setBusy("seed");
    setNotice(null);
    try {
      const d = await api<{ created?: string[]; skipped?: string[] }>("/api/automations/seed", { method: "POST" });
      const created = d.created ?? [];
      const skipped = d.skipped ?? [];
      if (created.length) {
        setNotice({
          kind: "ok",
          text: `Added ${created.length} draft automation${created.length === 1 ? "" : "s"}: ${created.join(", ")}.` +
            (skipped.length ? ` Already had: ${skipped.join(", ")}.` : ""),
        });
      } else {
        setNotice({ kind: "warn", text: `Nothing new to add. You already have: ${skipped.join(", ") || "the starter pack"}.` });
      }
      await load();
    } catch (e) {
      setNotice({ kind: "warn", text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const runsText = (r: Item["runs7d"]) => {
    if (!r || r.total === 0) return "has not run yet";
    const parts = [`${r.done} ran`];
    if (r.failed) parts.push(`${r.failed} failed`);
    return parts.join(", ") + " in the last 7 days";
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={h1}>Workflows</h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          An automation is: when something happens, do these things, with nobody at the keyboard.
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, margin: "18px 0", flexWrap: "wrap" }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
          placeholder="Name a new automation, e.g. Thank new leads"
          style={{ ...input, minWidth: 200, flex: "1 1 240px" }}
        />
        <select value={newTrigger} onChange={(e) => setNewTrigger(e.target.value as EventType)} style={{ ...input, flex: "1 1 200px" }}>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              When: {EVENT_LABELS[t].label}
            </option>
          ))}
        </select>
        <button onClick={create} disabled={busy === "create" || !newName.trim()} style={btnPrimary}>
          Create automation
        </button>
        <button
          onClick={seed}
          disabled={busy === "seed"}
          title="Adds four ready-made automations as drafts: missed call text-back, new website lead, booking confirmation, cold call booked"
          style={btn}
        >
          {busy === "seed" ? "Adding..." : "Add the starter pack"}
        </button>
      </div>

      {notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      {error && <ErrorBox what="automations" error={error} />}

      {items === null && !error && <div style={muted}>Loading...</div>}

      {items?.length === 0 && (
        <EmptyState>
          No automations yet. Create one above, or click Add the starter pack to get the four most useful ones as drafts.
        </EmptyState>
      )}

      <div style={{ display: "grid", gap: 10 }}>
        {items?.map((w) => {
          const trig = EVENT_LABELS[w.trigger_type as EventType];
          const filter = Object.entries(w.trigger_filter ?? {});
          return (
            <div key={w.id} style={{ ...card, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <Link href={`/automations/${w.id}`} style={{ textDecoration: "none", color: "inherit", flex: "1 1 260px", minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{w.name}</div>
                <div style={{ fontSize: 12.5, color: "var(--text-secondary)", marginTop: 3 }}>
                  When: {trig?.label ?? "an unknown trigger"}
                  {filter.length > 0 && (
                    <span style={{ color: "var(--text-muted)" }}>
                      {" "}(only when {filter.map(([k, v]) => `${k} is ${String(v)}`).join(" and ")})
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
                  {w.actionCount === 0 ? "Does nothing yet" : `Does ${w.actionCount} thing${w.actionCount === 1 ? "" : "s"}`}
                  {" · "}
                  {runsText(w.runs7d)}
                  {w.client_slug ? ` · for ${w.client_slug}` : ""}
                </div>
              </Link>
              <StatusPill status={w.status} />
              {w.status === "active" ? (
                <button onClick={() => setStatus(w.id, "paused")} disabled={busy === w.id} style={btn}>
                  Pause
                </button>
              ) : (
                <button
                  onClick={() => setStatus(w.id, "active")}
                  disabled={busy === w.id || w.actionCount === 0}
                  title={w.actionCount === 0 ? "Add at least one action first" : undefined}
                  style={btnPrimary}
                >
                  Activate
                </button>
              )}
              <Link href={`/automations/${w.id}`} style={{ ...btn, textDecoration: "none" }}>
                Edit
              </Link>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 20 }}>
        Texts and emails from automations are drafted, not sent, unless sending is switched on for this deployment.
        Deals, tags, tasks, and phone alerts happen for real as soon as an automation is active.
      </p>
    </div>
  );
}
