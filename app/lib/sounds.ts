"use client";

// WING OS SFX — tiny synthesized UI sound engine (Web Audio, zero assets).
// Sci-fi mission-control palette: short, quiet, satisfying. Every sound is
// built from oscillators/noise + envelopes at call time; nothing is loaded.
// The AudioContext is created lazily on the first user gesture (autoplay rules)
// and is fully separate from the Jarvis TTS audio path (HTMLAudioElement).

const MASTER_VOLUME = 0.15;
const LS_KEY = "wingos-sfx-muted";

type SoundName =
  | "blip" // node/tile click (agents tier)
  | "blip-system" // system-tier node click (lower)
  | "blip-artifact" // artifact-tier node click (higher, softer)
  | "open" // panel open: quick rise
  | "close" // panel close: quick fall
  | "nav" // nav section change: low tick
  | "ping" // stat tile click: data ping
  | "chime" // Jarvis open: soft two-note chime
  | "send" // Jarvis send: crisp send tick
  | "toggle-on"
  | "toggle-off"
  | "hover" // map node hover: VERY quiet tick, throttled
  // ── vault graph space set ──
  | "graph-hover" // node hover: soft high shimmer tick, throttled
  | "graph-focus" // node click/focus: deep resonant ping, layered with reverb tail
  | "graph-zoom" // significant zoom change: very subtle woosh, throttled
  | "tree-open" // folder open: paper-ish tick up
  | "tree-close" // folder close: paper-ish tick down
  | "graph-arrive"; // graph settle/load complete: quiet three-note arrival chime

class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private lastHover = 0;
  private lastGraphHover = 0;
  private lastZoom = 0;
  private listeners = new Set<(muted: boolean) => void>();

  constructor() {
    if (typeof window !== "undefined") {
      try {
        this.muted = window.localStorage.getItem(LS_KEY) === "1";
      } catch {
        /* storage unavailable: default unmuted */
      }
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      window.localStorage.setItem(LS_KEY, m ? "1" : "0");
    } catch {
      /* noop */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume(), this.ctx.currentTime, 0.01);
    }
    this.listeners.forEach((fn) => fn(m));
  }

  toggle(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  subscribe(fn: (muted: boolean) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Respect prefers-reduced-motion by dropping the level further.
  private volume(): number {
    if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      return MASTER_VOLUME * 0.4;
    }
    return MASTER_VOLUME;
  }

  // Lazily create the context; must be called from a user-gesture handler.
  private ensure(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : this.volume();
        this.master.connect(this.ctx.destination);
      } catch {
        return null;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  // One enveloped oscillator voice.
  private tone(opts: {
    freq: number;
    endFreq?: number;
    type?: OscillatorType;
    attack?: number;
    decay: number;
    gain?: number;
    delay?: number;
  }) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.endFreq) osc.frequency.exponentialRampToValueAtTime(opts.endFreq, t0 + opts.decay);
    const peak = opts.gain ?? 1;
    const attack = opts.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.decay);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + opts.decay + 0.05);
  }

  // Short filtered noise burst (whoosh body).
  private noise(opts: { decay: number; gain?: number; from: number; to: number; delay?: number }) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const len = Math.ceil(ctx.sampleRate * opts.decay);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(opts.from, t0);
    filter.frequency.exponentialRampToValueAtTime(opts.to, t0 + opts.decay);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.5, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.decay);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + opts.decay + 0.05);
  }

  // Play now if the AudioContext is already unlocked (a prior user gesture
  // created/resumed it); otherwise queue the sound to fire on the very next
  // user interaction instead of being silently dropped by autoplay rules.
  // Used for arrival/ambient cues that are not themselves gesture-driven.
  playWhenReady(name: SoundName) {
    if (this.muted || typeof window === "undefined") return;
    if (this.ctx && this.ctx.state === "running") {
      this.play(name);
      return;
    }
    const fire = () => {
      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", fire);
      // Tiny delay so the gesture itself unlocks the context first.
      window.setTimeout(() => this.play(name), 30);
    };
    window.addEventListener("pointerdown", fire, { once: true });
    window.addEventListener("keydown", fire, { once: true });
  }

  play(name: SoundName) {
    if (this.muted) return;
    switch (name) {
      case "blip": // agent node: soft mid blip
        this.tone({ freq: 660, endFreq: 880, type: "sine", decay: 0.09, gain: 0.9 });
        break;
      case "blip-system": // system node: clean glassy sine, gentle rise + quiet octave
        this.tone({ freq: 460, endFreq: 540, type: "sine", attack: 0.008, decay: 0.11, gain: 0.85 });
        this.tone({ freq: 920, endFreq: 1080, type: "sine", attack: 0.008, decay: 0.08, gain: 0.18 });
        break;
      case "blip-artifact": // artifact node: higher, lighter
        this.tone({ freq: 880, endFreq: 1100, type: "sine", decay: 0.07, gain: 0.7 });
        break;
      case "open": // quick whoosh + rise
        this.noise({ decay: 0.18, gain: 0.35, from: 400, to: 2400 });
        this.tone({ freq: 300, endFreq: 700, type: "sine", decay: 0.16, gain: 0.5 });
        break;
      case "close": // fall
        this.noise({ decay: 0.14, gain: 0.25, from: 1800, to: 350 });
        this.tone({ freq: 600, endFreq: 260, type: "sine", decay: 0.13, gain: 0.45 });
        break;
      case "nav": // low tick
        this.tone({ freq: 220, type: "triangle", decay: 0.06, gain: 0.8 });
        this.tone({ freq: 440, type: "sine", decay: 0.04, gain: 0.3 });
        break;
      case "ping": // data ping: bright with a fifth above
        this.tone({ freq: 990, type: "sine", decay: 0.12, gain: 0.6 });
        this.tone({ freq: 1485, type: "sine", decay: 0.1, gain: 0.25, delay: 0.03 });
        break;
      case "chime": // Jarvis open: soft two-note chime up
        this.tone({ freq: 523.25, type: "sine", decay: 0.18, gain: 0.5 });
        this.tone({ freq: 783.99, type: "sine", decay: 0.22, gain: 0.45, delay: 0.09 });
        break;
      case "send": // crisp send tick with a little lift
        this.tone({ freq: 740, endFreq: 1180, type: "square", attack: 0.002, decay: 0.05, gain: 0.25 });
        this.tone({ freq: 1480, type: "sine", decay: 0.07, gain: 0.35, delay: 0.03 });
        break;
      case "toggle-on": // two-tone up
        this.tone({ freq: 440, type: "sine", decay: 0.06, gain: 0.6 });
        this.tone({ freq: 660, type: "sine", decay: 0.08, gain: 0.6, delay: 0.06 });
        break;
      case "toggle-off": // two-tone down
        this.tone({ freq: 660, type: "sine", decay: 0.06, gain: 0.6 });
        this.tone({ freq: 440, type: "sine", decay: 0.08, gain: 0.6, delay: 0.06 });
        break;
      case "graph-hover": {
        // soft high shimmer: two tiny detuned sines, throttled ~7/sec
        const now = Date.now();
        if (now - this.lastGraphHover < 140) return;
        this.lastGraphHover = now;
        this.tone({ freq: 1560, type: "sine", decay: 0.05, gain: 0.1 });
        this.tone({ freq: 2093, type: "sine", decay: 0.07, gain: 0.06, delay: 0.012 });
        break;
      }
      case "graph-focus":
        // deep resonant ping: low fundamental + fifth + faint echo tail (reverb feel)
        this.tone({ freq: 196, type: "sine", attack: 0.006, decay: 0.5, gain: 0.55 });
        this.tone({ freq: 294, type: "sine", decay: 0.4, gain: 0.3, delay: 0.015 });
        this.tone({ freq: 588, type: "triangle", decay: 0.22, gain: 0.14, delay: 0.02 });
        this.tone({ freq: 196, type: "sine", decay: 0.35, gain: 0.14, delay: 0.16 });
        this.tone({ freq: 294, type: "sine", decay: 0.3, gain: 0.07, delay: 0.28 });
        break;
      case "graph-zoom": {
        // very subtle woosh, throttled hard so continuous zooming stays quiet
        const now = Date.now();
        if (now - this.lastZoom < 450) return;
        this.lastZoom = now;
        this.noise({ decay: 0.16, gain: 0.1, from: 500, to: 1600 });
        break;
      }
      case "tree-open": // paper-ish tick up
        this.noise({ decay: 0.05, gain: 0.14, from: 1600, to: 3400 });
        this.tone({ freq: 520, endFreq: 700, type: "triangle", decay: 0.06, gain: 0.35 });
        break;
      case "tree-close": // paper-ish tick down
        this.noise({ decay: 0.05, gain: 0.12, from: 3000, to: 1300 });
        this.tone({ freq: 700, endFreq: 480, type: "triangle", decay: 0.06, gain: 0.32 });
        break;
      case "graph-arrive": // quiet three-note arrival chime (C5 E5 G5)
        this.tone({ freq: 523.25, type: "sine", decay: 0.2, gain: 0.28 });
        this.tone({ freq: 659.25, type: "sine", decay: 0.22, gain: 0.26, delay: 0.11 });
        this.tone({ freq: 783.99, type: "sine", decay: 0.34, gain: 0.24, delay: 0.22 });
        break;
      case "hover": {
        // VERY quiet tick, throttled to at most ~8/sec
        const now = Date.now();
        if (now - this.lastHover < 120) return;
        this.lastHover = now;
        this.tone({ freq: 1200, type: "sine", decay: 0.025, gain: 0.12 });
        break;
      }
    }
  }
}

export const sfx = new SfxEngine();
// Debug/console handle (lets Jack try sounds from devtools: __wingSfx.play("ping")).
if (typeof window !== "undefined") {
  (window as unknown as { __wingSfx?: SfxEngine }).__wingSfx = sfx;
}
export type { SoundName };
