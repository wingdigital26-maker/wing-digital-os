"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "./stage.css";

type Mood = "calm" | "excited" | "thinking" | "alert" | "party" | "sleepy" | "dim";

type MascotHandle = {
  setState: (state: Mood) => void;
  destroy: () => void;
};

declare global {
  interface Window {
    WingMascot?: {
      mount: (el: HTMLElement, opts?: { size?: number; intro?: boolean; hero?: boolean }) => MascotHandle;
    };
  }
}

type Glance = {
  ok?: boolean;
  greeting?: { partOfDay?: "morning" | "afternoon" | "evening"; dateLine?: string } | null;
  // `unknown` is the watch's own list of checks that could not run. It arrives
  // only if the glance route carries it; until then we say nothing about which.
  watch?: {
    problems?: number;
    headline?: string;
    // The checks the WATCH could not run. This is what the headline's
    // "and N checks could not run" clause counts, so it must be shown.
    unknowns?: { id?: string; label?: string; reason?: string }[] | null;
    asOf?: string | null;
    ageSeconds?: number | null;
    stale?: boolean | null;
  } | null;
  mrr?: { value?: number; line?: string } | null;
  nextAgentRun?: { agent?: string; when?: string } | null;
  couldNotCheck?: string[] | null;
};

const MASCOT_SRC = "/mascot/wing-mascot.js?v=13";
const MASCOT_TIMEOUT_MS = 8000;

// One shared load promise: the window can remount the stage during dev refreshes
// and we never want two copies of the mascot script in the document.
let scriptPromise: Promise<void> | null = null;

// Resolving only means the file arrived. What we actually need is the global,
// and a script tag that has already settled fires neither load nor error again,
// so readiness is polled rather than waited on. Every path here ends in either
// a real WingMascot or a rejection, never in silence.
function loadMascot(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  if (window.WingMascot) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const p = new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      window.clearInterval(poll);
      window.clearTimeout(deadline);
      if (err) reject(err);
      else resolve();
    };

    // The only success condition that matters.
    const poll = window.setInterval(() => {
      if (window.WingMascot) finish();
    }, 60);
    const deadline = window.setTimeout(
      () => finish(new Error("mascot script did not define WingMascot in time")),
      MASCOT_TIMEOUT_MS,
    );

    const existing = document.querySelector<HTMLScriptElement>("script[data-wing-mascot]");
    if (existing) {
      // May already have loaded or errored before we got here; the poll and the
      // deadline cover both of those, the listeners just make it quicker.
      existing.addEventListener("load", () => {
        if (window.WingMascot) finish();
        else finish(new Error("mascot script loaded without defining WingMascot"));
      });
      existing.addEventListener("error", () => finish(new Error("mascot script failed")));
      return;
    }

    const el = document.createElement("script");
    el.addEventListener("load", () => {
      if (window.WingMascot) finish();
      else finish(new Error("mascot script loaded without defining WingMascot"));
    });
    el.addEventListener("error", () => finish(new Error("mascot script failed")));
    el.src = MASCOT_SRC;
    el.async = true;
    el.dataset.wingMascot = "1";
    document.head.appendChild(el);
  });

  // A failed load should be retryable on the next mount rather than cached forever.
  p.catch(() => {
    scriptPromise = null;
  });
  scriptPromise = p;
  return p;
}

function partOfDayFromClock(): "morning" | "afternoon" | "evening" {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

// The chat panel is owned elsewhere and positions itself fixed. Rather than
// guess how much of the window it takes, measure what it leaves and fit the
// hero into exactly that, dropping the optional lines before the orb shrinks
// to nothing.
type Layout = { orb: number; showOrb: boolean; showDate: boolean; showChips: boolean; heroH: number };

// The mascot is mounted once at this size and then CSS-scaled to fit. Scaling
// beats remounting: a remount restarts the intro and drops the current mood.
const ORB_BASE = 200;

// Fixed geometry of the hero itself. Everything else is measured off the real
// DOM, because guessed row heights are exactly what clipped the orb before:
// two chips are ~95px tall, not the 62 a constant claimed.
const PAD = 22; // hero padding, top and bottom
const HERO_GAP = 8; // the hero's flex gap
const FLOOR = 18; // reflection height; its -8 margin cancels the gap above it

// Fallbacks used only for the very first frame, before anything has been
// measured. They are deliberately generous: over-reserving shrinks the orb a
// little, under-reserving used to push it off the top of the window.
const FALLBACK_DATE = 20;
const FALLBACK_CHIPS = 96;

type RowHeights = { date: number; chips: number };

type PlanInput = {
  w: number;
  room: number;
  bodyFull: number; // measured body height with every available row present
  dateCost: number; // 0 when there is no date line to show
  chipsCost: number; // 0 when there are no chips to show
};

// Space is spent in a fixed order of importance: the trouble strip and the
// greeting first (a fix Jack cannot see is worthless), then the orb, and only
// then the optional date and status chips. The orb is the centrepiece, so the
// optional rows are only allowed to appear while a substantial orb still fits.
function planLayout({ w, room, bodyFull, dateCost, chipsCost }: PlanInput): Layout {
  const orbMax = Math.min(ORB_BASE, w * 0.46);
  const spaceFor = (withDate: boolean, withChips: boolean) =>
    room -
    PAD -
    HERO_GAP -
    (bodyFull - (withDate ? 0 : dateCost) - (withChips ? 0 : chipsCost)) -
    FLOOR;

  // What gets sacrificed first, and this order is the whole judgement call:
  // the date line is decoration, the status chips are business facts. So the
  // orb gives up size before the chips give up their place. A 120px Nimbus
  // still reads as Nimbus; a window that hides "6 things need attention" to
  // keep the orb big is a poster, not a tool.
  let showDate = true;
  let showChips = true;
  let forOrb = spaceFor(true, true);
  if (forOrb < 132) {
    showDate = false;
    forOrb = spaceFor(false, true);
  }
  if (forOrb < 96) {
    showChips = false;
    forOrb = spaceFor(false, false);
  }

  // Below this the orb is a bullet point rather than a mascot, so at that
  // point it steps aside instead of shrinking into a smudge.
  const showOrb = forOrb >= 56;
  const orb = Math.round(Math.max(56, Math.min(orbMax, forOrb)));
  return { orb, showOrb, showDate, showChips, heroH: room };
}

function FallbackOrb({ size }: { size: number }) {
  return (
    <svg
      className="nimbus-fallback"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="Nimbus"
    >
      <defs>
        <radialGradient id="nimbus-fb-body" cx="38%" cy="32%" r="72%">
          <stop offset="0%" stopColor="#7fa4ff" />
          <stop offset="55%" stopColor="#3d6bf0" />
          <stop offset="100%" stopColor="#1b2b63" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="34" fill="url(#nimbus-fb-body)" />
      <circle cx="50" cy="50" r="34" fill="none" stroke="rgba(160,190,255,0.35)" strokeWidth="1" />
      <ellipse cx="40" cy="45" rx="4.5" ry="6" fill="#eaf1ff" />
      <ellipse cx="60" cy="45" rx="4.5" ry="6" fill="#eaf1ff" />
    </svg>
  );
}

// A money line arrives as a statement plus its qualifier. The qualifier is the
// half that must never be hidden, so it is split onto its own wrapped line
// instead of being cut off by an ellipsis. Nothing is reworded or recomputed.
function splitCaveat(text: string): { head: string; caveat: string | null } {
  const m = text.match(/^([\s\S]*?[.!?])\s+([\s\S]+)$/);
  const head = m ? m[1] : text;
  const caveat = m ? m[2] : null;
  // The statement's supporting detail is allowed to be shortened; the
  // qualifier is not. Parenthetical detail is dropped from the statement only,
  // and nothing is reworded, so the figure and its basis still read as the API
  // wrote them.
  const shortHead = head.replace(/\s*\([^()]*\)/g, "").replace(/\s{2,}/g, " ").trim();
  return { head: shortHead.length >= 12 ? shortHead : head, caveat };
}

export default function NimbusStage() {
  const slotRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLParagraphElement>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  const troublesRef = useRef<HTMLDivElement>(null);
  const mascotRef = useRef<MascotHandle | null>(null);
  const rowH = useRef<RowHeights>({ date: FALLBACK_DATE, chips: FALLBACK_CHIPS });
  const [layout, setLayout] = useState<Layout>({
    orb: 160,
    showOrb: true,
    showDate: true,
    showChips: true,
    heroH: 320,
  });
  const [mascotFailed, setMascotFailed] = useState(false);
  const [glance, setGlance] = useState<Glance | null>(null);
  const [glanceFailed, setGlanceFailed] = useState(false);
  // Null until the client clock is read: better a blank frame than a greeting
  // that says morning at nine at night.
  const [partOfDay, setPartOfDay] = useState<"morning" | "afternoon" | "evening" | null>(null);

  const day = glance?.greeting?.partOfDay ?? partOfDay;
  const dateLine = glance?.greeting?.dateLine ?? null;
  const nextRun = glance?.nextAgentRun ?? null;
  const nextRunText =
    nextRun && nextRun.agent && nextRun.when ? `Next: ${nextRun.agent} ${nextRun.when}` : null;
  const hasDateRow = Boolean(dateLine || nextRunText);

  const problems = glance?.watch?.problems;
  const mood: Mood = typeof problems === "number" && problems > 0 ? "alert" : "calm";

  const chips: { key: string; text: string; tone: "normal" | "alert" | "muted"; ask?: string }[] = [];
  const watchHeadline = glance?.watch?.headline;
  if (watchHeadline) {
    chips.push({
      key: "watch",
      text: watchHeadline,
      tone: typeof problems === "number" && problems > 0 ? "alert" : "normal",
      ask: "What is broken right now, and how do I fix each one?",
    });
  }
  const mrrLine = glance?.mrr?.line;
  if (mrrLine)
    chips.push({
      key: "mrr",
      text: mrrLine,
      tone: "normal",
      ask: "Break down MRR: who is paying, on what basis, and what ends soonest?",
    });
  const hasChips = chips.length > 0;

  // Every row is measured off the real DOM. Optional rows that are currently
  // hidden are remembered from the last time they were on screen, so dropping
  // one never makes the plan forget what putting it back would cost.
  const measure = useCallback(() => {
    const panel = document.querySelector<HTMLElement>(".jarvis-panel");
    const roomTop = panel ? panel.getBoundingClientRect().top : window.innerHeight * 0.44;
    const room = Math.max(96, Math.min(window.innerHeight, roomTop));

    if (dateRef.current) rowH.current.date = dateRef.current.offsetHeight + HERO_GAP;
    if (chipsRef.current) rowH.current.chips = chipsRef.current.offsetHeight + HERO_GAP;

    const bodyH = bodyRef.current ? bodyRef.current.offsetHeight : 0;
    const dateCost = hasDateRow ? rowH.current.date : 0;
    const chipsCost = hasChips ? rowH.current.chips : 0;
    // Normalise the measured body to "everything shown", so the plan compares
    // like with like no matter which rows happen to be rendered right now.
    const bodyFull =
      bodyH + (dateRef.current ? 0 : dateCost) + (chipsRef.current ? 0 : chipsCost);

    setPartOfDay(partOfDayFromClock());
    const plan = planLayout({ w: window.innerWidth, room, bodyFull, dateCost, chipsCost });

    // The plan works from row costs measured a render ago. When a row grows
    // between the measurement and the paint (a trouble line appearing, a chip
    // rewrapping), the hero can end up taller than the room it was given and
    // push into the chat card. The DOM is the authority here, so take the real
    // overflow straight out of the orb rather than trusting the arithmetic.
    const hero = heroRef.current;
    if (hero) {
      const over = hero.scrollHeight - room;
      if (over > 1) plan.orb = Math.max(56, plan.orb - Math.ceil(over));
    }
    setLayout(plan);
  }, [hasDateRow, hasChips]);

  // Clock work happens after mount so the server and client markup agree.
  // Everything below is scheduled on timers rather than animation frames: a
  // hidden or backgrounded window never paints, so a first measurement that
  // waits for a frame never happens and the stage is left sized by its initial
  // guess, which is how the orb ended up above the top edge.
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    let bodyRo: ResizeObserver | null = null;
    let retry = 0;
    let tries = 0;
    const timers: number[] = [];

    // The panel animates to its new height, so a single reading taken the
    // moment it starts moving describes a size it is about to leave. Measure
    // again while it settles; the plan is cheap and idempotent.
    const settle = () => {
      measure();
      timers.forEach(clearTimeout);
      timers.length = 0;
      // The panel slides in by changing its position, which a size-only
      // ResizeObserver never sees, so the tail of this chain is what catches
      // the end of that slide. Timers, not frames: a hidden window paints none.
      [120, 320, 700, 1200, 2000, 3200].forEach((ms) => {
        timers.push(window.setTimeout(measure, ms));
      });
    };

    // Content height changes (a trouble appearing, chip text rewrapping) must
    // re-plan even when no frame is being painted, so the body is observed
    // directly rather than trusting a requestAnimationFrame that a hidden
    // window will never run.
    if (bodyRef.current) {
      bodyRo = new ResizeObserver(() => measure());
      bodyRo.observe(bodyRef.current);
    }

    const attach = () => {
      const panel = document.querySelector<HTMLElement>(".jarvis-panel");
      if (panel) {
        ro = new ResizeObserver(settle);
        ro.observe(panel);
      } else if (tries < 120) {
        // The panel mounts from the root layout and may land after this stage.
        tries += 1;
        retry = window.setTimeout(attach, 16);
        return;
      }
      settle();
    };
    // Measure on the next tick rather than the next frame. The panel may not
    // exist yet; the fallback room is close and `attach` corrects it.
    timers.push(window.setTimeout(measure, 0));
    retry = window.setTimeout(attach, 0);
    window.addEventListener("resize", settle);
    // A window that was hidden mid animation comes back to a plan made against
    // a size the panel has since left.
    document.addEventListener("visibilitychange", settle);
    return () => {
      clearTimeout(retry);
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", settle);
      document.removeEventListener("visibilitychange", settle);
      if (ro) ro.disconnect();
      if (bodyRo) bodyRo.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    const ctl = new AbortController();
    fetch("/api/nimbus/glance", { signal: ctl.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: Glance) => setGlance(data && data.ok ? data : null))
      .catch(() => {
        if (!ctl.signal.aborted) setGlanceFailed(true);
      });
    return () => ctl.abort();
  }, []);

  // Mount once, at whatever size the window was on load. Resizing the frameless
  // window mid session is rare, and remounting the orb would restart its intro.
  useEffect(() => {
    let cancelled = false;
    if (!slotRef.current) return;

    const fail = () => {
      if (!cancelled) setMascotFailed(true);
    };

    loadMascot()
      .then(() => {
        if (cancelled) return;
        // Every way of not getting a real orb has to end at the fallback, so
        // there is no path here that quietly returns and leaves a blank band.
        if (!window.WingMascot || !slotRef.current) {
          fail();
          return;
        }
        slotRef.current.innerHTML = "";
        try {
          mascotRef.current = window.WingMascot.mount(slotRef.current, {
            size: ORB_BASE,
            intro: true,
            // Hero is the large-display presentation. The mascot ignores it under
            // 140px and under reduced motion, so this is safe to always ask for.
            hero: true,
          });
        } catch {
          mascotRef.current = null;
        }
        if (!mascotRef.current) fail();
      })
      .catch(fail);
    return () => {
      cancelled = true;
      if (mascotRef.current) {
        mascotRef.current.destroy();
        mascotRef.current = null;
      }
    };
  }, []);

  // Mood follows the watch only. Nothing here animates on a timer.
  useEffect(() => {
    if (mascotRef.current) mascotRef.current.setState(mood);
  }, [mood, glance, mascotFailed]);

  // Trouble is reported as what broke plus what to do about it. Never a symptom
  // on its own: this window is often the first thing Jack sees in the morning.
  const troubles: { key: string; what: string; fix: string; ask: string }[] = [];
  if (glanceFailed) {
    troubles.push({
      key: "glance",
      // This page was served by the OS, so the OS is running. Saying otherwise
      // sends Jack to restart something that is fine.
      what: "The status check did not answer.",
      fix: "Tap and I will run the checks here and report the real error.",
      ask: "The status check did not answer in my window. Run the checks here and tell me the real error and how to fix it.",
    });
  }
  // Two different failures, both of which have to be said out loud.
  //   couldNotCheck  the glance route could not read a whole source
  //   watch.unknowns a check inside the watch could not run
  // They are concatenated, never coalesced: an empty couldNotCheck array is not
  // a reason to stay silent about an unknown the watch reported.
  const routeCouldNot = glance?.couldNotCheck ?? [];
  const watchUnknowns = glance?.watch?.unknowns ?? [];
  if (!glanceFailed && routeCouldNot.length > 0) {
    troubles.push({
      key: "partial",
      what: `Could not check: ${routeCouldNot.join(" ")}`,
      fix: "Tap and I will run the full check here and report the real error.",
      ask: "Some status sources could not be read. Run the full check and tell me what failed and how to fix it.",
    });
  }
  if (!glanceFailed && watchUnknowns.length > 0) {
    // Say which check and why. The headline already told Jack the count, so
    // repeating the count without the name is the useless half.
    const first = watchUnknowns[0];
    const more = watchUnknowns.length > 1 ? ` (and ${watchUnknowns.length - 1} more)` : "";
    troubles.push({
      key: "watch-unknown",
      what: `${first.label || "One check"} could not run${more}.`,
      fix: `${first.reason || "No reason given."} Tap for the full report.`,
      ask: "Which checks could not run, why, and what should I do about each one?",
    });
  }
  if (mascotFailed) {
    troubles.push({
      key: "mascot",
      what: "My artwork did not load, so this is the plain version of me.",
      fix: "Reload with Ctrl+R, or tap and I will check what is wrong.",
      ask: "The mascot script did not load in my window. Check whether /mascot/wing-mascot.js is being served and tell me how to fix it.",
    });
  }

  // A trouble appearing (or its text rewrapping) changes how much room the rest
  // of the stage has, so re-plan whenever the set of troubles changes.
  const troubleKey = troubles.map((t) => t.key).join(",");
  const showDate = hasDateRow && layout.showDate;
  const showChips = hasChips && layout.showChips;
  useEffect(() => {
    // After the rows are laid out, so their real heights can be read. A timer
    // rather than an animation frame, so a hidden window still re-plans.
    const t = window.setTimeout(measure, 0);
    return () => clearTimeout(t);
  }, [measure, troubleKey, showDate, showChips, watchHeadline, mrrLine, dateLine, nextRunText, day]);

  return (
    <div className="nimbus-stage" data-mood={mood}>
      <div className="nimbus-stage-layer nimbus-aurora" />
      <div className="nimbus-stage-layer nimbus-stars-far" />
      <div className="nimbus-stage-layer nimbus-stars" />
      <div className="nimbus-stage-layer nimbus-vignette" />

      <div className="nimbus-content">
        <div className="nimbus-hero" ref={heroRef} style={{ height: layout.heroH }}>
          {/* The mount is never unmounted, only hidden: destroying it would
              restart the intro and lose the current mood. */}
          <div
            className="nimbus-orb-wrap"
            style={{
              width: layout.orb,
              height: layout.orb,
              display: layout.showOrb ? undefined : "none",
            }}
          >
            <span className="nimbus-orb-halo" />
            <div
              ref={slotRef}
              className="nimbus-orb-slot"
              aria-hidden={mascotFailed}
              style={{
                width: ORB_BASE,
                height: ORB_BASE,
                transform: `translate(-50%, -50%) scale(${layout.orb / ORB_BASE})`,
              }}
            />
            {mascotFailed ? <FallbackOrb size={layout.orb} /> : null}
          </div>
          {layout.showOrb ? (
            <div className="nimbus-reflection" style={{ width: Math.round(layout.orb * 0.78) }} />
          ) : null}
          <div className="nimbus-hero-body" ref={bodyRef}>
            {day ? (
              <h1 className="nimbus-greeting">Good {day}, Jack</h1>
            ) : (
              <h1 className="nimbus-greeting">&nbsp;</h1>
            )}
            {showDate ? (
              <p className="nimbus-dateline" ref={dateRef}>
                {dateLine}
                {dateLine && nextRunText ? <span className="nimbus-dot-sep"> &middot; </span> : null}
                {nextRunText ? <span className="nimbus-nextrun">{nextRunText}</span> : null}
              </p>
            ) : null}
            {troubles.length > 0 ? (
              <div className="nimbus-troubles" ref={troublesRef} role="status">
                {troubles.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    className="nimbus-trouble"
                    title={t.what + " " + t.fix}
                    onClick={() => window.dispatchEvent(new CustomEvent("jarvis:ask", { detail: t.ask }))}
                  >
                    <span className="nimbus-trouble-what">{t.what}</span>
                    <span className="nimbus-trouble-fix">{t.fix}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {showChips ? (
              <div className="nimbus-chips" ref={chipsRef}>
                {chips.slice(0, 2).map((c) => {
                  const cls =
                    "nimbus-chip" +
                    (c.tone === "alert" ? " nimbus-chip-alert" : "") +
                    (c.tone === "muted" ? " nimbus-chip-muted" : "") +
                    (c.ask ? " nimbus-chip-ask" : "");
                  const { head, caveat } = splitCaveat(c.text);
                  const inner = (
                    <>
                      <span className="nimbus-chip-dot" />
                      <span className="nimbus-chip-body">
                        <span className="nimbus-chip-text">{head}</span>
                        {caveat ? <span className="nimbus-chip-caveat">{caveat}</span> : null}
                      </span>
                    </>
                  );
                  return c.ask ? (
                    <button
                      key={c.key}
                      type="button"
                      className={cls}
                      onClick={() => window.dispatchEvent(new CustomEvent("jarvis:ask", { detail: c.ask }))}
                    >
                      {inner}
                    </button>
                  ) : (
                    <span key={c.key} className={cls}>
                      {inner}
                    </span>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
