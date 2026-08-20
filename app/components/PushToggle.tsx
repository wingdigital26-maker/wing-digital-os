"use client";

// Enable/disable watchdog push notifications on this device. Subscribes the
// service worker to web push and stores the subscription server-side. Shows a
// bell state: off (gray), on (accent), blocked (red, needs browser settings).

import { useCallback, useEffect, useState } from "react";

type PushState = "unsupported" | "off" | "on" | "blocked" | "busy";

function b64ToUint8(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function PushToggle() {
  const [state, setState] = useState<PushState>("busy");

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setState("unsupported");
      if (Notification.permission === "denied") return setState("blocked");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  const toggle = useCallback(async () => {
    if (state === "unsupported" || state === "busy") return;
    if (state === "blocked") {
      alert("Notifications are blocked for this site. Enable them in your browser/site settings, then try again.");
      return;
    }
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        });
        await existing.unsubscribe();
        setState("off");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setState(perm === "denied" ? "blocked" : "off");
      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapid) return setState("unsupported");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToUint8(vapid),
      });
      const r = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!r.ok) throw new Error("subscribe save failed");
      setState("on");
      // Confirm end-to-end with a real push through the server.
      fetch("/api/push/test", { method: "POST" }).catch(() => {});
    } catch {
      setState("off");
    }
  }, [state]);

  if (state === "unsupported") return null;
  const color = state === "on" ? "var(--accent)" : state === "blocked" ? "var(--red)" : "var(--text-muted)";
  const label = state === "on" ? "ALERTS ON" : state === "blocked" ? "ALERTS BLOCKED" : state === "busy" ? "..." : "ALERTS OFF";
  return (
    <button
      onClick={toggle}
      title="Push notifications when an agent breaks or the PC goes down"
      style={{
        display: "flex", alignItems: "center", gap: 6, background: "transparent",
        border: `1px solid ${color}`, borderRadius: 999, padding: "4px 10px",
        color, fontSize: 10, letterSpacing: "0.12em", cursor: "pointer",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span style={{ fontSize: 12 }}>{state === "on" ? "🔔" : "🔕"}</span>
      {label}
    </button>
  );
}
