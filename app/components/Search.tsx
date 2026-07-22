"use client";
import { useState, useEffect, useRef, useCallback } from "react";

interface SearchResult {
  contacts: { id: string; name: string; email: string; phone: string; tags: string[] }[];
  notes: { name: string; path: string; excerpt: string }[];
}

export default function Search({ onOpenNote }: { onOpenNote: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult>({ contacts: [], notes: [] });
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Cmd+K / Ctrl+K to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 50);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const search = useCallback((q: string) => {
    clearTimeout(timerRef.current);
    if (!q || q.length < 2) { setResults({ contacts: [], notes: [] }); return; }
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        setResults(await res.json());
      } catch { }
      setLoading(false);
    }, 250); // 250ms debounce -- waits for you to stop typing
  }, []);

  useEffect(() => { search(query); }, [query, search]);

  const hasResults = results.contacts.length > 0 || results.notes.length > 0;

  if (!open) return (
    <button onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 50); }} style={{
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 8, padding: "8px 14px", display: "flex", alignItems: "center", gap: 8,
      color: "var(--text-muted)", fontSize: 13, cursor: "pointer",
    }}>
      <span>🔍</span><span>Search... ⌘K</span>
    </button>
  );

  return (
    <>
      {/* Backdrop */}
      <div onClick={() => setOpen(false)} style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 100,
      }} />

      {/* Modal */}
      <div style={{
        position: "fixed", top: "15%", left: "50%", transform: "translateX(-50%)",
        width: "min(600px, 90vw)", zIndex: 101,
        background: "var(--bg-secondary)", border: "1px solid var(--border)",
        borderRadius: 14, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
      }}>
        {/* Input */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <span style={{ color: "var(--text-muted)", fontSize: 18 }}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search contacts and notes..."
            autoFocus
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              color: "var(--text-primary)", fontSize: 16,
            }}
          />
          {loading && <span style={{ color: "var(--text-muted)", fontSize: 12 }}>searching...</span>}
          <kbd style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "var(--text-muted)" }}>ESC</kbd>
        </div>

        {/* Results */}
        {hasResults && (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            {results.contacts.length > 0 && (
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", padding: "10px 16px 4px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  GHL Contacts
                </p>
                {results.contacts.map(c => (
                  <div key={c.id} style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{c.name || "—"}</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        {c.tags.slice(0, 2).map(t => (
                          <span key={t} style={{ fontSize: 10, background: "var(--accent-glow)", color: "var(--accent)", padding: "2px 7px", borderRadius: 20 }}>{t}</span>
                        ))}
                      </div>
                    </div>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{c.email} {c.phone ? `· ${c.phone}` : ""}</p>
                  </div>
                ))}
              </div>
            )}

            {results.notes.length > 0 && (
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)", padding: "10px 16px 4px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Vault Notes
                </p>
                {results.notes.map(n => (
                  <div key={n.path} onClick={() => { onOpenNote(n.path); setOpen(false); setQuery(""); }}
                    style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)", cursor: "pointer" }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>📄 {n.name}</p>
                    <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{n.excerpt}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {query.length >= 2 && !loading && !hasResults && (
          <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
            No results for "{query}"
          </div>
        )}

        {!query && (
          <div style={{ padding: "16px", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["roofing", "HVAC", "plumbing"].map(tag => (
              <button key={tag} onClick={() => setQuery(tag)} style={{
                background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6,
                padding: "4px 12px", fontSize: 12, color: "var(--text-muted)", cursor: "pointer",
              }}>{tag}</button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
