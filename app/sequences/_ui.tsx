"use client";
import type React from "react";
import "./skeleton.css";

// Shared loading skeletons for the Sequences surfaces. Each skeleton mirrors
// the real row layout so the page does not jump when data lands, and every
// colour comes from a theme token. A visually-hidden "Loading" keeps the
// state announced to screen readers.

const skelCard: React.CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
};

const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

function Bar({ w, h = 12 }: { w: number | string; h?: number }) {
  return <div className="wing-skel-bar" style={{ width: w, height: h }} />;
}

// The /sequences list: name + summary line on the left, pill and two buttons
// on the right.
export function SequenceListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" style={{ display: "grid", gap: 10 }}>
      <span style={srOnly}>Loading sequences…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ ...skelCard, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 260px", display: "grid", gap: 8 }}>
            <Bar w="44%" h={14} />
            <Bar w="72%" h={11} />
          </div>
          <Bar w={64} h={22} />
          <Bar w={74} h={30} />
          <Bar w={52} h={30} />
        </div>
      ))}
    </div>
  );
}

// The /sequences/people list: person + sub-line on the left, a state sentence,
// a pill and small action buttons on the right.
export function PeopleListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-busy="true" style={{ display: "grid", gap: 8 }}>
      <span style={srOnly}>Loading people…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ ...skelCard, padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 240px", display: "grid", gap: 7 }}>
            <Bar w="40%" h={13} />
            <Bar w="66%" h={11} />
          </div>
          <div style={{ flex: "1 1 220px", display: "grid", gap: 6 }}>
            <Bar w="82%" h={11} />
          </div>
          <Bar w={92} h={22} />
          <Bar w={54} h={26} />
          <Bar w={62} h={26} />
        </div>
      ))}
    </div>
  );
}
