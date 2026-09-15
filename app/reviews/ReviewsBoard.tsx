"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import "./reviews.css";

// ───────────────────────────────────────────────────────────────────────────
// Reviews: set each client's Google review link (the write path round 1 never
// built) and see recent queued/requested review rows. This page sends
// NOTHING — it only writes clients.google_review_url and reads /api/reviews.
//
// HONESTY: an empty client list means "clients table not readable / no
// clients", never a fabricated row. A client with no link shows an empty
// input with a placeholder, never a fake example URL.
// ───────────────────────────────────────────────────────────────────────────

type ClientRow = { slug: string; name: string | null; google_review_url: string | null };
type SettingsResp = { ok: boolean; available: boolean; reason?: string; clients: ClientRow[] };

type ReviewRow = {
  id: number;
  client_slug: string;
  channel: string;
  status: string;
  rating: number | null;
  requested_at: string | null;
  created_at: string;
};
type ReviewsResp = {
  available: boolean;
  tableMissing: boolean;
  reason: string | null;
  reviews: ReviewRow[];
};

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

type SaveState = "idle" | "saving" | "saved" | "error";

function ClientRowEditor({
  client,
  onSaved,
}: {
  client: ClientRow;
  onSaved: (slug: string, url: string | null) => void;
}) {
  const [value, setValue] = useState(client.google_review_url ?? "");
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const dirty = value.trim() !== (client.google_review_url ?? "");

  const save = useCallback(async () => {
    setState("saving");
    setError(null);
    try {
      const r = await fetch("/api/reviews/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_slug: client.slug, google_review_url: value.trim() || null }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.ok) {
        setState("error");
        setError(d?.message ?? d?.error ?? `Save failed (${r.status}).`);
        return;
      }
      setState("saved");
      onSaved(client.slug, d.client?.google_review_url ?? (value.trim() || null));
      setTimeout(() => setState((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch (e) {
      setState("error");
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client.slug, client.google_review_url, value, onSaved]);

  return (
    <div className="rv-row">
      <div className="rv-row-head">
        <span className="rv-name">{client.name || client.slug}</span>
        <span className="rv-slug">{client.slug}</span>
      </div>
      <div className="rv-row-body">
        <label className="rv-label" htmlFor={`rv-url-${client.slug}`}>
          Google review link
        </label>
        <input
          id={`rv-url-${client.slug}`}
          className="rv-input"
          type="url"
          inputMode="url"
          placeholder="https://g.page/r/... or the Google Maps write-a-review link"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-describedby={error ? `rv-err-${client.slug}` : undefined}
        />
        <button
          className="rv-save"
          onClick={save}
          disabled={state === "saving" || !dirty}
          aria-label={`Save review link for ${client.name || client.slug}`}
        >
          {state === "saving" ? "Saving…" : state === "saved" && !dirty ? "Saved" : "Save"}
        </button>
      </div>
      {error && (
        <p className="rv-error" id={`rv-err-${client.slug}`}>
          {error}
        </p>
      )}
      {!client.google_review_url && !value && (
        <p className="rv-hint">No review link on file yet. Review requests for this client are held until one is set.</p>
      )}
    </div>
  );
}

export default function ReviewsBoard() {
  const [settings, setSettings] = useState<SettingsResp | null>(null);
  const [reviews, setReviews] = useState<ReviewsResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [sR, rR] = await Promise.all([
        fetch("/api/reviews/settings", { cache: "no-store" }),
        fetch("/api/reviews", { cache: "no-store" }),
      ]);
      setSettings(sR.ok ? await sR.json() : null);
      setReviews(rR.ok ? await rR.json() : null);
      if (!sR.ok && !rR.ok) {
        setErr(`Could not load this page (settings ${sR.status}, reviews ${rR.status}).`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const applySaved = useCallback((slug: string, url: string | null) => {
    setSettings((s) =>
      s
        ? { ...s, clients: s.clients.map((c) => (c.slug === slug ? { ...c, google_review_url: url } : c)) }
        : s
    );
  }, []);

  const clients = settings?.clients ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return clients;
    return clients.filter(
      (c) => c.slug.toLowerCase().includes(needle) || (c.name ?? "").toLowerCase().includes(needle)
    );
  }, [clients, q]);

  const missingCount = clients.filter((c) => !c.google_review_url).length;

  return (
    <div className="rv-wrap">
      <div className="rv-head">
        <button className="rv-refresh" onClick={load} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <Link href="/" className="rv-home">
          {"← Wing Digital OS"}
        </Link>
        <h1>Reviews</h1>
        <p>
          Attach each client&apos;s Google review link so review requests can go out with somewhere real to click.
          Setting a link here does not send anything by itself.
        </p>
      </div>

      {err && <div className="rv-note dead">{err}</div>}

      {/* ── Client review links ────────────────────────────────────── */}
      <section className="rv-section">
        <h2>Client review links</h2>
        {settings && !settings.available && (
          <div className="rv-note dead">{settings.reason ?? "Client roster is unavailable."}</div>
        )}

        {loading && !settings && (
          <div className="rv-skel-list" aria-busy="true" aria-label="Loading client list">
            {[0, 1, 2].map((i) => (
              <div className="skel" style={{ height: 92, borderRadius: 12, marginBottom: 10 }} key={i} />
            ))}
          </div>
        )}

        {settings?.available && (
          <>
            <div className="rv-stats">
              <div className="rv-stat">
                <div className="n">{clients.length}</div>
                <div className="l">clients</div>
              </div>
              <div className="rv-stat">
                <div className="n">{clients.length - missingCount}</div>
                <div className="l">have a link</div>
              </div>
              <div className="rv-stat">
                <div className="n">{missingCount}</div>
                <div className="l">missing a link</div>
              </div>
            </div>

            {clients.length > 3 && (
              <input
                className="rv-search"
                type="search"
                placeholder="Filter clients by name or slug"
                aria-label="Filter clients"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            )}

            {clients.length === 0 && (
              <div className="rv-note">No clients found in the roster. Add a client before setting a review link.</div>
            )}

            {clients.length > 0 && filtered.length === 0 && (
              <div className="rv-note">No client matches &quot;{q}&quot;.</div>
            )}

            {filtered.map((c) => (
              <ClientRowEditor key={c.slug} client={c} onSaved={applySaved} />
            ))}
          </>
        )}
      </section>

      {/* ── Recent review requests (read-only) ────────────────────────── */}
      <section className="rv-section">
        <h2>Recent review requests</h2>
        <p className="sub">The last requests queued or sent, from the same table the send pipeline reads. Read-only here.</p>

        {loading && !reviews && <div className="rv-loading">{"Loading…"}</div>}

        {reviews?.tableMissing && <div className="rv-note dead">{reviews.reason}</div>}
        {reviews && !reviews.available && !reviews.tableMissing && (
          <div className="rv-note dead">Review requests unavailable: {reviews.reason ?? "unknown reason"}.</div>
        )}

        {reviews?.available && reviews.reviews.length === 0 && (
          <div className="rv-note">No review requests have been queued yet.</div>
        )}

        {reviews?.available && reviews.reviews.length > 0 && (
          <div className="rv-tablewrap">
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Rating</th>
                  <th>Requested</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {reviews.reviews.slice(0, 100).map((r) => (
                  <tr key={r.id}>
                    <td className="co">{r.client_slug}</td>
                    <td>{r.channel}</td>
                    <td>
                      <span className="rv-badge">{r.status}</span>
                    </td>
                    <td>{r.rating ?? "—"}</td>
                    <td>{when(r.requested_at)}</td>
                    <td>{when(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
