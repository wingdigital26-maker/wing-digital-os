"use client";
import { useState, useRef, useEffect } from "react";
import { logAiEvent } from "./ActivityLog";

interface ToolCall {
  tool: string;
  input: any;
  result: string;
}

interface Message {
  role: "user" | "assistant" | "tool_call";
  content: string;
  toolCalls?: ToolCall[];
}

interface AgentConfig {
  name: string;
  endpoint: string;
  color: string;
  logo: React.ReactNode;
  tagline: string;
  key?: string;
}

interface VaultNote {
  name: string;
  path: string;
  content: string;
}

function ClaudeLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#E8692A" />
      <rect x="7" y="10" width="4" height="12" rx="2" fill="white" opacity="0.95" transform="rotate(-20 9 16)" />
      <rect x="14" y="8" width="4" height="14" rx="2" fill="white" opacity="0.95" />
      <rect x="21" y="10" width="4" height="12" rx="2" fill="white" opacity="0.95" transform="rotate(20 23 16)" />
    </svg>
  );
}

function ClaudeCodeLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="var(--accent)" />
      <path d="M13 11l-5 5 5 5" stroke="#07080f" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path d="M19 11l5 5-5 5" stroke="#07080f" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function GroqLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <defs>
        <linearGradient id="groqGrad" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0%" stopColor="#f43f5e" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      <circle cx="16" cy="16" r="16" fill="url(#groqGrad)" />
      {/* Lightning bolt — speed */}
      <path d="M17.5 6L10 17.5h5L14 26l8-11.5h-5.5L17.5 6z"
        fill="#fff" stroke="#fff" strokeWidth="0.5" strokeLinejoin="round" />
    </svg>
  );
}

const AGENTS: AgentConfig[] = [
  {
    name: "Claude Code",
    endpoint: "/api/chat/claude-code",
    color: "var(--accent)",
    logo: <ClaudeCodeLogo />,
    tagline: "Full agent · Vault · GHL · Terminal",
  },
  {
    name: "Groq",
    endpoint: "/api/chat/hermes",
    color: "#f43f5e",
    logo: <GroqLogo />,
    tagline: "Tasks · Speed · Automation",
    key: "groq",
  },
];

function getWeeklyCost(): number {
  if (typeof window === "undefined") return 0;
  const stored = localStorage.getItem("wingos_cost");
  if (!stored) return 0;
  const { week, total } = JSON.parse(stored);
  const thisWeek = getWeekKey();
  return week === thisWeek ? total : 0;
}

function addCost(amount: number) {
  if (typeof window === "undefined") return;
  const thisWeek = getWeekKey();
  const stored = localStorage.getItem("wingos_cost");
  let total = amount;
  if (stored) {
    const { week, total: prev } = JSON.parse(stored);
    if (week === thisWeek) total = prev + amount;
  }
  localStorage.setItem("wingos_cost", JSON.stringify({ week: thisWeek, total }));
}

function getWeekKey(): string {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d.setDate(diff));
  return monday.toISOString().split("T")[0];
}

function CostWidget() {
  const [cost, setCost] = useState(0);
  useEffect(() => {
    setCost(getWeeklyCost());
    const id = setInterval(() => setCost(getWeeklyCost()), 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 8, padding: "5px 12px", fontSize: 12,
    }}>
      <span style={{ color: "var(--text-muted)" }}>This week:</span>
      <span style={{ color: cost > 1 ? "var(--red)" : "var(--green)", fontWeight: 700 }}>
        ${cost.toFixed(4)}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>Claude API</span>
    </div>
  );
}

// Vault note picker modal
function NotePicker({ onSelect, onClose }: { onSelect: (note: VaultNote) => void; onClose: () => void }) {
  const [tree, setTree] = useState<any[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [flat, setFlat] = useState<{ name: string; path: string }[]>([]);

  useEffect(() => {
    fetch("/api/vault").then(r => r.json()).then(data => {
      setTree(data.tree ?? []);
      setFlat(flattenTree(data.tree ?? []));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  function flattenTree(nodes: any[]): { name: string; path: string }[] {
    const out: { name: string; path: string }[] = [];
    for (const n of nodes) {
      if (n.type === "file") out.push({ name: n.name, path: n.path });
      if (n.children) out.push(...flattenTree(n.children));
    }
    return out;
  }

  const filtered = query.trim()
    ? flat.filter(f => f.name.toLowerCase().includes(query.toLowerCase()) || f.path.toLowerCase().includes(query.toLowerCase()))
    : flat.slice(0, 20);

  async function pick(item: { name: string; path: string }) {
    const res = await fetch(`/api/vault/file?path=${encodeURIComponent(item.path)}`);
    const data = await res.json();
    onSelect({ name: item.name, path: item.path, content: data.content ?? "" });
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 200,
      display: "flex", alignItems: "center", justifyContent: "center",
    }} onClick={onClose}>
      <div style={{
        background: "var(--bg-primary)", border: "1px solid var(--border)",
        borderRadius: 14, width: 420, maxHeight: 480, display: "flex", flexDirection: "column",
        overflow: "hidden",
      }} onClick={e => e.stopPropagation()}>
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
          <p style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Attach Note from Vault</p>
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search notes..."
            style={{
              width: "100%", background: "var(--bg-card)", border: "1px solid var(--border)",
              borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)", fontSize: 13,
              outline: "none", boxSizing: "border-box",
            }}
          />
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
          {loading && <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, padding: 16 }}>Loading vault...</p>}
          {!loading && filtered.length === 0 && <p style={{ textAlign: "center", color: "var(--text-muted)", fontSize: 13, padding: 16 }}>No notes found</p>}
          {filtered.map(item => (
            <div key={item.path} onClick={() => pick(item)} style={{
              padding: "9px 16px", cursor: "pointer", borderRadius: 8, margin: "0 6px",
              transition: "background 0.1s",
            }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            >
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>📄 {item.name}</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{item.path}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChatPanel({ agent, onCost, inject }: { agent: AgentConfig; onCost: (c: number) => void; inject?: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [attachedNotes, setAttachedNotes] = useState<VaultNote[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [permanentCtx, setPermanentCtx] = useState<string>("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const agentKey = agent.name.toLowerCase();

  // Load permanent vault context
  useEffect(() => {
    fetch("/api/vault/context").then(r => r.json()).then(d => setPermanentCtx(d.content ?? ""));
  }, []);

  // Chats are session-only: nothing loads from or saves to the vault automatically.
  // Closing or refreshing the app starts a fresh conversation.
  // Use the explicit "Save to Vault" button to keep a summary of anything important.
  useEffect(() => {
    setHistoryLoaded(true);
  }, [agentKey]);

  // Claude: auto-summarize once per day on first load if there's history
  useEffect(() => {
    if (agent.name !== "Claude" || !historyLoaded || messages.length === 0) return;
    const today = new Date().toISOString().split("T")[0];
    const lastSave = localStorage.getItem("wingos_claude_last_summary");
    if (lastSave === today) return;
    // Auto-summarize silently in background
    fetch("/api/vault/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, agent: "Claude" }),
    }).then(() => {
      localStorage.setItem("wingos_claude_last_summary", today);
    }).catch(() => {});
  }, [historyLoaded, agent.name]);

  async function saveToVault() {
    if (!messages.length || saving) return;
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/vault/summarize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, agent: agent.name }),
      });
      const data = await res.json();
      if (data.ok) {
        if (agent.name === "Claude") {
          localStorage.setItem("wingos_claude_last_summary", new Date().toISOString().split("T")[0]);
        }
        setSaveMsg("Saved to vault");
      } else {
        setSaveMsg("Save failed");
      }
    } catch {
      setSaveMsg("Save failed");
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(""), 3000);
  }

  const lastInjectRef = useRef("");
  useEffect(() => {
    if (inject && inject !== lastInjectRef.current) {
      lastInjectRef.current = inject;
      setInput(inject);
    }
  }, [inject]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function attachNote(note: VaultNote) {
    setAttachedNotes(prev => prev.find(n => n.path === note.path) ? prev : [...prev, note]);
    setShowPicker(false);
  }

  function removeNote(path: string) {
    setAttachedNotes(prev => prev.filter(n => n.path !== path));
  }

  const [recording, setRecording] = useState(false);
  const recognitionRef = useRef<any>(null);

  function toggleVoice() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { alert("Voice input not supported in this browser. Use Chrome."); return; }

    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }

    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = "en-US";
    recognitionRef.current = rec;

    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setInput(prev => prev ? `${prev} ${transcript}` : transcript);
    };
    rec.onend = () => setRecording(false);
    rec.onerror = () => setRecording(false);

    rec.start();
    setRecording(true);
  }

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setLoading(true);
    try {
      const vaultContext = attachedNotes.length > 0
        ? attachedNotes.map(n => `### ${n.name}\n${n.content}`).join("\n\n")
        : undefined;

      const apiMessages = next.filter(m => m.role !== "tool_call").map(m => ({ role: m.role, content: m.content }));
      const res = await fetch(agent.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages, vaultContext }),
      });
      const data = await res.json();
      if (data.cost) { addCost(data.cost); onCost(data.cost); }
      const reply = data.reply ?? data.error ?? "No response";
      logAiEvent(agent.name === "Claude" ? "ai_claude" : "ai_hermes", text, reply);
      const newMessages: Message[] = [...next];
      if (data.toolCalls?.length) {
        newMessages.push({ role: "tool_call", content: "", toolCalls: data.toolCalls });
      }
      newMessages.push({ role: "assistant", content: reply });
      setMessages(newMessages);
    } catch {
      setMessages([...next, { role: "assistant", content: "Connection error." }]);
    }
    setLoading(false);
  }

  const isClaude = agent.name === "Claude";

  return (
    <>
      {showPicker && <NotePicker onSelect={attachNote} onClose={() => setShowPicker(false)} />}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column",
        background: "linear-gradient(180deg, var(--bg-card), rgba(12, 15, 26, 0.9))",
        border: "1px solid var(--border)",
        borderRadius: 16, overflow: "hidden",
        boxShadow: `0 12px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04), 0 -1px 0 0 ${agent.color}55 inset`,
        maxHeight: 560,
      }}>
        {/* Header */}
        <div style={{
          padding: "14px 18px",
          borderBottom: "1px solid var(--border)",
          background: `linear-gradient(135deg, ${agent.color}0d, transparent 55%)`,
          display: "flex", alignItems: "center", gap: 12, flexShrink: 0,
        }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
            {agent.logo}
            <div title="Online" style={{
              position: "absolute", bottom: -1, right: -1,
              width: 8, height: 8, borderRadius: "50%",
              background: "var(--green)", border: "2px solid var(--bg-card)",
            }} />
          </div>
          <div>
            <p style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.01em" }}>{agent.name}</p>
            <p style={{ fontSize: 10, color: "var(--text-muted)" }}>{agent.tagline}</p>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            <button onClick={() => setShowPicker(true)} title="Attach a vault note as context" style={{
              background: "transparent", border: "1px solid var(--border)",
              borderRadius: 999, padding: "5px 12px", fontSize: 11, color: "var(--text-secondary)",
              cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
            }}>
              <span style={{ fontSize: 12 }}>📎</span> Attach
            </button>
            {messages.length > 0 && (
              <>
                <button onClick={saveToVault} disabled={saving} title="Summarize and save to vault" style={{
                  background: saving ? "transparent" : `${agent.color}14`,
                  border: `1px solid ${saving ? "rgba(255,255,255,0.1)" : agent.color + "66"}`,
                  borderRadius: 999, padding: "5px 12px", fontSize: 11,
                  color: saving ? "var(--text-muted)" : agent.color,
                  cursor: saving ? "default" : "pointer", display: "flex", alignItems: "center", gap: 5,
                  fontWeight: 600,
                }}>
                  {saving ? "Saving..." : saveMsg ? saveMsg : "Save"}
                </button>
                <button onClick={() => setMessages([])} title="Clear conversation" style={{
                  background: "transparent", border: "1px solid var(--border)",
                  borderRadius: 999, width: 26, height: 26, fontSize: 13, color: "var(--text-muted)",
                  cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                  lineHeight: 1,
                }}>
                  ×
                </button>
              </>
            )}
          </div>
        </div>

        {/* Context chips -- permanent + attached */}
        {(permanentCtx || attachedNotes.length > 0) && (
          <div style={{
            padding: "8px 16px", borderBottom: "1px solid var(--border)",
            display: "flex", flexWrap: "wrap", gap: 6, background: "rgba(255,255,255,0.02)", flexShrink: 0,
            alignItems: "center",
          }}>
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Context:</span>

            {/* Permanent context chip -- always shown, locked */}
            {permanentCtx && (
              <div title="CLAUDE.md · agent-context · hot · clients · campaigns (always loaded)" style={{
                display: "flex", alignItems: "center", gap: 5,
                background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)",
                borderRadius: 999, padding: "2px 10px", fontSize: 10,
              }}>
                <span style={{ fontSize: 10 }}>🔒</span>
                <span style={{ color: "var(--green)", fontWeight: 600 }}>Vault context</span>
              </div>
            )}

            {/* Manually attached notes */}
            {attachedNotes.map(note => (
              <div key={note.path} style={{
                display: "flex", alignItems: "center", gap: 5,
                background: agent.color + "22", border: `1px solid ${agent.color}44`,
                borderRadius: 20, padding: "2px 8px 2px 6px", fontSize: 11,
              }}>
                <span>📄</span>
                <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{note.name}</span>
                {isClaude && <span style={{ color: "var(--orange)", fontSize: 9, fontWeight: 700 }}>uses tokens</span>}
                <button onClick={() => removeNote(note.path)} style={{
                  background: "none", border: "none", color: "var(--text-muted)",
                  cursor: "pointer", fontSize: 12, lineHeight: 1, padding: "0 0 0 2px",
                }}>×</button>
              </div>
            ))}
          </div>
        )}

        {/* Messages */}
        <div style={{ flex: 1, overflow: "auto", padding: "18px 18px 12px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && (
            <div style={{ textAlign: "center", margin: "auto 0", color: "var(--text-muted)", padding: "32px 0" }}>
              <div style={{
                width: 44, height: 44, borderRadius: 14, margin: "0 auto 12px",
                background: `linear-gradient(135deg, ${agent.color}33, transparent)`,
                border: `1px solid ${agent.color}44`,
                display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20,
              }}>✦</div>
              <p style={{ fontSize: 14, marginBottom: 4, color: "var(--text-secondary)", fontWeight: 600 }}>Ask {agent.name} anything</p>
              <p style={{ fontSize: 11 }}>{agent.tagline}</p>
            </div>
          )}
          {messages.map((msg, i) => {
            if (msg.role === "tool_call" && msg.toolCalls?.length) {
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, alignSelf: "stretch" }}>
                  {msg.toolCalls.map((tc, j) => {
                    let resultPreview = "";
                    try {
                      const parsed = JSON.parse(tc.result);
                      if (parsed.contacts) resultPreview = `found ${parsed.contacts.length} contact${parsed.contacts.length !== 1 ? "s" : ""}`;
                      else if (parsed.opportunities) resultPreview = `${parsed.opportunities.length} opportunities`;
                      else if (parsed.result) resultPreview = parsed.result;
                      else if (parsed.content) resultPreview = parsed.content.slice(0, 80) + (parsed.content.length > 80 ? "..." : "");
                      else if (parsed.ok === false) resultPreview = parsed.error ?? "error";
                      else resultPreview = "done";
                    } catch { resultPreview = tc.result.slice(0, 60); }
                    return (
                      <div key={j} style={{
                        display: "flex", alignItems: "center", gap: 8,
                        background: "rgba(34,211,238,0.05)", border: "1px solid rgba(34,211,238,0.15)",
                        borderRadius: 999, padding: "4px 12px", fontSize: 11,
                        color: "var(--text-muted)", alignSelf: "flex-start",
                      }}>
                        <span style={{ fontSize: 13 }}>🔧</span>
                        <span style={{ color: "var(--accent)", fontWeight: 700 }}>{tc.tool}</span>
                        {tc.input && Object.keys(tc.input).length > 0 && (
                          <span style={{ color: "var(--text-muted)" }}>
                            {Object.values(tc.input).map(v => typeof v === "string" ? `"${v}"` : JSON.stringify(v)).join(", ")}
                          </span>
                        )}
                        <span style={{ color: "var(--text-muted)" }}>→</span>
                        <span style={{ color: "var(--green)" }}>{resultPreview}</span>
                      </div>
                    );
                  })}
                </div>
              );
            }
            return (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "82%", padding: "10px 14px", fontSize: 13, lineHeight: 1.6,
                  borderRadius: msg.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                  background: msg.role === "user"
                    ? `linear-gradient(135deg, ${agent.color}, ${agent.color}cc)`
                    : "rgba(255,255,255,0.035)",
                  color: msg.role === "user" ? "#fff" : "var(--text-primary)",
                  border: msg.role === "assistant" ? "1px solid var(--border)" : "none",
                  boxShadow: msg.role === "user" ? `0 4px 14px ${agent.color}33` : "none",
                  whiteSpace: "pre-wrap",
                }}>
                  {msg.content}
                </div>
              </div>
            );
          })}
          {loading && (
            <div style={{ display: "flex" }}>
              <div style={{ padding: "8px 12px", borderRadius: "12px 12px 12px 3px", background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
                <TypingDots color={agent.color} />
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input — single pill bar with inline mic + send */}
        <div style={{ padding: "12px 14px 14px", flexShrink: 0 }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${recording ? "var(--red)" : "rgba(255,255,255,0.08)"}`,
            borderRadius: 999, padding: "5px 6px 5px 16px",
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
                color: "var(--text-primary)", fontSize: 13, outline: "none",
                boxShadow: "none", padding: "6px 0",
              }}
            />
            <button onClick={toggleVoice} title="Voice input" style={{
              background: recording ? "rgba(251,113,133,0.15)" : "transparent",
              border: "none", borderRadius: "50%", width: 32, height: 32,
              cursor: "pointer", flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                {recording ? (
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="var(--red)" />
                ) : (
                  <>
                    <rect x="9" y="2" width="6" height="12" rx="3" fill="var(--text-muted)" />
                    <path d="M5 10a7 7 0 0 0 14 0" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" fill="none" />
                    <line x1="12" y1="17" x2="12" y2="21" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" />
                    <line x1="9" y1="21" x2="15" y2="21" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" />
                  </>
                )}
              </svg>
            </button>
            <button onClick={send} disabled={loading || !input.trim()} style={{
              background: input.trim() && !loading
                ? `linear-gradient(135deg, ${agent.color}, ${agent.color}bb)`
                : "rgba(255,255,255,0.06)",
              border: "none", borderRadius: "50%",
              width: 32, height: 32, cursor: input.trim() && !loading ? "pointer" : "default", flexShrink: 0,
              color: input.trim() && !loading ? "#fff" : "var(--text-muted)",
              fontSize: 15, display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: input.trim() && !loading ? `0 2px 10px ${agent.color}55` : "none",
              transition: "all 0.2s",
            }}>↑</button>
          </div>
        </div>
      </div>
    </>
  );
}

function TypingDots({ color }: { color: string }) {
  return (
    <div style={{ display: "flex", gap: 3, alignItems: "center", height: 16 }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 5, height: 5, borderRadius: "50%", background: color,
          animation: `bounce 1.2s ease-in-out ${i * 0.2}s infinite`,
        }} />
      ))}
      <style>{`@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}}`}</style>
    </div>
  );
}

export default function AgentsView({ inject }: { inject?: string }) {
  const [, forceUpdate] = useState(0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
          AI Agents
        </p>
        <CostWidget />
      </div>
      <div style={{ display: "flex", gap: 14 }}>
        {AGENTS.map((agent, i) => (
          <ChatPanel key={agent.name} agent={agent} onCost={() => forceUpdate(n => n + 1)} inject={i === 0 ? inject : undefined} />
        ))}
      </div>
    </div>
  );
}
