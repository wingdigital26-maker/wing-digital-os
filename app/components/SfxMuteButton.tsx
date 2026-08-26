"use client";

// Small speaker icon that toggles the UI sound effects on and off.
// State lives in the sfx engine and persists via localStorage.

import { useEffect, useState } from "react";
import { sfx } from "../lib/sounds";

export default function SfxMuteButton() {
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    setMuted(sfx.isMuted());
    return sfx.subscribe(setMuted);
  }, []);

  return (
    <button
      onClick={() => {
        const nowMuted = sfx.toggle();
        if (!nowMuted) sfx.play("toggle-on");
      }}
      title={muted ? "UI sounds off. Click to unmute" : "UI sounds on. Click to mute"}
      aria-label={muted ? "Unmute UI sounds" : "Mute UI sounds"}
      data-sfx-mute
      style={{
        width: 30,
        height: 30,
        borderRadius: 8,
        border: "1px solid var(--border, var(--border))",
        background: "transparent",
        color: muted ? "var(--text-muted, #6b7280)" : "var(--accent, #22d3ee)",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {muted ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <line x1="23" y1="9" x2="17" y2="15" />
          <line x1="17" y1="9" x2="23" y2="15" />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
    </button>
  );
}
