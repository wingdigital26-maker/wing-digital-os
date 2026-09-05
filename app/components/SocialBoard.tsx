"use client";
import { useCallback, useEffect, useState, type CSSProperties } from "react";

// SOCIAL POSTS -- draft and schedule social posts per client, then mark them
// posted once a human has actually put them up.
//
// Talks to /api/social. This module DRAFTS AND SCHEDULES ONLY. It never
// publishes to any social network and connects to no social API. "Posted" here
// means a person came back and said "I posted this myself". Status flow is
// draft -> scheduled -> posted.

type Post = {
  id: number;
  client_slug: string | null;
  platform: string;
  caption: string;
  image_url: string | null;
  scheduled_for: string | null;
  status: string;
  posted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const PLATFORMS: [string, string][] = [
  ["facebook", "Facebook"], ["instagram", "Instagram"], ["google", "Google"],
  ["nextdoor", "Nextdoor"], ["other", "Other"],
];
const PLATFORM_LABEL: Record<string, string> = Object.fromEntries(PLATFORMS);

// The board columns, in the order a post travels through them.
const COLUMNS: { key: string; label: string; color: string; blurb: string }[] = [
  { key: "draft", label: "Draft", color: "var(--text-muted)", blurb: "Written, no date yet." },
  { key: "scheduled", label: "Scheduled", color: "var(--orange)", blurb: "Has a target date. Someone still posts it by hand." },
  { key: "posted", label: "Posted", color: "var(--green)", blurb: "A person marked this as posted." },
];

const input: CSSProperties = {
  background: "var(--bg-secondary)", color: "var(--text-primary)", border: "1px solid var(--border)",
  borderRadius: 10, padding: "10px 12px", fontSize: 13.5, fontFamily: "inherit",
};
const btn: CSSProperties = {
  border: "1px solid var(--border)", background: "transparent", color: "var(--text-primary)",
  borderRadius: 9, padding: "6px 12px", fontSize: 12.5, cursor: "pointer", fontFamily: "inherit",
};
const primary: CSSProperties = {
  ...btn, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--bg-primary)", fontWeight: 700,
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export default function SocialBoard() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [missing, setMissing] = useState(false);

  // Composer
  const [clientSlug, setClientSlug] = useState("");
  const [platform, setPlatform] = useState("facebook");
  const [caption, setCaption] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");
  const [saving, setSaving] = useState(false);
  const [addErr, setAddErr] = useState("");

  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowErr, setRowErr] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/social");
      const d = await r.json();
      if (d.missingTable) { setMissing(true); setPosts([]); setLoadErr(""); return; }
      if (!r.ok) { setLoadErr(d.message || d.error || `HTTP ${r.status}`); return; }
      setMissing(false);
      setPosts(d.posts || []);
      setLoadErr("");
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function add() {
    const cap = caption.trim();
    if (!cap || saving) return;
    setAddErr("");
    setSaving(true);
    try {
      const r = await fetch("/api/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_slug: clientSlug.trim() || null,
          platform,
          caption: cap,
          image_url: imageUrl.trim() || null,
          scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        }),
      });
      const d = await r.json();
      if (d.missingTable) { setMissing(true); setAddErr("Run migration 0028_social_posts.sql first."); return; }
      if (!r.ok || !d.post) { setAddErr(d.message || d.error || `HTTP ${r.status}`); return; }
      setCaption("");
      setImageUrl("");
      setScheduledFor("");
      await load();
    } catch (e) {
      setAddErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function save(id: number, patch: Record<string, unknown>) {
    setBusyId(id);
    setRowErr((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch("/api/social", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      const d = await r.json();
      if (!r.ok) { setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` })); return; }
      await load();
    } catch (e) {
      setRowErr((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: number) {
    if (!window.confirm("Delete this post draft? This cannot be undone.")) return;
    setBusyId(id);
    setRowErr((m) => ({ ...m, [id]: "" }));
    try {
      const r = await fetch(`/api/social?id=${id}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok) { setRowErr((m) => ({ ...m, [id]: d.message || d.error || `HTTP ${r.status}` })); return; }
      setPosts((ps) => (ps ? ps.filter((p) => p.id !== id) : ps));
    } catch (e) {
      setRowErr((m) => ({ ...m, [id]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusyId(null);
    }
  }

  const list = posts || [];
  const byStatus = (s: string) => list.filter((p) => p.status === s);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, letterSpacing: "-0.01em" }}>Social posts</h2>
        <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Draft and schedule posts per client, then mark them posted once you have put them up.
        </span>
      </header>

      {/* The one rule that matters here, said plainly and always visible. */}
      <div style={{
        display: "flex", gap: 10, alignItems: "flex-start",
        background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px",
      }}>
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1.4 }}>&#9432;</span>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          This board never posts anything for you. It holds your drafts and your plan. When you have posted
          one yourself on the real platform, mark it Posted so the board stays honest.
        </p>
      </div>

      {/* Composer */}
      <form
        onSubmit={(e) => { e.preventDefault(); add(); }}
        style={{
          display: "flex", flexDirection: "column", gap: 10,
          background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, padding: 14,
        }}
      >
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={clientSlug}
            onChange={(e) => setClientSlug(e.target.value)}
            placeholder="Client (e.g. heros-junk), optional"
            autoComplete="off"
            style={{ ...input, flex: "1 1 200px" }}
          />
          <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ ...input, flex: "0 1 160px" }} aria-label="Platform">
            {PLATFORMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.target.value)}
            aria-label="Target date and time (optional)"
            style={{ ...input, flex: "0 1 220px" }}
          />
        </div>
        <textarea
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          placeholder="Write the caption..."
          rows={3}
          style={{ ...input, resize: "vertical", width: "100%", boxSizing: "border-box" }}
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="Image URL (optional), e.g. https://..."
            inputMode="url"
            autoComplete="off"
            style={{ ...input, flex: "1 1 260px" }}
          />
          <button type="submit" disabled={saving || !caption.trim()} style={{ ...primary, padding: "10px 18px", opacity: saving || !caption.trim() ? 0.6 : 1 }}>
            {saving ? "Saving..." : scheduledFor ? "Schedule draft" : "Save draft"}
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
          Add a date to schedule it, or leave it blank to keep it as a plain draft.
        </p>
        {addErr && <p style={{ margin: 0, fontSize: 12.5, color: "var(--red)" }}>{addErr}</p>}
      </form>

      {/* States */}
      {loadErr && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, background: "var(--bg-card)", display: "grid", gap: 8, maxWidth: 560 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Social posts could not be loaded</div>
          <div style={{ fontSize: 13, color: "var(--red)", lineHeight: 1.5 }}>{loadErr}</div>
          <div><button type="button" onClick={load} style={btn}>Retry</button></div>
        </div>
      )}

      {!loadErr && missing && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 14, padding: 16, background: "var(--bg-card)", display: "grid", gap: 8, maxWidth: 560 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>The social posts table is not in the database yet</div>
          <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            Apply migration <code>0028_social_posts.sql</code>, then reload. Your drafts will appear here.
          </div>
          <div><button type="button" onClick={load} style={btn}>Reload</button></div>
        </div>
      )}

      {!loadErr && !missing && posts === null && (
        <div style={{ display: "grid", gap: 12 }} aria-label="Loading social posts">
          {[0, 1].map((i) => <div key={i} className="skel" style={{ height: 120, borderRadius: 14 }} />)}
        </div>
      )}

      {/* Board */}
      {!loadErr && !missing && posts !== null && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, alignItems: "start" }}>
          {COLUMNS.map((col) => {
            const items = byStatus(col.key);
            return (
              <section key={col.key} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: col.color, display: "inline-block" }} />
                  <h3 style={{ margin: 0, fontSize: 14, color: col.color }}>{col.label}</h3>
                  <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{items.length}</span>
                </div>
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>{col.blurb}</p>
                {items.length === 0 ? (
                  <p style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "16px 0", textAlign: "center", border: "1px dashed var(--border)", borderRadius: 12 }}>
                    {col.key === "draft" ? "No drafts yet. Write one above." :
                     col.key === "scheduled" ? "Nothing scheduled. Add a date to a draft." :
                     "Nothing marked posted yet."}
                  </p>
                ) : (
                  items.map((p) => (
                    <PostCard
                      key={p.id}
                      post={p}
                      busy={busyId === p.id}
                      err={rowErr[p.id] || ""}
                      onSave={save}
                      onRemove={remove}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PostCard({ post: p, busy, err, onSave, onRemove }: {
  post: Post;
  busy: boolean;
  err: string;
  onSave: (id: number, patch: Record<string, unknown>) => void;
  onRemove: (id: number) => void;
}) {
  const sub = [p.client_slug, PLATFORM_LABEL[p.platform] || p.platform].filter(Boolean).join(" · ");

  return (
    <div style={{
      background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14,
      padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, minWidth: 0,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub || "No client"}
        </span>
        {p.status === "posted" && p.posted_at ? (
          <span style={{ fontSize: 11, color: "var(--green)" }}>Posted {fmtDate(p.posted_at)}</span>
        ) : p.scheduled_for ? (
          <span style={{ fontSize: 11, color: "var(--orange)" }}>{fmtDate(p.scheduled_for)}</span>
        ) : null}
      </div>

      {p.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.image_url}
          alt=""
          style={{ width: "100%", maxHeight: 180, objectFit: "cover", borderRadius: 10, border: "1px solid var(--border)" }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
      )}

      <p style={{ margin: 0, fontSize: 13, color: "var(--text-primary)", lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {p.caption}
      </p>

      {err && <p style={{ margin: 0, fontSize: 12, color: "var(--red)" }}>{err}</p>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", paddingTop: 6, borderTop: "1px solid var(--border)" }}>
        {p.status !== "scheduled" && p.status !== "posted" && (
          <button type="button" disabled={busy} onClick={() => onSave(p.id, { status: "scheduled" })} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
            Move to scheduled
          </button>
        )}
        {p.status !== "posted" && (
          <button type="button" disabled={busy} onClick={() => onSave(p.id, { status: "posted" })} style={{ ...primary, opacity: busy ? 0.6 : 1 }}>
            Mark posted
          </button>
        )}
        {p.status === "posted" && (
          <button type="button" disabled={busy} onClick={() => onSave(p.id, { status: p.scheduled_for ? "scheduled" : "draft" })} style={{ ...btn, opacity: busy ? 0.6 : 1 }}>
            Un-post
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => onRemove(p.id)} style={{ ...btn, marginLeft: "auto", color: "var(--red)", borderColor: "transparent" }}>
          Delete
        </button>
      </div>
    </div>
  );
}
