"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
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

const ACCENT = "#3D6BF0";
const FONT = "Inter, sans-serif";

// Nimbus's orb API (public/mascot/wing-mascot.js). Everything is optional
// because the script is loaded at runtime and may be an older build.
type Orb = {
  setState?: (s: string) => void;
  pulse?: (s: string, ms?: number) => void;
  flare?: () => void;
  getPinned?: () => string | null;
  destroy?: () => void;
};

// Sound cues stay silent for anyone who asked for reduced motion.
function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

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
  // The desktop hotkey window (/nimbus) is Nimbus alone: no OS shell behind him,
  // no floating button, the panel fills the window.
  const solo = pathname === "/nimbus";
  const [open, setOpen] = useState(false);
  // "Agent" runs the request through Claude Code on this PC instead of the API
  // tool loop, so a question can turn into real work on the machine.
  const [agentMode, setAgentMode] = useState(false);
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
  // Nimbus orb: the shared mascot component (vanilla) mounted into the FAB.
  const orbSlotRef = useRef<HTMLDivElement>(null);
  const orbRef = useRef<Orb | null>(null);
  const [orbOn, setOrbOn] = useState(false);
  const headerSlotRef = useRef<HTMLDivElement>(null);
  const headerOrbRef = useRef<Orb | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);
  const listeningRef = useRef(false);
  const finalTranscriptRef = useRef("");
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendMessageRef = useRef<(text: string) => void>(() => {});
  const agentModeRef = useRef(false);
  const SILENCE_MS = 4500;
  const [voiceOn, setVoiceOn] = useState(false);
  const voiceOnRef = useRef(false);
  const chosenVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => { voiceOnRef.current = voiceOn; }, [voiceOn]);

  // ── Nimbus's face: both orbs always express the same mood ─────────────────
  // Every mood below is driven by a real stream event or a real state flag.
  // Nothing here invents an outcome the server did not report.
  const expressAll = useCallback((fn: (orb: Orb) => void) => {
    [orbRef.current, headerOrbRef.current].forEach((orb) => {
      if (orb) {
        try { fn(orb); } catch { /* an older mascot build: skip silently */ }
      }
    });
  }, []);
  // Rest = whatever mood the page pinned (an honest dim stays dim), else calm.
  const restAll = useCallback(() => {
    expressAll((orb) => orb.setState?.(orb.getPinned?.() || "calm"));
  }, [expressAll]);
  // Sound cue that never fires under reduced motion and never before a gesture.
  const cue = useCallback((name: "reply" | "nimbus-error" | "confirmed") => {
    if (reducedMotion()) return;
    sfx.playWhenReady(name);
  }, []);

  // What the turn that just ran actually reported. Reset at the top of a turn.
  const turnOutcomeRef = useRef<{ failed: boolean; actionSucceeded: boolean }>({ failed: false, actionSucceeded: false });

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
      // Nimbus sounds young and friendly, so prefer natural US voices and
      // never the stately British assistant set.
      const prefer = [
        (v: SpeechSynthesisVoice) => /aria|jenny|guy|natural/i.test(v.name) && v.lang.startsWith("en-US"),
        (v: SpeechSynthesisVoice) => /google us english/i.test(v.name),
        (v: SpeechSynthesisVoice) => /samantha|alex|zira|david/i.test(v.name) && v.lang.startsWith("en"),
        (v: SpeechSynthesisVoice) => v.lang === "en-US",
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
    u.rate = 1.05; u.pitch = 1.08; u.volume = 1;
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
    turnOutcomeRef.current = { failed: false, actionSucceeded: false };
    setMessages([...history,{ role: "assistant", content: "", tools: [], links: [] }]);
    const patchLast = (fn: (m: Message) => Message) => {
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last?.role === "assistant") updated[updated.length - 1] = fn(last);
        return updated;
      });
    };
    let sawText = false;
    try {
      const res = await fetch("/api/jarvis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.slice(-MAX_TURNS * 2).map((m) => ({ role: m.role, content: m.content })),
          conversationId,
          ...(agentModeRef.current ? { engine: "cli" } : {}),
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
            // A tool actually starting is worth more than plain streaming:
            // Nimbus stays in thinking and flares once per tool step.
            expressAll((orb) => { orb.setState?.("thinking"); orb.flare?.(); });
            patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), lineText] }));
          }
          if (typeof ev.tool_done === "string") {
            // The server reports `ok` per tool run. false means the tool
            // returned an error or needs the PC; true on a confirmed write
            // means the action Jack approved really did run.
            if (ev.ok === false) turnOutcomeRef.current.failed = true;
            else if (ev.ok === true && confirm) turnOutcomeRef.current.actionSucceeded = true;
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
            sawText = true;
            patchLast((m) => ({ ...m, content: m.content + ev.text }));
          }
          if (ev.pending_action && typeof ev.pending_action === "object") {
            const pa = ev.pending_action as PendingAction;
            setToolLabel(null);
            patchLast((m) => ({ ...m, pending: pa, pendingState: "open" }));
          }
          if (ev.budget && typeof ev.budget === "object") {
            // A rate, spend or backend refusal from the API route.
            setToolLabel(null);
            turnOutcomeRef.current.failed = true;
          }
          if (typeof ev.error === "string" && ev.error) {
            turnOutcomeRef.current.failed = true;
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
      turnOutcomeRef.current.failed = true;
      patchLast((m) => ({ ...m, content: m.content || "Sorry, something went wrong. Check the console." }));
      console.error("[Jarvis]", err);
    } finally {
      setStreaming(false);
      setToolLabel(null);
      // How the turn actually ended, straight from what the stream reported.
      const { failed, actionSucceeded } = turnOutcomeRef.current;
      if (failed) {
        expressAll((orb) => orb.pulse?.("alert", 4200));
        cue("nimbus-error");
      } else if (actionSucceeded) {
        expressAll((orb) => orb.pulse?.("party", 3500));
        cue("confirmed");
      } else if (sawText) {
        expressAll((orb) => { orb.pulse?.("excited", 2200); orb.flare?.(); });
        cue("reply");
      } else {
        restAll();
      }
      // Whatever the branch did, make sure no mood can stick: an older cached
      // build of the mascot has no pulse(), so its timers never fire.
      setTimeout(restAll, 4600);
    }
  }, [conversationId, speak, expressAll, restAll, cue]);

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
    // Acknowledge the click without claiming an outcome: the celebration is
    // earned later, only by a tool_done that reports the write actually ran.
    expressAll((orb) => { orb.setState?.("thinking"); orb.flare?.(); });
    // Keep the assistant's lead-in text as history; the server runs the
    // signed action and narrates the outcome in a fresh assistant turn.
    await runTurn(history, token);
  }, [messages, streaming, runTurn, expressAll]);

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
    if (solo) {
      // The window IS Nimbus, so he is already listening when it appears.
      setTimeout(() => openPanel(), 60);
    }
    window.addEventListener("jarvis:open", onOpen);
    window.addEventListener("jarvis:ask", onAsk);
    // The desktop hotkey window opens the OS at #nimbus, so the panel is
    // already up and focused by the time Jack looks at it.
    if (typeof window !== "undefined" && window.location.hash === "#nimbus") {
      setTimeout(() => openPanel(), 120);
    }
    // Mount the Nimbus orb into the FAB (loads the shared mascot script once).
    let orbCancelled = false;
    const mountOrb = () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const WM = (window as any).WingMascot;
      if (orbCancelled || orbRef.current || !orbSlotRef.current || !WM) return;
      orbRef.current = WM.mount(orbSlotRef.current, { size: 76 });
      // Ambient idle/doze/wake already lives in the mascot (autoMood): it goes
      // sleepy after real inactivity and wakes on real activity or the tab
      // coming back. Wire it once here rather than rebuilding it in React.
      WM.autoMood?.(orbRef.current);
      setOrbOn(true);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any).WingMascot) mountOrb();
    else {
      let s = document.querySelector('script[data-nimbus]') as HTMLScriptElement | null;
      if (!s) {
        s = document.createElement("script");
        s.src = "/mascot/wing-mascot.js?v=9";
        s.dataset.nimbus = "1";
        document.head.appendChild(s);
      }
      s.addEventListener("load", mountOrb);
    }
    return () => {
      orbCancelled = true;
      window.removeEventListener("jarvis:open", onOpen);
      window.removeEventListener("jarvis:ask", onAsk);
      if (orbRef.current?.destroy) { orbRef.current.destroy(); orbRef.current = null; }
    };
  }, [openPanel, solo]);

  // Agent mode is remembered per machine, because it is a property of where
  // Nimbus is running, not of one conversation.
  useEffect(() => {
    let saved = false;
    try {
      saved = localStorage.getItem("nimbus:agent") === "1";
    } catch { /* private mode */ }
    agentModeRef.current = saved;
    // The stored choice only exists in the browser, so it cannot be initial
    // state without breaking hydration. One render, on mount, when it is set.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved) setAgentMode(true);
  }, []);

  // A mini Nimbus lives in the panel header (the only avatar on mobile,
  // where the bottom tab bar replaces the floating orb).
  useEffect(() => {
    if (!open || headerOrbRef.current || !headerSlotRef.current) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const WM = (window as any).WingMascot;
    if (!WM) return;
    const orb: Orb = WM.mount(headerSlotRef.current, { size: 38 });
    headerOrbRef.current = orb;
    WM.autoMood?.(orb);
    // Catch the mini orb up to the mood the floating one is already in.
    orb.setState?.(streaming ? "thinking" : (orb.getPinned?.() || "calm"));
    // Closing the panel unmounts the slot, so the orb must be destroyed with
    // it. Without this the ref stayed set, the reopened panel showed an empty
    // box, and the orb's window listeners leaked for the rest of the session.
    return () => {
      try { headerOrbRef.current?.destroy?.(); } catch { /* already gone */ }
      headerOrbRef.current = null;
    };
  }, [open, streaming]);

  // Nimbus thinks while a turn is in flight. He does NOT reset to calm here:
  // how a turn ended (excited, party, alert) is decided in runTurn's finally,
  // and those pulses fall back to the pinned mood or calm on their own.
  useEffect(() => {
    if (streaming) expressAll((orb) => orb.setState?.("thinking"));
  }, [streaming, expressAll]);

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
    background: "none", border: "1px solid rgba(61,107,240,0.25)", borderRadius: 6,
    color: "#8ab", cursor: "pointer", fontSize: 10, padding: "2px 8px", fontFamily: FONT,
  };

  return (
    <>
      <style>{`
        @keyframes jarvis-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(61,107,240,0.6); } 50% { box-shadow: 0 0 0 12px rgba(61,107,240,0); } }
        @keyframes jarvis-dots { 0%, 80%, 100% { opacity: 0; transform: scale(0.6); } 40% { opacity: 1; transform: scale(1); } }
        @keyframes jarvis-speak { 0%, 100% { transform: scaleY(0.4); opacity: 0.6; } 50% { transform: scaleY(1); opacity: 1; } }
        .jarvis-panel { position: fixed; bottom: 112px; right: 20px; width: 380px; height: 560px; }
        .jarvis-panel.jarvis-solo { inset: 0; width: auto; height: auto; border-radius: 0; border: none; box-shadow: none; }
        @media (max-width: 480px) {
          .jarvis-panel { left: 8px; right: 8px; bottom: 84px; width: auto; height: min(70vh, 560px); }
        }
        .jarvis-chip:hover { border-color: ${ACCENT} !important; color: ${ACCENT} !important; }
      `}</style>

      {!solo && <button
        className="jarvis-fab"
        onClick={() => { sfx.play(open ? "close" : "chime"); if (open) setOpen(false); else openPanel(); }}
        title="Nimbus"
        aria-label="Open Nimbus"
        style={{
          position: "fixed", bottom: 18, right: 18, width: 84, height: 84, borderRadius: "50%",
          background: orbOn ? "transparent" : (listening ? "#5f82f5" : ACCENT),
          border: "none", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 9999,
          boxShadow: orbOn ? "none" : "0 4px 24px rgba(61,107,240,0.4)",
          animation: listening ? "jarvis-pulse 1s infinite" : "none",
          transition: "background 0.2s, transform 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.08)")}
        onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
      >
        {/* Nimbus himself; the plain glyph only shows until his script mounts */}
        <div ref={orbSlotRef} style={{ width: 76, height: 76, display: orbOn ? "block" : "none", pointerEvents: "none" }} aria-hidden="true" />
        {!orbOn && (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" stroke="white" strokeWidth="1.4" strokeOpacity="0.55" />
            <path d="M12 6.2c.35 2.9 1.9 4.45 4.8 4.8-2.9.35-4.45 1.9-4.8 4.8-.35-2.9-1.9-4.45-4.8-4.8 2.9-.35 4.45-1.9 4.8-4.8Z" fill="white" />
            <circle cx="17" cy="7" r="1.15" fill="white" fillOpacity="0.9" />
          </svg>
        )}
        {listening && (
          <span style={{ position: "absolute", bottom: 2, right: 2, width: 18, height: 18, borderRadius: 6, background: "#e5484d", display: "flex", alignItems: "center", justifyContent: "center" }} aria-hidden="true">
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "#fff" }} />
          </span>
        )}
      </button>}

      {open && (
        <div
          className={solo ? "jarvis-panel jarvis-solo" : "jarvis-panel"}
          data-testid="jarvis-panel"
          style={{
            background: "#0d1117", border: "1px solid rgba(61,107,240,0.25)", borderRadius: 16,
            display: "flex", flexDirection: "column", zIndex: 9998,
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)", overflow: "hidden",
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: "1px solid rgba(61,107,240,0.15)", background: "#0d1117", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <div ref={headerSlotRef} style={{ width: 38, height: 38, flexShrink: 0 }} aria-hidden="true" />
              <span style={{ color: ACCENT, fontWeight: 700, fontSize: 15, fontFamily: "Space Grotesk, sans-serif" }}>Nimbus</span>
              {speaking && (
                <button onClick={stopAudio} title="Stop speaking" style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "rgba(61,107,240,0.12)", border: "1px solid rgba(61,107,240,0.4)", borderRadius: 6, padding: "2px 7px", cursor: "pointer" }}>
                  {[0, 1, 2].map((n) => (
                    <span key={n} style={{ width: 3, height: 10, borderRadius: 2, background: ACCENT, display: "inline-block", animation: "jarvis-speak 0.9s infinite ease-in-out", animationDelay: `${n * 0.15}s` }} />
                  ))}
                </button>
              )}
              {engine && (
                <span style={{ color: engine === "limited" ? "var(--orange)" : "#556", fontSize: 10, fontFamily: FONT, border: `1px solid ${engine === "limited" ? "rgba(251,146,60,0.4)" : "rgba(61,107,240,0.2)"}`, borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>
                  {engine === "claude-code" ? "via Claude Code" : engine === "limited" ? "limited mode" : "via API"}
                </span>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button onClick={() => { const next = !voiceOn; setVoiceOn(next); if (!next) stopAudio(); }} title={voiceOn ? "Voice replies on" : "Voice replies off"} style={{ ...smallBtn, color: voiceOn ? ACCENT : "#556" }}>
                {voiceOn ? "Voice on" : "Voice off"}
              </button>
              <button
                onClick={() => { const next = !agentMode; setAgentMode(next); agentModeRef.current = next; try { localStorage.setItem("nimbus:agent", next ? "1" : "0"); } catch { /* private mode */ } }}
                disabled={streaming}
                title={agentMode
                  ? "Agent mode: runs through Claude Code on this PC, so he can read and change files and run commands. No confirmation cards in this mode."
                  : "Chat mode: the OS tool set, and every write stops at a confirmation card."}
                style={{ ...smallBtn, color: agentMode ? "#7ee0a8" : "#556", borderColor: agentMode ? "rgba(126,224,168,0.45)" : undefined, cursor: streaming ? "default" : "pointer" }}
              >
                {agentMode ? "Agent" : "Chat"}
              </button>
              <button onClick={clearChat} disabled={streaming} title="Clear this chat" style={{ ...smallBtn, cursor: streaming ? "default" : "pointer" }}>Clear chat</button>
              {!solo && (
                <button onClick={() => { sfx.play("close"); setOpen(false); }} aria-label="Close" style={{ background: "none", border: "none", color: "#666", cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
              )}
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
                      background: "rgba(61,107,240,0.06)", border: "1px solid rgba(61,107,240,0.22)",
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
                      border: isUser ? "none" : "1px solid rgba(61,107,240,0.1)", whiteSpace: "pre-wrap",
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
                      maxWidth: "92%", border: `1px solid ${msg.pendingState === "open" ? "rgba(251,191,36,0.55)" : "rgba(61,107,240,0.15)"}`,
                      background: msg.pendingState === "open" ? "rgba(251,191,36,0.06)" : "#11151c",
                      borderRadius: 12, padding: "10px 12px", fontFamily: FONT,
                    }}>
                      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: msg.pendingState === "open" ? "var(--orange)" : "#556", marginBottom: 4 }}>
                        {msg.pendingState === "open" ? "Nimbus wants to" : msg.pendingState === "done" ? "Confirmed" : msg.pendingState === "expired" ? "Expired, not run" : "Cancelled, not run"}
                      </div>
                      <div style={{ fontSize: 13, color: "#e0e0e0", lineHeight: 1.45 }}>{msg.pending.human_summary}</div>
                      {msg.pendingState === "open" && (
                        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                          <button onClick={() => confirmAction(i)} disabled={streaming} data-testid="jarvis-do-it" style={{
                            background: ACCENT, color: "#000", border: "none", borderRadius: 8, padding: "6px 14px",
                            fontSize: 12, fontWeight: 700, cursor: streaming ? "default" : "pointer", fontFamily: FONT,
                          }}>Do it</button>
                          <button onClick={() => cancelAction(i)} disabled={streaming} style={{
                            background: "none", color: "#9bc", border: "1px solid rgba(61,107,240,0.3)", borderRadius: 8,
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
                          background: "none", border: "1px solid rgba(61,107,240,0.25)", borderRadius: 99,
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
                <button onClick={stopAudio} title="Stop reading this reply" style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "none", border: "1px solid rgba(61,107,240,0.3)", borderRadius: 99, color: ACCENT, cursor: "pointer", fontSize: 10, padding: "2px 9px", fontFamily: FONT }}>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill={ACCENT}><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
                  stop voice
                </button>
              </div>
            )}
            <div ref={messagesEndRef}/>
          </div>

          {/* Input */}
          <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8, padding: "10px 12px", borderTop: "1px solid rgba(61,107,240,0.15)", background: "#0d1117" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={listening || streaming}
              placeholder={listening ? "Listening..." : hasSpeechAPI ? "Type or tap mic..." : "Type a message..."}
              aria-label="Message Nimbus"
              style={{ flex: 1, minWidth: 0, background: "#161b22", border: "1px solid rgba(61,107,240,0.2)", borderRadius: 10, color: "#e0e0e0", padding: "8px 12px", fontSize: 13, fontFamily: FONT, outline: "none" }}
            />
            {hasSpeechAPI && (
              <button type="button" onClick={listening ? stopListening : startListening} disabled={streaming} title={listening ? "Stop" : "Speak"} style={{ width: 36, height: 36, borderRadius: "50%", background: listening ? "#ef4444" : "rgba(61,107,240,0.15)", border: "1px solid rgba(61,107,240,0.3)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.2s" }}>
                {listening ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
                  </svg>
                )}
              </button>
            )}
            <button type="submit" disabled={!input.trim() || streaming || listening} aria-label="Send" style={{ width: 36, height: 36, borderRadius: "50%", background: input.trim() && !streaming ? ACCENT : "rgba(61,107,240,0.1)", border: "none", cursor: input.trim() && !streaming ? "pointer" : "default", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.2s" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={input.trim() && !streaming ? "#000" : "#444"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            </button>
          </form>
          {!hasSpeechAPI && (
            <div style={{ padding: "0 12px 8px", color: "#555", fontSize: 11, fontFamily: FONT }}>Voice input not available in this browser.</div>
          )}

          {/* The way out of the solo window and into the full OS. */}
          {solo && (
            <Link
              href="/"
              title="Open the full OS in the browser"
              style={{
                // Sits just above the composer: as a bottom-right pill it used
                // to cover the Send button and swallow the click.
                position: "fixed", right: 14, bottom: 66, zIndex: 10000,
                display: "inline-flex", alignItems: "center", gap: 6,
                background: "rgba(61,107,240,0.10)", border: "1px solid rgba(61,107,240,0.30)",
                borderRadius: 999, padding: "6px 12px", color: "#9bc",
                fontSize: 11.5, fontFamily: FONT, textDecoration: "none",
              }}
            >
              Open the OS
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M7 17 17 7" /><path d="M8 7h9v9" />
              </svg>
            </Link>
          )}
        </div>
      )}
    </>
  );
}
