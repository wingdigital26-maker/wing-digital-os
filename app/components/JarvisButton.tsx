"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";

type Message = { role: "user" | "assistant"; content: string };

export default function JarvisButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [listening, setListening] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [toolLabel, setToolLabel] = useState<string | null>(null);
  const [hasSpeechAPI, setHasSpeechAPI] = useState(true);
  // One Claude Code session per panel-open; "New chat" resets it.
  const [conversationId, setConversationId] = useState<string>("");
  const [engine, setEngine] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  // Continuous-voice state: are we intentionally listening, accumulated final
  // transcript across pauses, and the silence auto-submit timer.
  const listeningRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendMessageRef = useRef<(text: string) => void>(() => {});
  const SILENCE_MS = 4500;
  // Voice output: speak replies aloud with the best deep or UK voice available.
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(false);
  const chosenVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  // ElevenLabs playback state: current Audio element + speaking indicator.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  // Pick the best available voice at runtime: deep or UK male first.
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
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  // Browser speechSynthesis — fallback path only, if the TTS endpoint errors.
  const speakFallback = useCallback((clean: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    if (chosenVoiceRef.current) u.voice = chosenVoiceRef.current;
    u.rate = 1.02;
    u.pitch = 0.85;
    u.volume = 1;
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(u);
  }, []);

  // Primary voice path: ElevenLabs via /api/jarvis/tts, with graceful
  // fallback to speechSynthesis so voice never fully dies.
  const speak = useCallback(async (text: string) => {
    const clean = text
      .replace(/```[\s\S]*?```/g, " code block ")
      // Strip emoji/symbol unicode so speechSynthesis never reads "red dot" etc.
      .replace(/[\u{1F000}-\u{1FBFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{25FF}\u{2022}\u{FE00}-\u{FE0F}\u{200D}\u{20D0}-\u{20FF}\u{E000}-\u{F8FF}]/gu, " ")
      .replace(/[#*_`>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 800);
    if (!clean) return;
    stopAudio();
    try {
      const res = await fetch("/api/jarvis/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean }),
      });
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
      // Endpoint down, quota out, or autoplay blocked: fall back to the browser voice.
      speakFallback(clean);
    }
  }, [stopAudio, speakFallback]);

  // Hide on login page
  if (pathname === "/login") return null;

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    if (!w.SpeechRecognition && !w.webkitSpeechRecognition) setHasSpeechAPI(false);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Assign a conversationId the first time the panel opens.
  useEffect(() => {
    if (open && !conversationId) {
      setConversationId(
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
    }
  }, [open, conversationId]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;
    const userMsg: Message = { role: "user", content: text.trim() };
    const updatedHistory = [...messages, userMsg];
    setMessages(updatedHistory);
    setInput("");
    setStreaming(true);

    // Add placeholder assistant message
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const res = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updatedHistory, stream: true, conversationId }),
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
          try {
            const parsed = JSON.parse(data);
            if (parsed.engine) {
              // Which backend answered: "claude-code" (CLI) or "api" (fallback).
              setEngine(parsed.engine);
            }
            if (parsed.tool) {
              // Jarvis is running a server-side tool — show which one, plus a hint.
              const detail = parsed.detail ? `: ${parsed.detail}` : "";
              setToolLabel(`→ ${parsed.tool}${detail}...`);
            }
            if (parsed.text) {
              setToolLabel(null); // real text is arriving; drop the indicator
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: "assistant",
                  content: updated[updated.length - 1].content + parsed.text,
                };
                return updated;
              });
            }
          } catch {
            // skip
          }
        }
      }
      // Voice mode: read the finished reply aloud.
      if (voiceOnRef.current) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.content) speak(last.content);
          return prev;
        });
      }
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: "Sorry, something went wrong. Check the console.",
        };
        return updated;
      });
      console.error("[Jarvis]", err);
    } finally {
      setStreaming(false);
      setToolLabel(null);
    }
  }, [messages, streaming, conversationId, speak]);

  // Global events: the sidebar Jarvis button and "Ask" buttons around the OS
  // open this panel (and optionally preload a question).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onAsk = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setOpen(true);
      if (typeof detail === "string" && detail.trim()) {
        setTimeout(() => sendMessageRef.current(detail), 150);
      }
    };
    window.addEventListener("jarvis:open", onOpen);
    window.addEventListener("jarvis:ask", onAsk);
    return () => {
      window.removeEventListener("jarvis:open", onOpen);
      window.removeEventListener("jarvis:ask", onAsk);
    };
  }, []);

  // Keep a stable ref to sendMessage so timers/recognition callbacks never go stale.
  useEffect(() => {
    sendMessageRef.current = sendMessage;
  }, [sendMessage]);

  const finishListening = useCallback((submit: boolean) => {
    listeningRef.current = false;
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      /* already stopped */
    }
    setListening(false);
    const text = finalTranscriptRef.current.trim();
    finalTranscriptRef.current = "";
    if (submit && text) {
      setInput("");
      // Spoke to Jarvis: speak the reply back.
      voiceOnRef.current = true;
      setVoiceOn(true);
      sendMessageRef.current(text);
    } else {
      setInput(text); // leave captured text in the input for editing
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
    recognition.continuous = true; // keep the session open across pauses
    recognition.interimResults = true; // live transcript while speaking
    recognition.maxAlternatives = 1;

    listeningRef.current = true;
    finalTranscriptRef.current = "";

    const resetSilenceTimer = () => {
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = setTimeout(() => {
        // ~4.5s of silence -> auto-submit whatever we captured.
        if (listeningRef.current) finishListening(true);
      }, SILENCE_MS);
    };

    recognition.onstart = () => {
      setListening(true);
      resetSilenceTimer();
    };
    recognition.onend = () => {
      // Chrome kills recognition sessions periodically. If we're still meant to
      // be listening, restart transparently and keep accumulating.
      if (listeningRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          /* fall through to stop */
        }
      }
      setListening(false);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onerror = (e: any) => {
      // 'no-speech' fires on quiet gaps — the silence timer handles submission,
      // and onend will restart the session. Only hard errors end listening.
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        finishListening(false);
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (e: any) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          finalTranscriptRef.current =
            (finalTranscriptRef.current + " " + r[0].transcript).trim();
        } else {
          interim += r[0].transcript;
        }
      }
      // Show the live transcript (final so far + interim) in the input.
      setInput((finalTranscriptRef.current + " " + interim).trim());
      resetSilenceTimer(); // any speech activity resets the 4.5s silence clock
    };

    recognitionRef.current = recognition;
    setInput("");
    recognition.start();
  }, [finishListening]);

  const stopListening = useCallback(() => {
    // Clicking stop submits whatever was captured so far.
    finishListening(true);
  }, [finishListening]);

  useEffect(() => {
    return () => {
      listeningRef.current = false;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {
        /* noop */
      }
      stopAudio();
    };
  }, [stopAudio]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(input);
  };

  return (
    <>
      <style>{`
        @keyframes jarvis-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(16,192,240,0.6); }
          50% { box-shadow: 0 0 0 12px rgba(16,192,240,0); }
        }
        @keyframes jarvis-dots {
          0%, 80%, 100% { opacity: 0; transform: scale(0.6); }
          40% { opacity: 1; transform: scale(1); }
        }
        .jarvis-dot:nth-child(1) { animation-delay: 0s; }
        .jarvis-dot:nth-child(2) { animation-delay: 0.15s; }
        .jarvis-dot:nth-child(3) { animation-delay: 0.30s; }
        @keyframes jarvis-speak {
          0%, 100% { transform: scaleY(0.4); opacity: 0.6; }
          50% { transform: scaleY(1); opacity: 1; }
        }
      `}</style>

      {/* Floating trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        title="Jarvis AI"
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 56,
          height: 56,
          borderRadius: "50%",
          background: listening ? "#0ea5e9" : "#10C0F0",
          border: "none",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          boxShadow: "0 4px 24px rgba(16,192,240,0.4)",
          animation: listening ? "jarvis-pulse 1s infinite" : "none",
          transition: "background 0.2s, transform 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.08)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        {listening ? (
          /* Waveform stop icon */
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
            <rect x="3" y="3" width="18" height="18" rx="3"/>
          </svg>
        ) : (
          /* Microphone icon */
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8" y1="23" x2="16" y2="23"/>
          </svg>
        )}
      </button>

      {/* Chat panel */}
      {open && (
        <div
          style={{
            position: "fixed",
            bottom: 92,
            right: 24,
            width: 380,
            height: 520,
            background: "#0d1117",
            border: "1px solid rgba(16,192,240,0.25)",
            borderRadius: 16,
            display: "flex",
            flexDirection: "column",
            zIndex: 9998,
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 16px",
            borderBottom: "1px solid rgba(16,192,240,0.15)",
            background: "#0d1117",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#10C0F0",
                boxShadow: "0 0 6px #10C0F0",
              }}/>
              <span style={{ color: "#10C0F0", fontWeight: 700, fontSize: 15, fontFamily: "Space Grotesk, sans-serif" }}>
                Jarvis
              </span>
              {speaking && (
                <span
                  title="Jarvis is speaking"
                  style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                >
                  {[0, 1, 2].map((n) => (
                    <span key={n} className="jarvis-dot" style={{
                      width: 3, height: 10, borderRadius: 2, background: "#10C0F0",
                      display: "inline-block",
                      animation: "jarvis-speak 0.9s infinite ease-in-out",
                      animationDelay: `${n * 0.15}s`,
                    }} />
                  ))}
                </span>
              )}
              {engine && (
                <span style={{ color: engine === "limited" ? "#fb923c" : "#556", fontSize: 10, fontFamily: "Inter, sans-serif", border: `1px solid ${engine === "limited" ? "rgba(251,146,60,0.4)" : "rgba(16,192,240,0.2)"}`, borderRadius: 6, padding: "1px 6px" }}>
                  {engine === "claude-code" ? "via Claude Code" : engine === "limited" ? "limited mode" : "via API"}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <button
                onClick={() => {
                  const next = !voiceOn;
                  setVoiceOn(next);
                  if (!next) stopAudio();
                }}
                title={voiceOn ? "Voice replies on" : "Voice replies off"}
                style={{ background: "none", border: "1px solid rgba(16,192,240,0.25)", borderRadius: 6, color: voiceOn ? "#10C0F0" : "#556", cursor: "pointer", fontSize: 10, padding: "2px 8px", fontFamily: "Inter, sans-serif" }}
              >{voiceOn ? "Voice on" : "Voice off"}</button>
              <button
                onClick={() => {
                  // New chat: fresh Claude Code session + clean panel.
                  setMessages([]);
                  setEngine(null);
                  setToolLabel(null);
                  setConversationId(
                    typeof crypto !== "undefined" && crypto.randomUUID
                      ? crypto.randomUUID()
                      : `conv-${Date.now()}-${Math.random().toString(36).slice(2)}`
                  );
                }}
                disabled={streaming}
                title="Start a new conversation"
                style={{ background: "none", border: "1px solid rgba(16,192,240,0.25)", borderRadius: 6, color: "#8ab", cursor: streaming ? "default" : "pointer", fontSize: 10, padding: "2px 8px", fontFamily: "Inter, sans-serif" }}
              >New chat</button>
              <button
                onClick={() => setOpen(false)}
                style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}
              >×</button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
            {messages.length === 0 && (
              <div style={{ color: "#444", fontSize: 13, textAlign: "center", marginTop: 40, fontFamily: "Inter, sans-serif" }}>
                Ask Jarvis anything about Wing Digital OS...
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                <div style={{
                  maxWidth: "82%",
                  padding: "8px 12px",
                  borderRadius: msg.role === "user" ? "14px 14px 4px 14px" : "14px 14px 14px 4px",
                  background: msg.role === "user" ? "#10C0F0" : "#161b22",
                  color: msg.role === "user" ? "#000" : "#e0e0e0",
                  fontSize: 13,
                  lineHeight: 1.5,
                  fontFamily: "Inter, sans-serif",
                  border: msg.role === "assistant" ? "1px solid rgba(16,192,240,0.1)" : "none",
                  whiteSpace: "pre-wrap",
                }}>
                  {msg.content === "" && msg.role === "assistant" ? (
                    /* Typing / tool-running indicator */
                    <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
                      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                        {[0,1,2].map((n) => (
                          <div key={n} className="jarvis-dot" style={{
                            width: 6, height: 6, borderRadius: "50%", background: "#10C0F0",
                            animation: "jarvis-dots 1.2s infinite ease-in-out",
                            animationDelay: `${n * 0.15}s`,
                          }}/>
                        ))}
                      </div>
                      {i === messages.length - 1 && toolLabel && (
                        <span style={{ color: "#10C0F0", fontSize: 11, opacity: 0.8, fontFamily: "Inter, sans-serif" }}>
                          {toolLabel}
                        </span>
                      )}
                    </div>
                  ) : msg.content}
                </div>
              </div>
            ))}
            <div ref={messagesEndRef}/>
          </div>

          {/* Input area */}
          <form onSubmit={handleSubmit} style={{
            display: "flex",
            gap: 8,
            padding: "10px 12px",
            borderTop: "1px solid rgba(16,192,240,0.15)",
            background: "#0d1117",
          }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={listening || streaming}
              placeholder={listening ? "Listening..." : hasSpeechAPI ? "Type or tap mic..." : "Type a message..."}
              style={{
                flex: 1,
                background: "#161b22",
                border: "1px solid rgba(16,192,240,0.2)",
                borderRadius: 10,
                color: "#e0e0e0",
                padding: "8px 12px",
                fontSize: 13,
                fontFamily: "Inter, sans-serif",
                outline: "none",
              }}
            />
            {hasSpeechAPI && (
              <button
                type="button"
                onClick={listening ? stopListening : startListening}
                disabled={streaming}
                title={listening ? "Stop" : "Speak"}
                style={{
                  width: 36, height: 36,
                  borderRadius: "50%",
                  background: listening ? "#ef4444" : "rgba(16,192,240,0.15)",
                  border: "1px solid rgba(16,192,240,0.3)",
                  cursor: "pointer",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0,
                  transition: "background 0.2s",
                }}
              >
                {listening ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                    <rect x="3" y="3" width="18" height="18" rx="3"/>
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#10C0F0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                    <line x1="12" y1="19" x2="12" y2="23"/>
                    <line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                )}
              </button>
            )}
            <button
              type="submit"
              disabled={!input.trim() || streaming || listening}
              style={{
                width: 36, height: 36,
                borderRadius: "50%",
                background: input.trim() && !streaming ? "#10C0F0" : "rgba(16,192,240,0.1)",
                border: "none",
                cursor: input.trim() && !streaming ? "pointer" : "default",
                display: "flex", alignItems: "center", justifyContent: "center",
                flexShrink: 0,
                transition: "background 0.2s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={input.trim() && !streaming ? "#000" : "#444"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </form>

          {!hasSpeechAPI && (
            <div style={{ padding: "0 12px 8px", color: "#555", fontSize: 11, fontFamily: "Inter, sans-serif" }}>
              Voice input not available in this browser.
            </div>
          )}
        </div>
      )}
    </>
  );
}
