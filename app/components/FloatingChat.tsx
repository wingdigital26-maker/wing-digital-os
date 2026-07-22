"use client";
import { useState, useRef, useEffect } from "react";
import { logAiEvent } from "./ActivityLog";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const AGENTS = [
  { name: "Claude", key: "claude", color: "#E8692A", endpoint: "/api/chat/claude" },
  { name: "Groq", key: "groq", color: "#f43f5e", endpoint: "/api/chat/hermes" }, // endpoint file is still named hermes internally
];

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      {active ? (
        <rect x="6" y="6" width="12" height="12" rx="2" fill="#f87171" />
      ) : (
        <>
          <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" />
          <path d="M5 10a7 7 0 0 0 14 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
          <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <line x1="9" y1="21" x2="15" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

export default function FloatingChat() {
  const [open, setOpen] = useState(false);
  const [agentIdx, setAgentIdx] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const agent = AGENTS[agentIdx];

  // Chats are session-only: fresh conversation on every app launch.
  // Use "Save to Vault" to keep a summary of anything worth remembering.

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading, open]);

  function toggleVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Use Chrome for voice input."); return; }
    if (recording) { recognitionRef.current?.stop(); setRecording(false); return; }
    const rec = new SR();
    rec.continuous = false; rec.interimResults = false; rec.lang = "en-US";
    recognitionRef.current = rec;
    rec.onresult = (e: any) => setInput(prev => prev ? `${prev} ${e.results[0][0].transcript}` : e.results[0][0].transcript);
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);
    rec.start(); setRecording(true);
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setLoading(true);
    try {
      const res = await fetch(agent.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      const reply = data.reply ?? data.error ?? "No response";
      logAiEvent(agent.name === "Claude" ? "ai_claude" : "ai_hermes", text, reply);
      setMessages([...next, { role: "assistant", content: reply }]);
    } catch {
      setMessages([...next, { role: "assistant", content: "Connection error." }]);
    }
    setLoading(false);
  }

  async function saveToVault() {
    if (!messages.length || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/vault/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, agent: agent.name }),
      });
      const data = await res.json();
      setSaveMsg(data.ok ? "Saved!" : "Failed");
    } catch { setSaveMsg("Failed"); }
    setSaving(false);
    setTimeout(() => setSaveMsg(""), 2500);
  }

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 1000, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 10 }}>

      {/* Expanded chat panel */}
      {open && (
        <div style={{
          width: 340, height: 460, background: "var(--bg-primary)",
          border: `1px solid var(--border)`, borderTop: `2px solid ${agent.color}`,
          borderRadius: 14, display: "flex", flexDirection: "column",
          boxShadow: "0 8px 40px rgba(0,0,0,0.5)", overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            {/* Agent switcher */}
            <div style={{ display: "flex", gap: 4 }}>
              {AGENTS.map((a, i) => (
                <button key={a.key} onClick={() => { setAgentIdx(i); setMessages([]); }} style={{
                  padding: "3px 10px", borderRadius: 20, fontSize: 11, cursor: "pointer",
                  border: `1px solid ${agentIdx === i ? a.color : "var(--border)"}`,
                  background: agentIdx === i ? a.color + "22" : "transparent",
                  color: agentIdx === i ? a.color : "var(--text-muted)",
                  fontWeight: agentIdx === i ? 700 : 400,
                }}>
                  {a.name}
                </button>
              ))}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              {messages.length > 0 && (
                <button onClick={saveToVault} disabled={saving} style={{
                  fontSize: 10, padding: "2px 8px", borderRadius: 6, cursor: "pointer",
                  background: "var(--accent-glow)", border: "1px solid var(--accent)",
                  color: "var(--accent)",
                }}>
                  {saving ? "..." : saveMsg || "💾"}
                </button>
              )}
              {messages.length > 0 && (
                <button onClick={() => setMessages([])} style={{
                  fontSize: 10, padding: "2px 8px", borderRadius: 6, cursor: "pointer",
                  background: "transparent", border: "1px solid var(--border)", color: "var(--text-muted)",
                }}>
                  Clear
                </button>
              )}
              <button onClick={() => setOpen(false)} style={{
                background: "transparent", border: "none", color: "var(--text-muted)",
                cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0,
              }}>×</button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflow: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            {messages.length === 0 && (
              <div style={{ textAlign: "center", marginTop: 40, color: "var(--text-muted)" }}>
                <p style={{ fontSize: 13 }}>Ask {agent.name} anything</p>
                <p style={{ fontSize: 11, marginTop: 4 }}>Vault context loaded</p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "85%", padding: "8px 12px", fontSize: 12, lineHeight: 1.55,
                  borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: msg.role === "user"
                    ? `linear-gradient(135deg, ${agent.color}, ${agent.color}cc)`
                    : "rgba(255,255,255,0.035)",
                  color: msg.role === "user" ? "#fff" : "var(--text-primary)",
                  border: msg.role === "assistant" ? "1px solid rgba(255,255,255,0.06)" : "none",
                  boxShadow: msg.role === "user" ? `0 3px 10px ${agent.color}33` : "none",
                  whiteSpace: "pre-wrap",
                }}>
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: "flex" }}>
                <div style={{ padding: "7px 11px", borderRadius: "12px 12px 12px 3px", background: "var(--bg-card)", border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", gap: 3, alignItems: "center", height: 14 }}>
                    {[0,1,2].map(i => (
                      <div key={i} style={{ width: 4, height: 4, borderRadius: "50%", background: agent.color, animation: `bounce 1.2s ease-in-out ${i*0.2}s infinite` }} />
                    ))}
                    <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-4px)}}`}</style>
                  </div>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input — pill bar with inline mic + send */}
          <div style={{ padding: "10px 12px 12px", flexShrink: 0 }}>
            <div style={{
              display: "flex", alignItems: "center", gap: 4,
              background: "rgba(255,255,255,0.04)",
              border: `1px solid ${recording ? "#fb7185" : "rgba(255,255,255,0.08)"}`,
              borderRadius: 999, padding: "4px 5px 4px 14px",
              boxShadow: recording ? "0 0 0 3px rgba(251,113,133,0.15)" : "inset 0 1px 2px rgba(0,0,0,0.25)",
              transition: "border-color 0.2s, box-shadow 0.2s",
            }}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder={recording ? "Listening..." : `Message ${agent.name}...`}
                style={{
                  flex: 1, background: "transparent", border: "none",
                  color: "var(--text-primary)", fontSize: 12, outline: "none",
                  boxShadow: "none", padding: "5px 0",
                }}
              />
              <button onClick={toggleVoice} style={{
                background: recording ? "rgba(251,113,133,0.15)" : "transparent",
                border: "none", borderRadius: "50%", width: 28, height: 28,
                cursor: "pointer", flexShrink: 0,
                color: recording ? "#fb7185" : "var(--text-muted)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <MicIcon active={recording} />
              </button>
              <button onClick={send} disabled={loading || !input.trim()} style={{
                background: input.trim() && !loading
                  ? `linear-gradient(135deg, ${agent.color}, ${agent.color}bb)`
                  : "rgba(255,255,255,0.06)",
                border: "none", borderRadius: "50%",
                width: 28, height: 28, cursor: input.trim() && !loading ? "pointer" : "default", flexShrink: 0,
                color: input.trim() && !loading ? "#fff" : "var(--text-muted)",
                fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: input.trim() && !loading ? `0 2px 8px ${agent.color}55` : "none",
                transition: "all 0.2s",
              }}>↑</button>
            </div>
          </div>
        </div>
      )}

      {/* Floating toggle button */}
      <button onClick={() => setOpen(o => !o)} style={{
        width: 52, height: 52, borderRadius: "50%",
        background: open ? "var(--bg-card)" : `linear-gradient(135deg, #E8692A, #22d3ee)`,
        border: "1px solid var(--border)",
        boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 22, transition: "all 0.2s",
        color: open ? "var(--text-muted)" : "#fff",
      }}>
        {open ? "×" : "🤖"}
      </button>
    </div>
  );
}
