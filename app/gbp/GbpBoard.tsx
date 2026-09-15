"use client";
import { useCallback, useMemo, useState } from "react";
import "./gbp.css";
import { GBP_CLIENTS, GBP_DRAFTS, GBP_TYPE_LABEL, type GbpDraft, type GbpPostType } from "./gbpSeed";

// ───────────────────────────────────────────────────────────────────────────
// GBP (Google Business Profile) post STAGING board.
//
// Google Business Profile has no accessible free official posting API for a
// small operator (per specs/gbp-post-generator.md), so this is draft-and-
// stage only: it shows ready-to-post captions per client that a human copies
// and pastes into the Business Profile app or business.google.com themselves.
// This component sends nothing, calls no GBP API, and writes to no database.
// Copy pattern (copy-to-clipboard, disabled/error/copied states) mirrors
// app/reviews/ReviewsBoard.tsx.
//
// "Posted" here is a purely local, per-browser bookkeeping toggle (kept in
// localStorage) so a staff member can tick off what they already pasted
// without this board pretending to know the real GBP profile state. It is
// NOT synced anywhere and is honestly out of scope beyond that -- there is no
// staged-posts table backing this yet (the spec's own `staged/<date>-<slug>`
// filesystem convention was not wired to a UI data source in this pass).
// ───────────────────────────────────────────────────────────────────────────

const POSTED_KEY = "wingos.gbp.posted.v1";

function loadPosted(): Set<string> {
  try {
    const raw = window.localStorage.getItem(POSTED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch {
    return new Set();
  }
}

function savePosted(ids: Set<string>) {
  try {
    window.localStorage.setItem(POSTED_KEY, JSON.stringify([...ids]));
  } catch {
    // best-effort only; not fatal if storage is unavailable
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

type CopyState = "idle" | "copied" | "error";

function TypeChip({ type }: { type: GbpPostType }) {
  return (
    <span className="gbp-chip" data-type={type}>
      <span className="gbp-dot" aria-hidden />
      {GBP_TYPE_LABEL[type]}
    </span>
  );
}

function DraftCard({
  draft,
  posted,
  onTogglePosted,
}: {
  draft: GbpDraft;
  posted: boolean;
  onTogglePosted: (id: string) => void;
}) {
  const [state, setState] = useState<CopyState>("idle");

  const handleCopy = useCallback(async () => {
    const ok = await copyText(draft.caption);
    setState(ok ? "copied" : "error");
    setTimeout(() => setState((s) => (s === "idle" ? s : "idle")), 2200);
  }, [draft.caption]);

  return (
    <div className={`gbp-card${posted ? " gbp-card-posted" : ""}`}>
      <div className="gbp-card-head">
        <TypeChip type={draft.type} />
        <span className="gbp-week">Week {draft.week}</span>
        {posted && <span className="gbp-posted-badge">Posted</span>}
      </div>

      <p className="gbp-caption">{draft.caption}</p>

      <div className="gbp-meta">
        <span className="gbp-meta-item">
          <span className="gbp-meta-label">CTA button</span>
          <span className="gbp-meta-value">{draft.cta_button}</span>
        </span>
        {draft.needs_photo && (
          <span className="gbp-meta-item gbp-needs-photo">
            <span aria-hidden>&#128247;</span> Needs a photo before posting
          </span>
        )}
      </div>

      <div className="gbp-actions">
        <button type="button" className="gbp-copy" onClick={handleCopy}>
          {state === "copied" ? "Copied" : state === "error" ? "Copy failed" : "Copy caption"}
        </button>
        <button
          type="button"
          className="gbp-toggle"
          onClick={() => onTogglePosted(draft.id)}
          aria-pressed={posted}
        >
          {posted ? "Mark not posted" : "Mark posted"}
        </button>
      </div>
    </div>
  );
}

export default function GbpBoard() {
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [postedIds, setPostedIds] = useState<Set<string>>(() =>
    typeof window === "undefined" ? new Set() : loadPosted()
  );

  const togglePosted = useCallback((id: string) => {
    setPostedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      savePosted(next);
      return next;
    });
  }, []);

  const clients = GBP_CLIENTS;

  const filtered = useMemo(
    () => (clientFilter === "all" ? GBP_DRAFTS : GBP_DRAFTS.filter((d) => d.client_slug === clientFilter)),
    [clientFilter]
  );

  const byClient = useMemo(() => {
    const groups = new Map<string, GbpDraft[]>();
    for (const d of filtered) {
      const list = groups.get(d.client_slug) || [];
      list.push(d);
      groups.set(d.client_slug, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a.week - b.week);
    return groups;
  }, [filtered]);

  return (
    <div className="gbp-wrap">
      <header className="gbp-head">
        <h2>GBP posts</h2>
        <p>
          Ready-to-paste Google Business Profile captions per client. There is no free official posting API
          for a business this size, so nothing here posts itself. Copy a caption and paste it into the
          Business Profile app or business.google.com, attach a photo, then mark it posted so the board stays
          honest.
        </p>
      </header>

      <div className="gbp-note">
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1.4 }}>&#9432;</span>
        <p>
          One post per client per week is the target cadence, matching how long a standard GBP update stays
          live. &quot;Posted&quot; here is a local checkbox on this device only, not a real GBP status check.
        </p>
      </div>

      {clients.length > 1 && (
        <div className="gbp-filter" role="group" aria-label="Filter by client">
          <button
            type="button"
            className="gbp-filter-btn"
            aria-pressed={clientFilter === "all"}
            onClick={() => setClientFilter("all")}
          >
            All clients
          </button>
          {clients.map((c) => (
            <button
              key={c.slug}
              type="button"
              className="gbp-filter-btn"
              aria-pressed={clientFilter === c.slug}
              onClick={() => setClientFilter((cur) => (cur === c.slug ? "all" : c.slug))}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {clients.length === 0 && (
        <p className="gbp-empty">No GBP drafts staged yet.</p>
      )}

      {clients.length > 0 && byClient.size === 0 && (
        <p className="gbp-empty">No drafts for this client yet.</p>
      )}

      <div className="gbp-groups">
        {[...byClient.entries()].map(([slug, drafts]) => {
          const name = clients.find((c) => c.slug === slug)?.name || slug;
          return (
            <section key={slug} className="gbp-group">
              <h3 className="gbp-group-title">{name}</h3>
              <div className="gbp-grid">
                {drafts.map((d) => (
                  <DraftCard key={d.id} draft={d} posted={postedIds.has(d.id)} onTogglePosted={togglePosted} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
