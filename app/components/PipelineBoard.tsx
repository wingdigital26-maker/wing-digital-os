"use client";
import { useCallback, useEffect, useState } from "react";
import ContactsPanel, { ContactDetail } from "./pipeline/ContactsPanel";
import DealDetail from "./pipeline/DealDetail";
import {
  Deal, PipelinePayload, Stage, UNKNOWN_PERSON, countText, money, stageTotal,
} from "./pipeline/types";

// PIPELINE — the sales board that replaces the CRM GoHighLevel took with it
// when it was retired on 2026-08-22.
//
// Reads /api/pipeline, which reads the crm_* tables on the OS Supabase, so it
// works with the PC off. Two views: the stage board, and the contact database
// where dial-sheet call outcomes finally get logged against a real record.
//
// Honesty rules carried straight over from the schema:
//   * NULL is unknown. An unquoted deal says "not quoted"; it never shows $0,
//     because $0 is a number somebody actually recorded.
//   * An empty stage says it is empty. It never renders a placeholder card.
//   * A failed fetch shows the failure. It never degrades into a plausible
//     looking empty board, which would read as "no deals" and be a lie.
//
// Moving a card is a tap on a stage button, not a drag: Jack works leads from
// his phone and a drag-only board is unusable there.

type View = "board" | "contacts";

export default function PipelineBoard() {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("board");
  const [openDeal, setOpenDeal] = useState<{ deal: Deal; stageId: number } | null>(null);
  // The unified contact view, opened from a deal's "View contact" link.
  const [openContact, setOpenContact] = useState<number | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const res = await fetch("/api/pipeline");
      const data = (await res.json().catch(() => null)) as PipelinePayload | null;
      if (!res.ok) {
        setErr(data?.error || `Pipeline unavailable (HTTP ${res.status})`);
        setStages(null);
        return;
      }
      if (!data || data.error) {
        setErr(data?.error || "Pipeline unavailable: the API returned nothing readable.");
        setStages(null);
        return;
      }
      if (!Array.isArray(data.stages)) {
        setErr("Pipeline unavailable: the response carried no stages.");
        setStages(null);
        return;
      }
      const sorted = [...data.stages].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
      setStages(sorted);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStages(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Kicked off on a task boundary so the first paint is not a cascading render.
  useEffect(() => {
    const t = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(t);
  }, [load]);

  async function moveDeal(dealId: number, stageId: number) {
    const stage = stages?.find((s) => s.id === stageId);
    setMoving(true); setMoveError("");
    try {
      const body: Record<string, unknown> = { id: dealId, stage_id: stageId };
      // Terminal columns also settle the deal's status, so a won deal is not
      // left sitting as "open" in the Won column.
      if (stage?.is_won) body.status = "won";
      else if (stage?.is_lost) body.status = "lost";
      else body.status = "open";

      const res = await fetch("/api/pipeline/deals", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        setMoveError(data?.error || `Move failed (HTTP ${res.status})`);
        return;
      }
      setOpenDeal(null);
      await load();
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : String(e));
    } finally {
      setMoving(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {(["board", "contacts"] as View[]).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            style={{
              padding: "8px 14px", borderRadius: 999, fontSize: 14, cursor: "pointer",
              textTransform: "capitalize", background: "transparent",
              border: `1px solid ${view === v ? "var(--accent)" : "var(--border)"}`,
              color: view === v ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            {v === "board" ? "Pipeline" : "Contacts"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { void load(); }}
          style={{
            padding: "8px 14px", borderRadius: 999, fontSize: 14, cursor: "pointer",
            border: "1px solid var(--border)", background: "transparent",
            color: "var(--text-muted)", marginLeft: "auto",
          }}
        >
          Refresh
        </button>
      </div>

      {view === "contacts" ? (
        <ContactsPanel stages={stages ?? []} onChanged={() => { void load(); }} />
      ) : (
        <BoardView
          stages={stages}
          loading={loading}
          err={err}
          onOpen={(deal, stageId) => { setMoveError(""); setOpenDeal({ deal, stageId }); }}
        />
      )}

      {openDeal && (
        <DealDetail
          deal={openDeal.deal}
          stages={stages ?? []}
          currentStageId={openDeal.stageId}
          moving={moving}
          moveError={moveError}
          onClose={() => setOpenDeal(null)}
          onMove={(stageId) => { void moveDeal(openDeal.deal.id, stageId); }}
          onViewContact={(id) => { setOpenDeal(null); setOpenContact(id); }}
        />
      )}

      {openContact !== null && (
        <ContactDetail
          contactId={openContact}
          stages={stages ?? []}
          onClose={() => setOpenContact(null)}
          onDealCreated={() => { void load(); }}
        />
      )}
    </div>
  );
}

function BoardView({
  stages, loading, err, onOpen,
}: {
  stages: Stage[] | null;
  loading: boolean;
  err: string;
  onOpen: (deal: Deal, stageId: number) => void;
}) {
  if (err) {
    return (
      <div style={{
        border: "1px solid var(--red)", borderRadius: 12, padding: 16,
        background: "var(--bg-card)",
      }}>
        <div style={{ color: "var(--red)", fontWeight: 700, fontSize: 14 }}>
          Pipeline did not load
        </div>
        <div style={{ color: "var(--text-muted)", fontSize: 13, marginTop: 6 }}>{err}</div>
        <div style={{ color: "var(--text-muted)", fontSize: 12, marginTop: 6 }}>
          Nothing below is real until this clears. An empty board here would be a guess.
        </div>
      </div>
    );
  }
  if (loading && !stages) {
    return <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading pipeline</div>;
  }
  if (!stages || stages.length === 0) {
    return (
      <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
        No pipeline stages are configured yet
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridAutoFlow: "column",
        gridAutoColumns: "minmax(240px, 1fr)",
        gap: 12,
        overflowX: "auto",
        paddingBottom: 6,
      }}
    >
      {stages.map((stage) => {
        const deals = Array.isArray(stage.deals) ? stage.deals : [];
        const total = stageTotal(stage);
        const accent = stage.is_won
          ? "var(--green)"
          : stage.is_lost
            ? "var(--red)"
            : "var(--accent)";
        return (
          <section
            key={stage.id}
            style={{
              border: "1px solid var(--border)", borderRadius: 12,
              background: "var(--bg-card)", padding: 10,
              display: "grid", gap: 8, alignContent: "start",
              borderTop: `3px solid ${accent}`,
            }}
          >
            <header>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{stage.label}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                {countText(stage)}
                {total ? ` · ${total}` : ""}
              </div>
            </header>

            {deals.length === 0 ? (
              <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "6px 2px" }}>
                No deals in this stage
              </div>
            ) : (
              deals.map((deal) => {
                const c = deal.contact ?? null;
                const unquoted = deal.value_cents === null || deal.value_cents === undefined;
                return (
                  <button
                    key={deal.id}
                    type="button"
                    onClick={() => onOpen(deal, stage.id)}
                    style={{
                      textAlign: "left", cursor: "pointer", width: "100%",
                      border: "1px solid var(--border)", borderRadius: 10,
                      background: "transparent", color: "inherit", padding: 10,
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {c?.business_name ?? deal.title}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                      {c?.contact_name ? c.contact_name : UNKNOWN_PERSON}
                    </div>
                    <div style={{
                      fontSize: 13, marginTop: 4, fontWeight: 600,
                      color: unquoted ? "var(--text-muted)" : "var(--green)",
                    }}>
                      {money(deal.value_cents)}
                    </div>
                  </button>
                );
              })
            )}
          </section>
        );
      })}
    </div>
  );
}
