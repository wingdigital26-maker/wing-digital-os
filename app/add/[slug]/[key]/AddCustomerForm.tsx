"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Recent = { name: string; added: string };
type Saved = { name: string; created: boolean; reviewQueued: boolean; reviewNote: string | null; warning: string | null };

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function niceDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const EMPTY = { name: "", phone: "", email: "", service: "", job_date: "", city: "", notes: "" };

export default function AddCustomerForm({ slug, accessKey }: { slug: string; accessKey: string }) {
  const [f, setF] = useState({ ...EMPTY, job_date: todayLocal() });
  const [reviewOk, setReviewOk] = useState(true);
  const [hp, setHp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ field?: string; message: string } | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [recent, setRecent] = useState<Recent[] | null>(null);
  const [recentError, setRecentError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  const loadRecent = useCallback(async () => {
    try {
      const r = await fetch(`/api/intake/${encodeURIComponent(slug)}`, {
        headers: { "x-client-key": accessKey },
        cache: "no-store",
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.message || "We couldn't load your recent customers just now.");
      setRecent(j.recent as Recent[]);
      setRecentError(null);
    } catch (e) {
      setRecentError(e instanceof Error ? e.message : "We couldn't load your recent customers just now.");
    }
  }, [slug, accessKey]);

  useEffect(() => {
    loadRecent();
  }, [loadRecent]);

  useEffect(() => {
    if (saved) doneRef.current?.focus();
  }, [saved]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!f.name.trim()) return setError({ field: "name", message: "Please enter the customer's name." });
    if (!f.phone.trim() && !f.email.trim()) {
      return setError({ field: "phone", message: "Please add a phone number or an email so we can reach them." });
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/intake/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-client-key": accessKey },
        body: JSON.stringify({ ...f, review_ok: reviewOk, _hp: hp }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) {
        setError({
          field: j?.field,
          message: j?.message || "Something went wrong and the customer was NOT saved. Please try again.",
        });
        return;
      }
      setSaved({
        name: f.name.trim().split(/\s+/)[0],
        created: !!j.created,
        reviewQueued: !!j.review_queued,
        reviewNote: j.review_note ?? null,
        warning: j.warning ?? null,
      });
      loadRecent();
    } catch {
      setError({ message: "We couldn't reach the server, so the customer was NOT saved. Check your signal and try again." });
    } finally {
      setBusy(false);
    }
  }

  function addAnother() {
    setF({ ...EMPTY, job_date: todayLocal() });
    setReviewOk(true);
    setSaved(null);
    setError(null);
    setTimeout(() => nameRef.current?.focus(), 0);
  }

  const bad = (k: string) => (error?.field === k ? true : undefined);

  return (
    <>
      {saved ? (
        <section className="ac-card ac-done" aria-live="polite">
          <div className="ac-check" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </div>
          <h1 className="ac-h1" tabIndex={-1} ref={doneRef}>
            {saved.created ? `${saved.name} is saved` : `${saved.name} was already on your list`}
          </h1>
          <p className="ac-sub">
            {saved.created
              ? "They're on your customer list now."
              : "We added this job to their record instead of making a second copy."}{" "}
            {saved.reviewQueued && "They're in line for a review request. We space those out so your reviews come in at a natural pace."}
            {saved.reviewNote === "already_asked" && "They've already been asked for a review, so we won't ask again."}
          </p>
          {saved.warning && <p className="ac-warn">{saved.warning}</p>}
          <button type="button" className="ac-btn" onClick={addAnother}>Add another customer</button>
        </section>
      ) : (
        <form className="ac-card" onSubmit={submit} noValidate>
          <h1 className="ac-h1">Add a customer</h1>
          <p className="ac-sub">Just finished a job? Add the customer here. It takes under a minute.</p>

          <div className="ac-field">
            <label htmlFor="ac-name">Customer name <span className="ac-req">required</span></label>
            <input id="ac-name" ref={nameRef} autoComplete="off" autoCapitalize="words" value={f.name} onChange={set("name")} aria-invalid={bad("name")} placeholder="Jane Smith" />
          </div>

          <p className="ac-hint">Add a phone number, an email, or both.</p>
          <div className="ac-row">
            <div className="ac-field">
              <label htmlFor="ac-phone">Phone</label>
              <input id="ac-phone" type="tel" inputMode="tel" autoComplete="off" value={f.phone} onChange={set("phone")} aria-invalid={bad("phone")} placeholder="(214) 555-0123" />
            </div>
            <div className="ac-field">
              <label htmlFor="ac-email">Email</label>
              <input id="ac-email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" value={f.email} onChange={set("email")} aria-invalid={bad("email")} placeholder="jane@example.com" />
            </div>
          </div>

          <div className="ac-field">
            <label htmlFor="ac-service">What did you do for them?</label>
            <input id="ac-service" autoComplete="off" value={f.service} onChange={set("service")} placeholder="Garage cleanout, roof repair..." />
          </div>

          <div className="ac-row">
            <div className="ac-field">
              <label htmlFor="ac-date">Job date</label>
              <input id="ac-date" type="date" max={todayLocal()} value={f.job_date} onChange={set("job_date")} aria-invalid={bad("job_date")} />
            </div>
            <div className="ac-field">
              <label htmlFor="ac-city">City <span className="ac-opt">optional</span></label>
              <input id="ac-city" autoComplete="off" autoCapitalize="words" value={f.city} onChange={set("city")} placeholder="Plano" />
            </div>
          </div>

          <div className="ac-field">
            <label htmlFor="ac-notes">Notes <span className="ac-opt">optional</span></label>
            <textarea id="ac-notes" rows={3} value={f.notes} onChange={set("notes")} placeholder="Anything worth remembering about this customer" />
          </div>

          {/* Honeypot: hidden from people and screen readers; bots fill it. */}
          <div className="ac-hp" aria-hidden="true">
            <label htmlFor="ac-hp">Leave this empty</label>
            <input id="ac-hp" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} />
          </div>

          <label className="ac-check-row">
            <input type="checkbox" checked={reviewOk} onChange={(e) => setReviewOk(e.target.checked)} />
            <span>OK to ask this customer for a review</span>
          </label>

          <p className="ac-consent">
            By adding this customer, you confirm they agreed to hear from your business by text or email about this job,
            including a request for a review. They can reply STOP to any text or unsubscribe from any email.
          </p>

          {error && <p className="ac-error" role="alert">{error.message}</p>}

          <button type="submit" className="ac-btn" disabled={busy}>
            {busy ? "Saving..." : "Save customer"}
          </button>
        </form>
      )}

      <section className="ac-recent" aria-labelledby="ac-recent-h">
        <h2 id="ac-recent-h" className="ac-h2">Recently added</h2>
        {recentError ? (
          <p className="ac-muted">{recentError}</p>
        ) : recent === null ? (
          <p className="ac-muted">Loading...</p>
        ) : recent.length === 0 ? (
          <p className="ac-muted">Customers you add will show up here.</p>
        ) : (
          <ul className="ac-list">
            {recent.map((r, i) => (
              <li key={`${r.name}-${r.added}-${i}`}>
                <span>{r.name}</span>
                <time dateTime={r.added}>{niceDate(r.added)}</time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
