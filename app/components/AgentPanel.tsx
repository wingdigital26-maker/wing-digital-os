"use client";
import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AgentConfig {
  name: string;
  endpoint: string;
  color: string;
  logo: React.ReactNode;
  tagline: string;
}

// Claude actual logo (Anthropic's stylized mark in orange)
function ClaudeLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#E8692A" />
      {/* Anthropic-style overlapping bars */}
      <rect x="7" y="10" width="4" height="12" rx="2" fill="white" opacity="0.95" transform="rotate(-20 9 16)" />
      <rect x="14" y="8" width="4" height="14" rx="2" fill="white" opacity="0.95" />
      <rect x="21" y="10" width="4" height="12" rx="2" fill="white" opacity="0.95" transform="rotate(20 23 16)" />
    </svg>
  );
}

// Hermes / NousResearch logo (purple with stylized N)
function HermesLogo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill="#7c3aed" />
      {/* Stylized N for NousResearch */}
      <path d="M9 23V9l14 14V9" stroke="white" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

const AGENTS: AgentConfig[] = [
  {
    name: "Claude",
    endpoint: "/api/chat/claude",
    color: "#E8692A",
    logo: <ClaudeLogo />,
    tagline: "Strategy · Copy · Decisions",
  },
  {
    name: "Hermes",
    endpoint: "/api/chat/hermes",
    color: "#7c3aed",
    logo: <HermesLogo />,
    tagline: "Tasks · Lookups · Operations",
  },
];

// Cost tracker stored in localStorage
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
      <span style={{ color: cost > 1 ? "#f87171" : "#4ade80", fontWeight: 700 }}>
        ${cost.toFixed(4)}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: 10 }}>Claude API</span>
    </div>
  );
}

function ChatPanel({ agent, onCost }: { agent: AgentConfig; onCost: (c: number) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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
      if (data.cost) { addCost(data.cost); onCost(data.cost); }
      setMessages([...next, { role: "assistant", content: data.reply ?? data.error ?? "No response" }]);
    } catch {
      setMessages([...next, { role: "assistant", content: "Connection error." }]);
    }
    setLoading(false);
  }

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      background: "var(--bg-card)", border: "1px solid var(--border)",
      borderRadius: 12, overflow: "hidden",
      borderTop: `2px solid ${agent.color}`,
      maxHeight: 480,
    }}>
      {/* Header */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        {agent.logo}
        <div>
          <p style={{ fontWeight: 700, fontSize: 14 }}>{agent.name}</p>
          <p style={{ fontSize: 10, color: "var(--text-muted)" }}>{agent.tagline}</p>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80" }} />
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>Online</span>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", marginTop: 24, color: "var(--text-muted)" }}>
            <p style={{ fontSize: 13, marginBottom: 4 }}>Ask {agent.name} anything</p>
            <p style={{ fontSize: 11 }}>{agent.tagline}</p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "85%", padding: "8px 12px", fontSize: 13, lineHeight: 1.5,
              borderRadius: msg.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
              background: msg.role === "user" ? agent.color : "var(--bg-hover)",
              color: msg.role === "user" ? "#fff" : "var(--text-primary)",
              border: msg.role === "assistant" ? "1px solid var(--border)" : "none",
            }}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex" }}>
            <div style={{ padding: "8px 12px", borderRadius: "12px 12px 12px 3px", background: "var(--bg-hover)", border: "1px solid var(--border)" }}>
              <TypingDots color={agent.color} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", display: "flex", gap: 8, flexShrink: 0 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={`Message ${agent.name}...`}
          style={{
            flex: 1, background: "var(--bg-hover)", border: "1px solid var(--border)",
            borderRadius: 8, padding: "8px 12px", color: "var(--text-primary)",
            fontSize: 13, outline: "none",
          }}
        />
        <button onClick={send} disabled={loading || !input.trim()} style={{
          background: agent.color, border: "none", borderRadius: 8,
          width: 36, height: 36, cursor: "pointer", flexShrink: 0,
          opacity: loading || !input.trim() ? 0.4 : 1,
          color: "#fff", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center",
        }}>↑</button>
      </div>
    </div>
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

export default function AgentsView() {
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
        {AGENTS.map(agent => (
          <ChatPanel key={agent.name} agent={agent} onCost={() => forceUpdate(n => n + 1)} />
        ))}
      </div>
    </div>
  );
}
