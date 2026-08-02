"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";

type Msg = { role: string; content: string };
type SessionRow = { id: string; title: string; created_at: string };

export default function BrainPage() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const loadSessions = useCallback(async () => {
    try {
      const r = await fetch("/api/brain/sessions");
      const d = await r.json();
      if (Array.isArray(d.sessions)) setSessions(d.sessions);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  async function openSession(id: string) {
    setActiveId(id);
    setLoadingHistory(true);
    setMessages([]);
    try {
      const r = await fetch(`/api/brain/sessions?id=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (Array.isArray(d.messages)) {
        setMessages(d.messages.map((m: any) => ({ role: m.role, content: m.content })));
      }
    } catch {
      /* ignore */
    }
    setLoadingHistory(false);
  }

  function newChat() {
    setActiveId(null);
    setMessages([]);
    setInput("");
  }

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: message }]);
    setSending(true);
    try {
      const r = await fetch("/api/brain/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, sessionId: activeId ?? undefined }),
      });
      const d = await r.json();
      if (d.error) {
        setMessages((m) => [...m, { role: "assistant", content: `⚠ ${d.error}` }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: d.answer }]);
        if (d.sessionId && d.sessionId !== activeId) {
          setActiveId(d.sessionId);
          loadSessions();
        }
      }
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "⚠ Network error" }]);
    }
    setSending(false);
  }

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg-primary)", color: "var(--text-primary)" }}>
      {/* Sessions sidebar */}
      <aside style={{
        width: 260, background: "var(--bg-secondary)", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", flexShrink: 0,
      }}>
        <div style={{ padding: "18px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10 }}>
          <a href="/" style={{ color: "var(--text-muted)", textDecoration: "none", fontSize: 18 }}>←</a>
          <span style={{ fontWeight: 700, fontSize: 14 }}>AI Brain</span>
        </div>
        <div style={{ padding: 12 }}>
          <button onClick={newChat} style={{
            width: "100%", padding: "10px 14px", borderRadius: 10,
            border: "1px solid var(--accent)", background: "var(--accent-glow)",
            color: "var(--accent)", fontWeight: 600, fontSize: 13, cursor: "pointer",
          }}>+ New chat</button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
          {sessions.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--text-muted)", padding: "8px 10px" }}>No saved chats yet.</p>
          )}
          {sessions.map((s) => (
            <button key={s.id} onClick={() => openSession(s.id)} style={{
              display: "block", width: "100%", textAlign: "left", padding: "9px 12px",
              borderRadius: 8, border: "none", marginBottom: 2,
              background: activeId === s.id ? "var(--accent-glow)" : "transparent",
              color: activeId === s.id ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: 12.5, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{s.title || "Untitled"}</button>
          ))}
        </div>
      </aside>

      {/* Main thread */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <header style={{
          padding: "16px 24px", borderBottom: "1px solid var(--border)",
          background: "var(--bg-secondary)", flexShrink: 0,
        }}>
          <h1 style={{ fontSize: 16, fontWeight: 700 }}>Wing Digital OS Brain</h1>
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
            Chat grounded in your vault. History is saved.
          </p>
        </header>

        <div ref={threadRef} style={{ flex: 1, overflow: "auto", padding: "24px" }}>
          {messages.length === 0 && !loadingHistory && (
            <div style={{ maxWidth: 620, margin: "60px auto 0", textAlign: "center", color: "var(--text-muted)" }}>
              <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>
                Ask the brain anything about Wing Digital.
              </p>
              <p style={{ fontSize: 13 }}>
                It reads your vault to answer. Try &ldquo;What is our current focus?&rdquo; or &ldquo;Summarize Jackson Roofing.&rdquo;
              </p>
            </div>
          )}
          {loadingHistory && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading history...</p>}
          <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
            {messages.map((m, i) => (
              <div key={i} style={{
                display: "flex", flexDirection: "column",
                alignItems: m.role === "user" ? "flex-end" : "flex-start",
              }}>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {m.role === "user" ? "You" : "Brain"}
                </span>
                <div style={{
                  maxWidth: "88%", padding: "12px 16px", borderRadius: 14, fontSize: 13.5, lineHeight: 1.55,
                  background: m.role === "user" ? "var(--accent-glow)" : "var(--bg-card)",
                  border: `1px solid ${m.role === "user" ? "var(--accent)" : "var(--border)"}`,
                  color: "var(--text-primary)",
                }}>
                  {m.role === "user"
                    ? m.content
                    : <div className="md-body"><ReactMarkdown>{m.content}</ReactMarkdown></div>}
                </div>
              </div>
            ))}
            {sending && (
              <div style={{ alignSelf: "flex-start", color: "var(--text-muted)", fontSize: 13 }}>Brain is thinking...</div>
            )}
          </div>
        </div>

        {/* Input */}
        <div style={{ padding: "16px 24px", borderTop: "1px solid var(--border)", background: "var(--bg-secondary)", flexShrink: 0 }}>
          <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Ask the brain..."
              rows={1}
              style={{
                flex: 1, resize: "none", padding: "12px 14px", borderRadius: 12,
                border: "1px solid var(--border)", background: "var(--bg-card)",
                color: "var(--text-primary)", fontSize: 13.5, fontFamily: "inherit", maxHeight: 160,
              }}
            />
            <button onClick={send} disabled={sending || !input.trim()} style={{
              padding: "12px 20px", borderRadius: 12, border: "none",
              background: sending || !input.trim() ? "var(--border)" : "linear-gradient(135deg, #22d3ee, #0e7490)",
              color: "#07080f", fontWeight: 700, fontSize: 13,
              cursor: sending || !input.trim() ? "default" : "pointer",
            }}>Send</button>
          </div>
        </div>
      </main>
    </div>
  );
}
