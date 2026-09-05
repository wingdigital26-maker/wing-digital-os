"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import { sfx } from "../lib/sounds";

// ── Types shared with app/api/jarvis/route.ts (stream contract) ──────────────
type Link = { label: string; view?: string; href?: string };
type PendingAction = { id: string; tool: string; args: unknown; human_summary: string; expires_in_sec?: number };
type Message = {
  role: "user" | "assistant";
  content: string;
  // small muted lines: "Checked today's summary"
  tools?: string[];
  links?: Link[];
  pending?: PendingAction | null;
  pendingState?: "open" | "running" | "done" | "cancelled" | "expired";
};

const HISTORY_KEY = "jarvis:history:v2";
const MAX_TURNS = 20; // user+assistant pairs kept in sessionStorage and sent to the server

const SUGGESTED = [
  "What needs my attention today?",
  "Who filled out a form this week?",
  "Create a task to call back the last missed call",
  "Add acmeroofing.com as a potential client",
];

const ACCENT = "#10C0F0";
const FONT = "Inter, sans-serif";

function newConversationId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function loadHistory(): Message[] {
  try {
    const raw = sessionStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A pending card never survives a reload: its token may be gone or used.
    return parsed.map((m: Message) => (m.pending && m.pendingState === "open" ? { ...m, pendingState: "expired" } : m));
  } catch {
    return [];
  }
}
function saveHistory(msgs: Message[]) {
  try {
    sessionStorage.setItem(HISTORY_KEY, JSON.stringify(msgs.slice(-MAX_TURNS * 2)));
  } catch {
    /* storage unavailable: chat still works for this page */
  }
}

export default function JarvisButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [hasSpeechAPI, setHasSpeechAPI] = useState(true);
  const [conversationId, setConversationId] = useState<string>("");
  const [engine, setEngine] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const listeningRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendMessageRef = useRef<(text: string) => void>(() => {});
  const SILENCE_MS = 4500;
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(false);
  const chosenVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  // First open of the panel: restore the last 20 turns for this browser tab,
  // mint a conversation id, and check for the speech API. Done in the open
  // handler (an event) rather than an effect so nothing sets state on mount.
  const openPanel = useCallback(() => {
    setOpen(true);
    if (!hydrated) {
      setMessages(loadHistory());
      setHydrated(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      if (!w.SpeechRecognition && !w.webkitSpeechRecognition) setHasSpeechAPI(false);
    }
    setConversationId((id) => id || newConversationId());
  }, [hydrated]);
  useEffect(() => {
    if (hydrated && !streaming) saveHistory(messages);
  }, [messages, hydrated, streaming]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    const pick = () => {
      const voices = window.speechSynthesis.getVoices();
      if (!voices.length) return;
      const prefer = [
        (v: SpeechSynthesisVoice) => /ryan/i.test(v.name) && v.lang.startsWith("en"),
        (v: SpeechSynthesisVoice) => /google uk english male/i.test(v.name),
        (v: SpeechSynthesisVoice) => /george|daniel|arthur|brian/i.test(v.name) && v.lang.startsWith("en"),
        (v: SpeechSynthesisVoice) => v.lang === "en-GB" && /male/i.test(v.name),
        (v: SpeechSynthesisVoice) => v.lang === "en-GB",
        (v: SpeechSynthesisVoice) => v.lang.startsWith("en"),
      ];
      for (const p of prefer) {
        const v = voices.find(p);
        if (v) { chosenVoiceRef.current = v; return; }
      }
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
  }, []);

  const stopAudio = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = null; }
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  const speakFallback = useCallback((clean: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    if (chosenVoiceRef.current) u.voice = chosenVoiceRef.current;
    u.rate = 1.02; u.pitch = 0.85; u.volume = 1;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  }, []);

  const speak = useCallback(async (text: string) => {
    const clean = text
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2022}\u{FE00}-\u{FE0F}\u{200D}\u{20D0}-\u{20FF}\u{E000}-\u{F8FF}]/gu, " ")
      .replace(/[#*_`>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);
    if (!clean) return;
    stopAudio();
    try {
      const res = await fetch("/api/jarvis/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: clean }) });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const blob = await res.blob();
      if (!blob.size || !voiceOnRef.current) return;
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setSpeaking(false); stopAudio(); };
      audio.onerror = () => { setSpeaking(false); stopAudio(); };
      setSpeaking(true);
      await audio.play();
    } catch {
      speakFallback(clean);
    }
  }, [stopAudio, speakFallback]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // ── Core: post to /api/jarvis and consume the event stream ────────────────
  // `history` is what the server sees; `confirm` re-posts a pending action.
  const runTurn = useCallback(async (history: Message[], confirm?: string) => {
    setStreaming(true);
    setToolLabel(null);
    setMessages([...history, { role: "assistant", content: "", tools: [], links: [] }]);
    const patchLast = (fn: (m: Message) => Message) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") updated[updated.length - 1] = fn(last);
        return updated;
      });
    };
    try {
      const res = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.slice(-MAX_TURNS * 2).map((m) => ({ role: m.role, content: m.content })),
          conversationId,
          ...(confirm ? { confirm_action_id: confirm } : {}),
        }),
      });
      if (!res.body) throw new Error("No response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(data); } catch { continue; }
          if (typeof ev.engine === "string") setEngine(ev.engine);
          if (typeof ev.tool === "string") {
            const lineText = typeof ev.line === "string" && ev.line ? ev.line : `Running ${ev.tool}`;
            setToolLabel(lineText);
            patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), lineText] }));
          }
          if (typeof ev.tool_done === "string" && Array.isArray(ev.links) && ev.links.length) {
            const links = ev.links as Link[];
            patchLast((m) => {
              const seen = new Set((m.links ?? []).map((l) => l.label + (l.view ?? l.href ?? "")));
              const fresh = links.filter((l) => !seen.has(l.label + (l.view ?? l.href ?? "")));
              return { ...m, links: [...(m.links ?? []), ...fresh].slice(0, 6) };
            });
          }
          if (typeof ev.text === "string" && ev.text) {
            setToolLabel(null);
            patchLast((m) => ({ ...m, content: m.content + ev.text }));
          }
          if (ev.pending_action && typeof ev.pending_action === "object") {
            const pa = ev.pending_action as PendingAction;
            setToolLabel(null);
            patchLast((m) => ({ ...m, pending: pa, pendingState: "open" }));
          }
          if (ev.budget && typeof ev.budget === "object") {
            setToolLabel(null);
          }
        }
      }
      if (voiceOnRef.current) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.content) speak(last.content);
          return prev;
        });
      }
    } catch (err) {
      patchLast((m) => ({ ...m, content: m.content || "Sorry, something went wrong. Check the console." }));
      console.error("[Jarvis]", err);
    } finally {
      setStreaming(false);
      setToolLabel(null);
    }
  }, [conversationId, speak]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;
    sfx.play("send");
    const userMsg: Message = { role: "user", content: text.trim() };
    setInput("");
    // An unanswered pending card is abandoned when the user moves on.
    const base = messages.map((m) => (m.pending && m.pendingState === "open" ? { ...m, pendingState: "cancelled" as const } : m));
    await runTurn([...base, userMsg]);
  }, [messages, streaming, runTurn]);

  const confirmAction = useCallback(async (idx: number) => {
    const target = messages[idx];
    if (!target?.pending || streaming) return;
    const token = target.pending.id;
    const history = messages.map((m, i) => (i === idx ? { ...m, pendingState: "done" as const } : m));
    // Keep the assistant's lead-in text as history; the server runs the
    // signed action and narrates the outcome in a fresh assistant turn.
    await runTurn(history, token);
  }, [messages, streaming, runTurn]);

  const cancelAction = useCallback((idx: number) => {
    setMessages((prev) => prev.map((m, i) => (i === idx ? { ...m, pendingState: "cancelled" } : m)));
  }, []);

  const clearChat = useCallback(() => {
    setMessages([]);
    setEngine(null);
    setToolLabel(null);
    setConversationId(newConversationId());
    try { sessionStorage.removeItem(HISTORY_KEY); } catch { /* fine */ }
  }, []);

  const openLink = useCallback((l: Link) => {
    sfx.play("nav");
    if (l.href) { window.location.href = l.href; return; }
    if (l.view) {
      if (pathname !== "/") { window.location.href = "/"; return; }
      window.dispatchEvent(new CustomEvent("os:navigate", { detail: l.view }));
    }
  }, [pathname]);

  useEffect(() => {
    const onOpen = () => { sfx.play("chime"); openPanel(); };
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      openPanel();
      if (typeof detail === "string" && detail.trim()) setTimeout(() => sendMessageRef.current(detail), 150);
    };
    window.addEventListener("jarvis:open", onOpen);
    window.addEventListener("jarvis:ask", onAsk);
    return () => {
      window.removeEventListener("jarvis:open", onOpen);
      window.removeEventListener("jarvis:ask", onAsk);
    };
  }, [openPanel]);

  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  const finishListening = useCallback((submit: boolean) => {
    listeningRef.current = false;
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    try { recognitionRef.current?.stop(); } catch { /* already stopped */ }
    setListening(false);
    const text = finalTranscriptRef.current.trim();
    finalTranscriptRef.current = "";
    if (submit && text) {
      setInput("");
      voiceOnRef.current = true;
      setVoiceOn(true);
      sendMessageRef.current(text);
    } else {
      setInput(text);
    }
  }, []);

  const startListening = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SpeechRecognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recognition: any = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    listeningRef.current = true;
    finalTranscriptRef.current = "";
    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => { if (listeningRef.current) finishListening(true); }, SILENCE_MS);
    };
    recognition.onstart = () => { setListening(true); resetSilenceTimer(); };
    recognition.onend = () => {
      if (listeningRef.current) { try { recognition.start(); return; } catch { /* fall through */ } }
      setListening(false);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onerror = (e: any) => {
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") finishListening(false);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTranscriptRef.current = (finalTranscriptRef.current + " " + r[0].transcript).trim();
        else interim += r[0].transcript;
      }
      setInput((finalTranscriptRef.current + " " + interim).trim());
      resetSilenceTimer();
    };
    recognitionRef.current = recognition;
    setInput("");
    recognition.start();
  }, [finishListening]);

  const stopListening = useCallback(() => { finishListening(true); }, [finishListening]);

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      try { recognitionRef.current?.stop(); } catch { /* noop */ }
      stopAudio();
    };
  }, [stopAudio]);

  // Hide on login page (after every hook so hook order never changes).
  if (pathname === "/login") return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  const smallBtn: React.CSSProperties = {
    background: "none", border: "1px solid rgba(16,192,240,0.25)", borderRadius: 6,
    color: "#8ab", cursor: "pointer", fontSize: 10, padding: "2px 8px", fontFamily: FONT,
  };

  return (
    <>
      <style>{`
        @keyframes jarvis-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(16,192,240,0.6); } 50% { box-shadow: 0 0 0 12px rgba(16,192,240,0); } }
        @keyframes jarvis-dots { 0%, 80%, 100% { opacity: 0; transform: scale(0.6); } 40% { opacity: 1; transform: scale(1); } }
        @keyframes jarvis-speak { 0%, 100% { transform: scaleY(0.4); opacity: 0.6; } 50% { transform: scaleY(1); opacity: 1; } }
        .jarvis-panel { position: fixed; bottom: 92px; right: 24px; width: 380px; height: 560px; }
        @media (max-width: 480px) {
          .jarvis-panel { left: 8px; right: 8px; bottom: 84px; width: auto; height: min(70vh, 560px); }
        }
        .jarvis-chip:hover { border-color: ${ACCENT} !important; color: ${ACCENT} !important; }
      `}</style>

      <button
        className="jarvis-fab"
        onClick={() => { sfx.play(open ? "close" : "chime"); if (open) setOpen(false); else openPanel(); }}
        title="Jarvis"
        aria-label="Open Jarvis"
        style={{
          position: "fixed", bottom: 24, right: 24, width: 56, height: 56, borderRadius: "50%",
          background: listening ? "#0ea5e9" : ACCENT, border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
          boxShadow: "0 4px 24px rgba(16,192,240,0.4)",
          animation: listening ? "jarvis-pulse 1s infinite" : "none",
          transition: "background 0.2s, transform 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.08)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        {listening ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="white" strokeWidth="1.4" strokeOpacity="0.55" />
            <path d="M12 6.2c.35 2.9 1.9 4.45 4.8 4.8-2.9.35-4.45 1.9-4.8 4.8-.35-2.9-1.9-4.45-4.8-4.8 2.9-.35 4.45-1.9 4.8-4.8Z" fill="white" />
            <circle cx="17" cy="7" r="1.15" fill="white" fillOpacity="0.9" />
          </svg>
        )}
      </button>

      {open && (
        <div
          className="jarvis-panel"
          data-testid="jarvis-panel"
          style={{
            background: "#0d1117", border: "1px solid rgba(16,192,240,0.25)", borderRadius: 16,
            display: "flex", flexDirection: "column", zIndex: 9998,
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)", overflow: "hidden",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid rgba(16,192,240,0.15)", background: "#0d1117", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: ACCENT, boxShadow: `0 0 6px ${ACCENT}`, flexShrink: 0 }}/>
              <span style={{ color: ACCENT, fontWeight: 700, fontSize: 15, fontFamily: "Space Grotesk, sans-serif" }}>Jarvis</span>
              {speaking && (
                <button onClick={stopAudio} title="Stop speaking" style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(16,192,240,0.12)", border: "1px solid rgba(16,192,240,0.4)", borderRadius: 6, padding: "2px 7px", cursor: "pointer" }}>
                  {[0, 1, 2].map((n) => (
                    <span key={n} style={{ width: 3, height: 10, borderRadius: 2, background: ACCENT, display: "inline-block", animation: "jarvis-speak 0.9s infinite ease-in-out", animationDelay: `${n * 0.15}s` }} />
                  ))}
                </button>
              )}
              {engine && (
                <span style={{ color: engine === "limited" ? "var(--orange)" : "#556", fontSize: 10, fontFamily: FONT, border: `1px solid ${engine === "limited" ? "rgba(251,146,60,0.4)" : "rgba(16,192,240,0.2)"}`, borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>
                  {engine === "claude-code" ? "via Claude Code" : engine === "limited" ? "limited mode" : "via API"}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button onClick={() => { const next = !voiceOn; setVoiceOn(next); if (!next) stopAudio(); }} title={voiceOn ? "Voice replies on" : "Voice replies off"} style={{ ...smallBtn, color: voiceOn ? ACCENT : "#556" }}>
                {voiceOn ? "Voice on" : "Voice off"}
              </button>
              <button onClick={clearChat} disabled={streaming} title="Clear this chat" style={{ ...smallBtn, cursor: streaming ? "default" : "pointer" }}>Clear chat</button>
              <button onClick={() => { sfx.play("close"); setOpen(false); }} aria-label="Close" style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <>
                <div style={{ color: "#556", fontSize: 13, textAlign: "center", marginTop: 28, fontFamily: FONT, lineHeight: 1.5 }}>
                  Ask about today, a contact, a task, an automation, or tell me to do something. Anything that changes data waits for your OK.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
                  {SUGGESTED.map((q) => (
                    <button key={q} className="jarvis-chip" onClick={() => sendMessageRef.current(q)} style={{
                      background: "rgba(16,192,240,0.06)", border: "1px solid rgba(16,192,240,0.22)",
                      borderRadius: 10, color: "#9bc", cursor: "pointer", fontSize: 12, textAlign: "left",
                      padding: "8px 12px", fontFamily: FONT, transition: "border-color 0.15s, color 0.15s",
                    }}>{q}</button>
                  ))}
                </div>
              </>
            )}
            {messages.map((msg, i) => {
              const isLast = i === messages.length - 1;
              const isUser = msg.role === "user";
              const showTyping = !isUser && msg.content === "" && isLast && streaming && !msg.pending;
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: isUser ? "flex-end" : "flex-start", gap: 4 }}>
                  {/* tool activity lines */}
                  {!isUser && (msg.tools?.length ?? 0) > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 6 }}>
                      {msg.tools!.map((t, k) => (
                        <span key={k} style={{ color: "#4a5568", fontSize: 11, fontFamily: FONT }}>{t}</span>
                      ))}
                    </div>
                  )}
                  {(isUser || msg.content || showTyping) && (
                    <div style={{
                      maxWidth: "86%", padding: "8px 12px",
                      borderRadius: isUser ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                      background: isUser ? ACCENT : "#161b22", color: isUser ? "#000" : "#e0e0e0",
                      fontSize: 13, lineHeight: 1.5, fontFamily: FONT,
                      border: isUser ? "none" : "1px solid rgba(16,192,240,0.1)", whiteSpace: "pre-wrap",
                    }}>
                      {showTyping ? (
                        <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
                          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                            {[0, 1, 2].map((n) => (
                              <div key={n} style={{ width: 6, height: 6, borderRadius: "50%", background: ACCENT, animation: "jarvis-dots 1.2s infinite ease-in-out", animationDelay: `${n * 0.15}s` }}/>
                            ))}
                          </div>
                          {toolLabel && <span style={{ color: ACCENT, fontSize: 11, opacity: 0.8, fontFamily: FONT }}>{toolLabel}</span>}
                        </div>
                      ) : msg.content}
                    </div>
                  )}
                  {/* pending action card */}
                  {!isUser && msg.pending && (
                    <div data-testid="jarvis-pending" style={{
                      maxWidth: "92%", border: `1px solid ${msg.pendingState === "open" ? "rgba(251,191,36,0.55)" : "rgba(16,192,240,0.15)"}`,
                      background: msg.pendingState === "open" ? "rgba(251,191,36,0.06)" : "#11151c",
                      borderRadius: 12, padding: "10px 12px", fontFamily: FONT,
                    }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: msg.pendingState === "open" ? "var(--orange)" : "#556", marginBottom: 4 }}>
                        {msg.pendingState === "open" ? "Jarvis wants to" : msg.pendingState === "done" ? "Confirmed" : msg.pendingState === "expired" ? "Expired, not run" : "Cancelled, not run"}
                      </div>
                      <div style={{ fontSize: 13, color: "#e0e0e0", lineHeight: 1.45 }}>{msg.pending.human_summary}</div>
                      {msg.pendingState === "open" && (
                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <button onClick={() => confirmAction(i)} disabled={streaming} data-testid="jarvis-do-it" style={{
                            background: ACCENT, color: "#000", border: "none", borderRadius: 8, padding: "6px 14px",
                            fontSize: 12, fontWeight: 700, cursor: streaming ? "default" : "pointer", fontFamily: FONT,
                          }}>Do it</button>
                          <button onClick={() => cancelAction(i)} disabled={streaming} style={{
                            background: "none", color: "#9bc", border: "1px solid rgba(16,192,240,0.3)", borderRadius: 8,
                            padding: "6px 14px", fontSize: 12, cursor: streaming ? "default" : "pointer", fontFamily: FONT,
                          }}>Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                  {/* links into the OS */}
                  {!isUser && (msg.links?.length ?? 0) > 0 && !(isLast && streaming) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingLeft: 2 }}>
                      {msg.links!.map((l, k) => (
                        <button key={k} className="jarvis-chip" onClick={() => openLink(l)} style={{
                          background: "none", border: "1px solid rgba(16,192,240,0.25)", borderRadius: 99,
                          color: "#8ab", cursor: "pointer", fontSize: 10, padding: "2px 9px", fontFamily: FONT,
                        }}>{l.label}</button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {speaking && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <button onClick={stopAudio} title="Stop reading this reply" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "1px solid rgba(16,192,240,0.3)", borderRadius: 99, color: ACCENT, cursor: "pointer", fontSize: 10, padding: "2px 9px", fontFamily: FONT }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill={ACCENT}><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  stop voice
                </button>
              </div>
            )}
            <div ref={messagesEndRef}/>
          </div>

          {/* Input */}
          <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid rgba(16,192,240,0.15)", background: "#0d1117" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={listening || streaming}
              placeholder={listening ? "Listening..." : hasSpeechAPI ? "Type or tap mic..." : "Type a message..."}
              aria-label="Message Jarvis"
              style={{ flex: 1, minWidth: 0, background: "#161b22", border: "1px solid rgba(16,192,240,0.2)", borderRadius: 10, color: "#e0e0e0", padding: "8px 12px", fontSize: 13, fontFamily: FONT, outline: "none" }}
            />
            {hasSpeechAPI && (
              <button type="button" onClick={listening ? stopListening : startListening} disabled={streaming} title={listening ? "Stop" : "Speak"} style={{ width: 36, height: 36, borderRadius: "50%", background: listening ? "#ef4444" : "rgba(16,192,240,0.15)", border: "1px solid rgba(16,192,240,0.3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.2s" }}>
                {listening ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                )}
              </button>
            )}
            <button type="submit" disabled={!input.trim() || streaming || listening} aria-label="Send" style={{ width: 36, height: 36, borderRadius: "50%", background: input.trim() && !streaming ? ACCENT : "rgba(16,192,240,0.1)", border: "none", cursor: input.trim() && !streaming ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.2s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={input.trim() && !streaming ? "#000" : "#444"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </form>
          {!hasSpeechAPI && (
            <div style={{ padding: "0 12px 8px", color: "#555", fontSize: 11, fontFamily: FONT }}>Voice input not available in this browser.</div>
          )}
        </div>
      )}
    </>
  );
}
