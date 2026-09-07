"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./problems.css";

// ───────────────────────────────────────────────────────────────────────────
// The problems view: see them and handle them, in the window.
//
// The stage says "6 things need attention". This is where that sentence opens
// into the actual list, and where each one can be handed to Nimbus with "Look
// into it": he investigates on the PC, fixes what is safe to fix, and comes
// back with what he found and what is left for Jack.
//
// HONESTY: everything here comes from /api/nimbus/problems, which is the
// watch's own output. Nothing is summarised into a number, no problem is hidden
// because it is inconvenient, and a check that could not run is shown as such
// rather than counted as healthy.
// ───────────────────────────────────────────────────────────────────────────

type TriageStep = { at: string; kind: "looked" | "ran" | "fixed" | "blocked"; text: string };
export type Triage = {
  problemId: string;
  status: "investigating" | "fixed" | "needs_you" | "failed";
  summary: string;
  steps: TriageStep[];
  nextStep: string | null;
  proposedCommand: string | null;
  finishedAt: string | null;
};
type Problem = {
  id: string;
  label: string;
  detail: string;
  fix: string | null;
  link: { label: string; href: string } | null;
  severity: "high" | "normal";
  triage: Triage | null;
};
type Payload = {
  ok?: boolean;
  asOf?: string;
  headline?: string;
  problems?: Problem[];
  unknowns?: { id: string; label: string; reason: string }[];
  error?: string;
};

const STATUS_WORD: Record<Triage["status"], string> = {
  investigating: "Looking into it",
  fixed: "Fixed it",
  needs_you: "Needs you",
  failed: "Could not settle it",
};

export default function ProblemsPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/nimbus/problems", { cache: "no-store" });
      const j = (await r.json()) as Payload;
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setData(j);
      setLoadError(null);
    } catch (e) {
      // Say what failed. An empty list would read as "nothing is wrong", which
      // is the one thing this panel must never imply by accident.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    // Fetching the list IS the point of opening this panel: the effect is
    // subscribing to an external system (the watch), not deriving state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // While something is being investigated, keep the list moving so the steps
  // appear as they happen rather than after the fact.
  const anyRunning = (data?.problems ?? []).some((p) => p.triage?.status === "investigating");
  useEffect(() => {
    if (!anyRunning) return;
    // load() sets state, which is the whole point: this is a subscription to an
    // external process (the triage agent), not a render-time computation.
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [anyRunning, load]);

  const lookInto = useCallback(
    async (id: string) => {
      setBusy(id);
      setOpen(id);
      try {
        const r = await fetch("/api/nimbus/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ problemId: id }),
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        load();
      }
    },
    [load]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ask = (text: string) => window.dispatchEvent(new CustomEvent("jarvis:ask", { detail: text }));

  const problems = data?.problems ?? [];
  const unknowns = data?.unknowns ?? [];

  // Portalled to the body on purpose: the stage is a fixed, overflow-hidden
  // layer, so a scrim rendered inside it is trapped in that stacking context
  // and the chat below shows through undimmed.
  return createPortal(
    <div
      className="np-scrim"
      onMouseDown={(e) => {
        // Only a click on the scrim itself closes it, never a click that
        // started inside the list and happened to end on the edge.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="np-wrap" role="dialog" aria-modal="true" aria-label="Problems">
      <div className="np-head">
        <span className="np-title">{data?.headline ?? (loadError ? "The checks could not run" : "Checking...")}</span>
        <button type="button" className="np-x" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      {loadError ? (
        <div className="np-empty">
          <b>I could not run the checks just now.</b>
          <span>{loadError}</span>
          <button type="button" className="np-btn" onClick={load}>
            Try again
          </button>
        </div>
      ) : null}

      <div className="np-list">
        {problems.map((p) => {
          const t = p.triage;
          const isOpen = open === p.id;
          return (
            <div key={p.id} className={"np-item" + (p.severity === "high" ? " np-item-high" : "")}>
              <button type="button" className="np-item-head" onClick={() => setOpen(isOpen ? null : p.id)}>
                <span className="np-dot" />
                <span className="np-label">{p.label}</span>
                {t ? <span className={"np-badge np-" + t.status}>{STATUS_WORD[t.status]}</span> : null}
              </button>

              {isOpen ? (
                <div className="np-body">
                  <p className="np-detail">{p.detail}</p>
                  {p.fix ? (
                    <p className="np-fix">
                      <b>Fix:</b> {p.fix}
                    </p>
                  ) : null}

                  {t ? (
                    <div className="np-triage">
                      <p className="np-summary">{t.summary}</p>
                      {t.steps.length ? (
                        <ul className="np-steps">
                          {t.steps.slice(-6).map((s, i) => (
                            <li key={i} className={"np-step np-step-" + s.kind}>
                              {s.text}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {t.nextStep && t.status !== "fixed" ? (
                        <p className="np-next">
                          <b>Next:</b> {t.nextStep}
                        </p>
                      ) : null}
                      {t.proposedCommand ? (
                        <code
                          className="np-cmd"
                          title="Click to copy"
                          onClick={() => navigator.clipboard?.writeText(t.proposedCommand as string)}
                        >
                          {t.proposedCommand}
                        </code>
                      ) : null}
                    </div>
                  ) : null}

                  <div className="np-actions">
                    <button
                      type="button"
                      className="np-btn np-btn-primary"
                      disabled={busy === p.id || t?.status === "investigating"}
                      onClick={() => lookInto(p.id)}
                    >
                      {t?.status === "investigating" ? "Looking..." : t ? "Look again" : "Look into it"}
                    </button>
                    <button
                      type="button"
                      className="np-btn"
                      onClick={() => ask(`About "${p.label}": ${p.detail} What exactly do I do about it?`)}
                    >
                      Ask me
                    </button>
                    {p.link ? (
                      <a className="np-btn" href={p.link.href}>
                        {p.link.label}
                      </a>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {unknowns.map((u) => (
          <div key={u.id} className="np-item np-item-unknown">
            <div className="np-item-head np-item-static">
              <span className="np-dot np-dot-unknown" />
              <span className="np-label">{u.label} could not be checked</span>
            </div>
            <p className="np-detail np-detail-inline">{u.reason}</p>
          </div>
        ))}

        {!loadError && problems.length === 0 && unknowns.length === 0 && data ? (
          <div className="np-empty">
            <b>Nothing is broken in anything I watch.</b>
            <span>Checked just now.</span>
          </div>
        ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
