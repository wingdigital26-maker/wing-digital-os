"use client";
import { useState } from "react";
import LogActivity from "./LogActivity";
import Timeline from "./Timeline";
import {
  Deal, Stage, money, UNKNOWN_EMAIL, UNKNOWN_PERSON, UNKNOWN_PHONE,
} from "./types";

// Deal detail sheet. Slides up on a phone, sits as a right-hand panel on a wide
// screen (both are the same element; the width just changes).

function Field({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
      <span style={{ textAlign: "right", color: muted ? "var(--text-muted)" : "inherit" }}>
        {value}
      </span>
    </div>
  );
}

export default function DealDetail({
  deal,
  stages,
  currentStageId,
  onClose,
  onMove,
  moveError,
  moving,
}: {
  deal: Deal;
  stages: Stage[];
  currentStageId: number;
  onClose: () => void;
  onMove: (stageId: number) => void;
  moveError: string;
  moving: boolean;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const c = deal.contact ?? null;
  const contactId = c ? c.id : null;

  return (
    <div
      role="dialog"
      aria-label={`Deal ${deal.title}`}
      style={{
        position: "fixed", inset: 0, zIndex: 60,
        display: "flex", justifyContent: "flex-end",
        background: "var(--accent-glow)",
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-card)",
          borderLeft: "1px solid var(--border)",
          width: "min(460px, 100%)",
          height: "100%",
          overflowY: "auto",
          padding: 16,
          boxSizing: "border-box",
          display: "grid",
          gap: 14,
          alignContent: "start",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              {c?.business_name ?? deal.title}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{deal.title}</div>
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

        <div style={{
          border: "1px solid var(--border)", borderRadius: 10, padding: 12,
          display: "grid", gap: 6,
        }}>
          <Field
            label="Value"
            value={money(deal.value_cents)}
            muted={deal.value_cents === null || deal.value_cents === undefined}
          />
          <Field
            label="Contact"
            value={c?.contact_name ? c.contact_name : UNKNOWN_PERSON}
            muted={!c?.contact_name}
          />
          <Field
            label="Phone"
            value={c?.phone ? c.phone : UNKNOWN_PHONE}
            muted={!c?.phone}
          />
          <Field
            label="Email"
            value={c?.email ? c.email : UNKNOWN_EMAIL}
            muted={!c?.email}
          />
          <Field
            label="City"
            value={c?.city ? c.city : "city unknown"}
            muted={!c?.city}
          />
          <Field
            label="Status"
            value={deal.status ? deal.status : "status unknown"}
            muted={!deal.status}
          />
        </div>

        <div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            Move to stage
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {stages.map((s) => {
              const on = s.id === currentStageId;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={on || moving}
                  onClick={() => onMove(s.id)}
                  style={{
                    padding: "8px 12px", borderRadius: 999, fontSize: 13,
                    cursor: on || moving ? "default" : "pointer",
                    border: `1px solid ${on ? "var(--accent)" : "var(--border)"}`,
                    color: on ? "var(--accent)" : "var(--text-muted)",
                    background: "transparent",
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          {moveError && (
            <div style={{ fontSize: 12, color: "var(--red)", marginTop: 6 }}>{moveError}</div>
          )}
        </div>

        {contactId === null ? (
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            This deal has no contact attached, so there is nothing to log activity against yet.
          </div>
        ) : (
          <LogActivity
            contactId={contactId}
            dealId={deal.id}
            onSaved={() => setReloadKey((k) => k + 1)}
          />
        )}

        <div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>
            Activity timeline
          </div>
          <Timeline contactId={contactId} dealId={deal.id} reloadKey={reloadKey} />
        </div>
      </div>
    </div>
  );
}
