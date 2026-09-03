"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { EVENT_LABELS, type EventType, type WorkflowRunRow } from "@/lib/automations/types";
import {
  api,
  btnSmall,
  card,
  EmptyState,
  ErrorBox,
  errText,
  fmtWhen,
  h1,
  muted,
  pickList,
  RunLog,
  StatusPill,
  useLoad,
} from "../_ui";

// /automations/runs: the last 100 runs across every workflow, newest first,
// plus how many events are still waiting for the engine. Shapes match
// app/api/automations/runs/route.ts: the workflow and the event that caused
// each run come embedded as `workflows` and `events`.

type Run = WorkflowRunRow & {
  workflows?: { name: string; client_slug: string | null } | null;
  events?: { type: string; client_slug: string | null; payload: Record<string, unknown> } | null;
};

function workflowName(r: Run): string {
  return r.workflows?.name ?? "An automation that no longer exists";
}

function triggerLabel(r: Run): string {
  const t = r.events?.type ?? "";
  return EVENT_LABELS[t as EventType]?.label ?? (t ? t : "unknown trigger");
}

function contactText(r: Run): string {
  const p = r.events?.payload ?? {};
  const name = typeof p.business_name === "string" && p.business_name ? p.business_name : null;
  if (name) return name;
  return r.contact_id != null ? `Contact ${r.contact_id}` : "no contact";
}

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ unprocessed_events?: number | null }>("/api/automations/runs?limit=100");
      setRuns(pickList<Run>(d, "runs", "items", "rows").slice(0, 100));
      setWaiting(typeof d?.unprocessed_events === "number" ? d.unprocessed_events : null);
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useLoad(load);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={h1}>Activity</h1>
        <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Every time an automation ran, what it did, and whether it worked. Newest first, last 100.
        </span>
      </div>

      <div style={{ margin: "18px 0" }}>
        {/* There is no "process by hand" switch: the engine's scheduled run
            picks these up on its own. Say so rather than offer a button that
            would have to lie. */}
        {waiting !== null && waiting > 0 && (
          <div style={{ ...card, borderColor: "var(--orange)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 240px" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                {waiting} event{waiting === 1 ? "" : "s"} waiting to be processed
              </div>
              <div style={{ ...muted, marginTop: 3 }}>They will be processed within 10 minutes.</div>
            </div>
            <button onClick={() => load()} style={btnSmall}>Refresh</button>
          </div>
        )}
        {waiting === 0 && <div style={muted}>Nothing is waiting. Every event has been looked at.</div>}
        {waiting === null && runs !== null && (
          <div style={muted}>The server did not say how many events are waiting, so that number is unknown here.</div>
        )}
      </div>

      {error && <ErrorBox what="activity" error={error} />}
      {runs === null && !error && <div style={muted}>Loading...</div>}
      {runs?.length === 0 && <EmptyState>No automation has run yet. Activate one and it will show up here the first time its trigger happens.</EmptyState>}

      <div style={{ display: "grid", gap: 8 }}>
        {runs?.map((r) => {
          const isOpen = open === r.id;
          return (
            <div key={r.id} style={card}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <StatusPill status={r.status} />
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>
                    {r.workflows ? (
                      <Link href={`/automations/${r.workflow_id}`} style={{ color: "inherit", textDecoration: "none" }}>{workflowName(r)}</Link>
                    ) : (
                      workflowName(r)
                    )}
                    {r.workflows?.client_slug ? <span style={{ ...muted, marginLeft: 6 }}>for {r.workflows.client_slug}</span> : null}
                  </div>
                  <div style={{ ...muted, marginTop: 2 }}>
                    When: {triggerLabel(r)}
                    {" · "}
                    {contactText(r)}
                    {" · "}
                    started {fmtWhen(r.started_at)}
                    {r.finished_at ? "" : r.status === "running" ? " · still running" : ""}
                  </div>
                </div>
                <button onClick={() => setOpen(isOpen ? null : r.id)} style={btnSmall}>{isOpen ? "Hide log" : "Show log"}</button>
              </div>
              {isOpen && <RunLog run={r} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
