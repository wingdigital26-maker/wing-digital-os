"use client";
// ── Shared Motion variants + transitions for Wing Digital OS ─────────────────
// Reused across the dashboard so entrance staggers and hover springs stay
// consistent. Reduced-motion is honored globally via <MotionConfig
// reducedMotion="user"> at the app root, which makes these transforms instant.
import type { Variants, Transition } from "motion/react";

// Parent container that staggers its motion children in on mount.
export const staggerContainer: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
};

// Child item: fade + rise into place with a soft spring.
export const riseItem: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 26 } },
};

// Spring used for interactive hover/tap feedback.
export const hoverSpring: Transition = { type: "spring", stiffness: 400, damping: 26 };

// Subtle lift on hover for clickable cards / pills.
export const cardHover = { scale: 1.02, y: -2 };
export const cardTap = { scale: 0.98 };
