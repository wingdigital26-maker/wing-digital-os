"use client";
// ── Shared Motion variants + transitions for Wing Digital OS ─────────────────
// Reused across the dashboard so entrance staggers and hover springs stay
// consistent. Reduced-motion is honored globally via <MotionConfig
// reducedMotion="user"> at the app root, which makes these transforms instant.
import type { Variants, Transition } from "motion/react";

// Parent container that staggers its motion children in on mount.
//
// The stagger used to be 0.05s per child with a 12px opacity fade. On a dense
// dashboard that meant a visible wave of half-transparent cards on every load
// AND on every view switch, which read as the whole UI "fading" rather than as
// polish. The entrance is now near-instant: a short slide with no opacity ramp,
// so content is legible from the first frame.
export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.012, delayChildren: 0 } },
};

// Child item: a small rise into place. Deliberately NO opacity animation —
// text should never be rendered semi-transparent on the way in.
export const riseItem: Variants = {
  hidden: { y: 6 },
  show: { y: 0, transition: { type: "spring", stiffness: 420, damping: 34, mass: 0.6 } },
};

// Spring used for interactive hover/tap feedback.
export const hoverSpring: Transition = { type: "spring", stiffness: 400, damping: 26 };

// Subtle lift on hover for clickable cards / pills.
export const cardHover = { scale: 1.02, y: -2 };
export const cardTap = { scale: 0.98 };

// Cards that are NOT clickable still need to feel alive. Previously only tiles
// with an onClick or href moved, so in a row of identical-looking stat tiles
// "Opened emails" lifted and "MRR" sat dead — the row read as half-broken.
// This is a smaller lift with no scale, so a real affordance still reads as
// stronger than a passive one and hover never promises a click that is not there.
export const cardHoverPassive = { y: -1 };
